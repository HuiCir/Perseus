// Explicit live validation: uses the current native Codex login, without
// reading credentials or changing user settings. This makes two paid turns.
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { RpcClient } from '../src/rpc.mjs';
import { WorkerPool } from '../src/worker.mjs';
import { DEFAULT_CONFIG, WORKER_HOST_CONFIG } from '../src/config.mjs';
import { disableInheritedMcp } from '../src/host-policy.mjs';

const output = resolve(process.argv[2] ?? 'live-results/worker.json');
const root = await mkdtemp(join(tmpdir(),'perseus-live-worker-'));
const events=[]; const turns=[]; const native=[];
const controller=new AbortController();
const timer=setTimeout(()=>controller.abort(new Error('Live worker deadline')),180000);
let client, result;
try{
  const mcpPolicy=await disableInheritedMcp({cwd:root,configOverrides:WORKER_HOST_CONFIG});
  client=await RpcClient.create({cwd:root,experimentalApi:true,configOverrides:{...WORKER_HOST_CONFIG,...mcpPolicy}});
  client.onNotification(({method,params})=>native.push({method,...(params.item?{itemType:params.item.type}:{}),...(method==='error'?{error:params.error}:{}),...(method==='turn/completed'?{status:params.turn.status,error:params.turn.error}: {})}));
  const pool=new WorkerPool({client,dataRoot:root,emit:event=>events.push(event)});
  const facts=[{kind:'user_prompt',prompt:'Inspect a tiny project containing pricing.mjs, pricing.test.mjs and package.json. Propose independent reads to understand a tax rounding bug. Produce read parameters only.'}];
  for(let revision=1;revision<=2;revision++){
    if(revision===2)facts.push({kind:'tool_observation',tool:'exec_command',arguments:{cmd:'cat package.json'},result:'{"type":"module","scripts":{"test":"node --test"}}'});
    const actions=[];
    for await(const action of pool.generate('read',facts,{signal:controller.signal,revision,epoch:0}))actions.push(action);
    turns.push({revision,actions});
  }
  const starts=events.filter(event=>event.event==='worker_model_start');
  result={passed:true,runtime:client.runtime,configuration:DEFAULT_CONFIG,turns,
    samePromptIdentity:starts.length===2&&starts[0].promptIdentity===starts[1].promptIdentity,
    usage:events.filter(event=>event.event==='worker_usage').map(({revision,usage})=>({revision,...usage})),
    cacheClaim:'Observed native counters only; Actor and Speculator use separate model caches.'};
}catch(error){result={passed:false,code:error.code??error.name,message:error.message,turns,events,native};process.exitCode=1;}
finally{
  clearTimeout(timer);
  if(client)result.hostCleanup=await client.close();
  await rm(root,{recursive:true,force:true});
  await mkdir(join(output,'..'),{recursive:true});
  await writeFile(output,JSON.stringify(result,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify(result));
}
