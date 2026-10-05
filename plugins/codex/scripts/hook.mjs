import { createConnection } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdir, chmod, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

let input='';for await(const chunk of process.stdin)input+=chunk;
let event;try{event=JSON.parse(input);}catch{process.exit(0);}
if(typeof event.session_id!=='string'||typeof event.cwd!=='string'||typeof event.hook_event_name!=='string')process.exit(0);
const pluginRoot=resolve(process.env.PLUGIN_ROOT??dirname(dirname(fileURLToPath(import.meta.url))));
const dataBase=resolve(process.env.PLUGIN_DATA??join(tmpdir(),'perseus-codex-data-'+process.getuid()));
const key=createHash('sha256').update(event.session_id).digest('hex').slice(0,24);
const dataRoot=join(dataBase,key);
const socketRoot=join(tmpdir(),'perseus-codex-'+process.getuid());
await mkdir(socketRoot,{recursive:true,mode:0o700});await chmod(socketRoot,0o700);
const socketPath=join(socketRoot,key+'.sock');
function request(message,timeout=2500){return new Promise((resolve,reject)=>{
  const socket=createConnection(socketPath);socket.setEncoding('utf8');let buffer='';
  const timer=setTimeout(()=>{socket.destroy();reject(new Error('bridge timeout'));},timeout);
  socket.on('connect',()=>socket.write(JSON.stringify(message)+'\n'));
  socket.on('data',chunk=>{buffer+=chunk;if(buffer.includes('\n')){clearTimeout(timer);socket.destroy();try{resolve(JSON.parse(buffer));}catch(error){reject(error);}}});
  socket.on('error',error=>{clearTimeout(timer);reject(error);});
});}
async function ensure(){
  try{await request({op:'status'});return;}catch{}
  await mkdir(dataRoot,{recursive:true,mode:0o700});const lock=join(dataRoot,'launch.lock');let owner=false;
  try{await mkdir(lock);owner=true;}catch(error){
    if(error.code!=='EEXIST')throw error;
    let stale=false;
    try{const record=JSON.parse(await readFile(join(lock,'owner.json'),'utf8'));try{process.kill(record.pid,0);}catch(error){stale=error.code==='ESRCH';}}
    catch{stale=Date.now()-(await stat(lock)).mtimeMs>5000;}
    if(stale){await rm(lock,{recursive:true,force:true});try{await mkdir(lock);owner=true;}catch(error){if(error.code!=='EEXIST')throw error;}}
  }
  if(owner){
    try{
      await writeFile(join(lock,'owner.json'),JSON.stringify({pid:process.pid}),{mode:0o600});
      // A stale socket may be removed only after its recorded owner is gone.
      let live=false;
      try{const record=JSON.parse(await readFile(join(dataRoot,'process.json'),'utf8'));process.kill(record.pid,0);live=true;}catch{}
      if(!live){await rm(socketPath,{force:true});
        const child=spawn(process.execPath,[join(pluginRoot,'scripts/daemon.mjs'),socketPath,dataRoot,event.cwd],{detached:true,stdio:'ignore',env:process.env});child.unref();}
    }finally{await rm(lock,{recursive:true,force:true});}
  }
  for(let i=0;i<40;i++){try{await request({op:'status'});return;}catch{await new Promise(resolve=>setTimeout(resolve,50));}}
  throw new Error('bridge unavailable');
}
try{
  const name=event.hook_event_name;
  if(['Stop','Interrupt','SessionEnd'].includes(name)){
    try{await request({op:'close',reason:name},name==='Interrupt'?2500:15000);}catch{}
    process.exit(0);
  }
  // SessionStart does not invent a user prompt or start paid inference.
  if(name==='SessionStart'&&event.source!=='compact')process.exit(0);
  await ensure();
  const result=await request({op:'event',event},10000);
  let context=result.context;
  if(!context&&['UserPromptSubmit','PostToolUse'].includes(name)){
    const ready=await request({op:'watch'},105000);context=ready.context;
  }
  if(context)process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:name,additionalContext:context}}));
}catch{
  // Advisory extension fails open for Actor; no tool is rewritten or approved.
  process.stdout.write(JSON.stringify({systemMessage:'Perseus bridge failed; native Actor continues. Check plugin diagnostics.'}));
}
