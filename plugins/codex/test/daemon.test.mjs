import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, access, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createConnection } from 'node:net';
import { fileURLToPath } from 'node:url';

const execute=promisify(execFile);
const root=fileURLToPath(new URL('..',import.meta.url));
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function request(socketPath,message){return new Promise((resolveRequest,reject)=>{
  const socket=createConnection(socketPath);let buffer='';
  const timer=setTimeout(()=>{socket.destroy();reject(new Error('Test bridge deadline'));},15000);
  socket.setEncoding('utf8');socket.on('connect',()=>socket.write(JSON.stringify(message)+'\n'));
  socket.on('data',chunk=>{buffer+=chunk;if(buffer.includes('\n')){clearTimeout(timer);socket.destroy();resolveRequest(JSON.parse(buffer));}});
  socket.on('error',error=>{clearTimeout(timer);reject(error);});
});}
test('production bridge rebuilds a retired owned host and confirms session teardown without model inference',{timeout:30000},async t=>{
  try{await access('/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex');}catch{t.skip('requires bundled native Codex');return;}
  const fixture=await mkdtemp(join(tmpdir(),'perseus-daemon-test-'));await mkdir(join(fixture,'workspace'));
  const session=randomUUID();const key=createHash('sha256').update(session).digest('hex').slice(0,24);
  const socketPath=join(tmpdir(),'perseus-codex-'+process.getuid(),key+'.sock');
  const event={session_id:session,cwd:join(fixture,'workspace'),hook_event_name:'PreToolUse',model:'gpt-6-sol'};
  let controllerPid;
  try{
    // Hook stdin is provided through an owned child process, without a shell.
    const {spawn}=await import('node:child_process');
    const child=spawn(process.execPath,[join(root,'scripts/hook.mjs')],{env:{...process.env,PLUGIN_ROOT:root,PLUGIN_DATA:join(fixture,'data')},stdio:['pipe','pipe','pipe']});
    child.stdin.end(JSON.stringify(event));
    await new Promise((resolveExit,reject)=>{child.once('error',reject);child.once('exit',code=>code===0?resolveExit():reject(new Error('Hook failed')));});
    const first=await request(socketPath,{op:'status'});controllerPid=first.bridge.pid;
    assert.equal(first.bridge.hostState,'ready');assert.equal(first.workers,0);assert.equal(first.acquisitions,0);
    process.kill(-first.bridge.hostPid,'SIGKILL');
    for(let i=0;i<100;i++){if((await request(socketPath,{op:'status'})).bridge.hostState==='closed')break;await pause(10);}
    const replay=await request(socketPath,{op:'event',event});assert.equal(replay.error,undefined);
    const next=await request(socketPath,{op:'status'});
    assert.equal(next.bridge.hostState,'ready');assert.notEqual(next.bridge.hostPid,first.bridge.hostPid);assert.equal(next.workers,0);
    const closed=await request(socketPath,{op:'close',reason:'SessionEnd'});
    assert.equal(closed.status.closed,true);assert.equal(closed.status.pendingWorkers,0);assert.equal(closed.status.pendingAcquisitions,0);
    for(let i=0;i<100;i++){try{process.kill(controllerPid,0);}catch{controllerPid=undefined;break;}await pause(10);}
    assert.equal(controllerPid,undefined,'owned bridge exited after flushing SessionEnd acknowledgement');
  }finally{
    if(controllerPid)process.kill(controllerPid,'SIGTERM');
    await rm(fixture,{recursive:true,force:true});
  }
});

test('production hooks accept a non-Sol Actor and model changes without starting paid inference',{timeout:30000},async t=>{
  try{await access('/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex');}catch{t.skip('requires bundled native Codex');return;}
  const fixture=await mkdtemp(join(tmpdir(),'perseus-actor-session-test-'));
  const workspace=join(fixture,'workspace');await mkdir(workspace);
  const session=randomUUID(),key=createHash('sha256').update(session).digest('hex').slice(0,24);
  const socketPath=join(tmpdir(),'perseus-codex-'+process.getuid(),key+'.sock');
  let controllerPid;
  try{
    const {spawn}=await import('node:child_process');
    const event={session_id:session,cwd:workspace,hook_event_name:'PreToolUse',model:'gpt-6.1-sol'};
    const child=spawn(process.execPath,[join(root,'scripts/hook.mjs')],{env:{...process.env,PLUGIN_ROOT:root,PLUGIN_DATA:join(fixture,'data')},stdio:['pipe','pipe','pipe']});
    let stdout='';child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{stdout+=chunk;});
    child.stdin.end(JSON.stringify(event));
    await new Promise((resolveExit,reject)=>{child.once('error',reject);child.once('exit',code=>code===0?resolveExit():reject(new Error('Hook failed')));});
    assert.equal(stdout,'','hook does not require the user to switch Actor models');
    const first=await request(socketPath,{op:'status'});controllerPid=first.bridge.pid;
    assert.equal(first.bridge.hostState,'ready');assert.deepEqual(first.actor,{model:'gpt-6.1-sol'});
    assert.equal(first.workers,0);assert.equal(first.acquisitions,0);assert.equal(first.facts,0);
    assert.equal(first.waves,0);assert.equal(first.revision,0,'PreToolUse without authoritative progress cannot start inference');
    const changed=await request(socketPath,{op:'event',event:{...event,model:'custom-session-model'}});
    assert.equal(changed.disabled,undefined);assert.equal(changed.error,undefined);
    assert.deepEqual(changed.status.actor,{model:'custom-session-model'});
    assert.equal(changed.status.workers,0);assert.equal(changed.status.waves,0);
    const persisted=JSON.parse(await readFile(join(fixture,'data',key,'status.json'),'utf8'));
    assert.deepEqual(persisted.actor,{model:'custom-session-model'});assert.equal(persisted.actor.effort,undefined,'unknown Actor effort is not invented');
    const closed=await request(socketPath,{op:'close',reason:'SessionEnd'});
    assert.equal(closed.status.closed,true);assert.equal(closed.status.pendingWorkers,0);assert.equal(closed.status.pendingAcquisitions,0);
    for(let i=0;i<100;i++){try{process.kill(controllerPid,0);}catch{controllerPid=undefined;break;}await pause(10);}
    assert.equal(controllerPid,undefined);
  }finally{
    if(controllerPid)process.kill(controllerPid,'SIGTERM');
    await rm(fixture,{recursive:true,force:true});
  }
});

test('the native launcher forwards user arguments without adding Actor model or effort settings',async t=>{
  const fixture=await mkdtemp(join(tmpdir(),'perseus-launcher-test-'));t.after(()=>rm(fixture,{recursive:true,force:true}));
  const binary=join(fixture,'codex'),capture=join(fixture,'args.json');
  await writeFile(binary,`#!${process.execPath}\nimport{writeFileSync}from'node:fs';\nif(process.argv[2]==='--version')console.log('codex-cli launcher-fixture');else writeFileSync(process.env.PERSEUS_TEST_CAPTURE,JSON.stringify(process.argv.slice(2)));\n`,{mode:0o755});
  const env={...process.env,PERSEUS_CODEX_BIN:binary,PERSEUS_TEST_CAPTURE:capture};
  for(const args of [[],['--help'],['--model','custom-actor','-c','model_reasoning_effort="low"','--no-alt-screen']]){
    await execute(process.execPath,[join(root,'scripts/run.mjs'),...args],{env});
    assert.deepEqual(JSON.parse(await readFile(capture,'utf8')),args);
  }
});
