import { createServer } from 'node:net';
import { mkdir, chmod, unlink, writeFile, rename, appendFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { RpcClient } from '../src/rpc.mjs';
import { ExecutionManager } from '../src/execution.mjs';
import { WorkerPool } from '../src/worker.mjs';
import { Swarm } from '../src/scheduler.mjs';
import { DEFAULT_CONFIG, WORKER_HOST_CONFIG } from '../src/config.mjs';
import { evidenceContext } from '../src/evidence.mjs';
import { disableInheritedMcp } from '../src/host-policy.mjs';
import { ToolRegistry } from '../src/tool-registry.mjs';

const [socketPath, dataRootArg, sourceRootArg] = process.argv.slice(2);
if (!socketPath || !dataRootArg || !sourceRootArg) throw new Error('daemon requires owned socket/data/workspace paths');
const dataRoot = resolve(dataRootArg); const sourceRoot = resolve(sourceRootArg);
await mkdir(dataRoot, { recursive: true, mode: 0o700 });
let client, pool, executor, swarm, starting, closing;
let actor = {};
let lastEventAt=Date.now();
const log = event => {
  // Lifecycle fields and usage only. No prompt, raw output, errors or credentials.
  const allowed = ['event','domain','ownerId','revision','epoch','model','effort','requestedEffort','capabilitySource','effortAdjusted',
    'promptIdentity','observedUsageIncrements','actions','count','boundary','usage','workerCount'];
  const safe = Object.fromEntries(allowed.filter(key => event[key] !== undefined).map(key => [key,event[key]]));
  void appendFile(join(dataRoot,'diagnostics.jsonl'),JSON.stringify({at:Date.now(),...safe})+'\n',{mode:0o600}).catch(()=>{});
};
function status() {
  return {...(swarm?.status()??{closed:true}),...(actor.model?{actor:{...actor}}:{})};
}
function observeActor(event) {
  // Native hooks report the current Actor model, but not its reasoning effort.
  // This is diagnostic metadata only: never select, constrain, or infer Actor settings.
  if(typeof event?.model==='string' && event.model.length<=200 && !/[\u0000-\u001f\u007f]/.test(event.model)
    && actor.model!==event.model){actor={model:event.model};log({event:'actor_session',model:event.model});}
}
async function persist() {
  if (!swarm) return;
  const tmp = join(dataRoot,'status-'+randomUUID()+'.tmp');
  await writeFile(tmp,JSON.stringify(status(),null,2),{mode:0o600}); await rename(tmp,join(dataRoot,'status.json'));
}
async function start() {
  if (swarm && !swarm.status().closed && client?.state==='ready') return;
  if (starting) return starting;
  starting = (async()=>{
    if (closing) await closing;
    if(swarm && !swarm.status().closed){
      // A worker can retire the shared host after an unconfirmed interrupt.
      // Logical openness alone must not keep reusing that dead transport.
      await swarm.close('inference-host-retired');
      try{await executor?.settleClose();}finally{await client?.close();}
    }
    const inferenceCwd=join(dataRoot,'model-room');
    await mkdir(inferenceCwd,{recursive:true,mode:0o700});
    const mcpPolicy=await disableInheritedMcp({cwd:inferenceCwd,configOverrides:WORKER_HOST_CONFIG});
    client = await RpcClient.create({cwd:inferenceCwd,experimentalApi:true,configOverrides:{...WORKER_HOST_CONFIG,...mcpPolicy}});
    pool = new WorkerPool({client,dataRoot,emit:log});
    executor = new ExecutionManager({client,sourceRoot,tempRoot:join(dataRoot,'acquisitions')});
    const registry = new ToolRegistry({ canExecute: tool => executor.canExecute(tool) });
    swarm = new Swarm({registry, generate:(...args)=>pool.generate(...args), acquire:(...args)=>executor.acquire(...args), emit:log});
    await persist();
  })().finally(()=>{starting=undefined;});
  return starting;
}
async function close(reason) {
  if (closing) return closing;
  closing=(async()=>{
    const failures=[];
    // Always retire the owned host, including when a port cannot confirm its
    // cleanup. Preserve those failures instead of claiming quiescence.
    try { if (starting) await starting; } catch(error) { failures.push(error); }
    try { if (swarm) await swarm.close(reason); } catch(error) { failures.push(error); }
    try { if (executor) await executor.settleClose(); } catch(error) { failures.push(error); }
    try { if (client) await client.close(); } catch(error) { failures.push(error); }
    await persist();
    if(failures.length)throw new AggregateError(failures,'Perseus teardown could not confirm all cleanup');
  })().finally(()=>{closing=undefined;});
  return closing;
}
let serial=Promise.resolve();
async function dispatch(message) {
  if (message.op==='status') return {...status(),bridge:{pid:process.pid,dataRoot,hostPid:client?.child?.pid,hostState:client?.state}};
  if (message.op==='watch') {
    // No new boundary is fabricated. A real subsequent hook must first advance
    // it before the earlier-hook observations can be admitted.
    const deadline=Date.now()+DEFAULT_CONFIG.hookWatchMs;
    while(Date.now()<deadline && swarm && !swarm.status().closed){
      const observations=swarm.collect();
      if(observations.length){await persist();return {context:evidenceContext(observations),status:status()};}
      if(!swarm.status().hasPending)return {status:status()};
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    return {status:status()};
  }
  if(message.op==='close'){await close(message.reason??'hook-close');return {status:status()};}
  if(message.op==='event'){
    lastEventAt=Date.now();
    const event=message.event;
    observeActor(event);
    await start();
    if(['PreCompact','PostCompact'].includes(event.hook_event_name)||(event.hook_event_name==='SessionStart'&&event.source==='compact')){
      await swarm.reset('compaction');await pool.reset();await persist();return {status:status()};
    }
    const result=swarm.handle(event);
    await persist();
    return {context:evidenceContext(result.observations??[]),status:status(),launched:result.launched};
  }
  throw new Error('Unknown bridge operation');
}
const server=createServer(socket=>{
  socket.setEncoding('utf8');let input='';
  socket.on('data',chunk=>{
    input+=chunk;
    const end=input.indexOf('\n');if(end<0)return;
    socket.pause();let message;
    try{message=JSON.parse(input.slice(0,end));}catch{socket.end('{"error":"invalid-json"}\n');return;}
    const run=()=>dispatch(message);
    // Watchers must not hold the event queue while workers are pending.
    const result=message.op==='watch'?run():serial.then(run,run);
    if(message.op!=='watch')serial=result.catch(()=>{});
    result.then(value=>socket.end(JSON.stringify(value)+'\n',()=>{
      if(message.op==='close'&&message.reason==='SessionEnd')void stop('SessionEnd');
    }),error=>{
      log({event:'bridge_error'});socket.end(JSON.stringify({error:'bridge-operation-failed',code:error.code??'BRIDGE_ERROR'})+'\n');
    });
  });
  socket.on('error',()=>{});
});
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(socketPath,resolve);});
await chmod(socketPath,0o600);
await writeFile(join(dataRoot,'process.json'),JSON.stringify({pid:process.pid,startedAt:Date.now(),socketPath,sourceRoot}),{mode:0o600});
let exiting=false;
async function stop(reason){
  if(exiting)return;exiting=true;
  let code=0;
  try{await close(reason);}catch{code=1;await writeFile(join(dataRoot,'cleanup-failed.json'),JSON.stringify({reason,confirmed:false}),{mode:0o600});}
  finally{server.close();await unlink(socketPath).catch(()=>{});process.exit(code);}
}
process.on('SIGTERM',()=>void stop('SIGTERM'));process.on('SIGINT',()=>void stop('SIGINT'));
// Do not leave a detached inference host if the plugin owner disappears.
const idle=setInterval(()=>{
  if(!swarm || swarm.status().closed)void stop('idle-closed');
  else if(Date.now()-lastEventAt>300000)void stop('idle-timeout');
},30000);idle.unref();
