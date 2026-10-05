import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkerPool } from '../src/worker.mjs';
import { ToolRegistry, COMMAND_TOOL } from '../src/tool-registry.mjs';
import { DEFAULT_CONFIG } from '../src/config.mjs';
import { promptIdentity, acquisitionInstructions, actionOutputSchema } from '../src/cache.mjs';

const modelCatalog = { data: [{ model: 'gpt-6-luna', defaultReasoningEffort: 'medium',
  supportedReasoningEfforts: ['low', 'medium', 'high'].map(reasoningEffort => ({ reasoningEffort })), inputModalities: ['text'] }], nextCursor: null };

class FakeClient {
  constructor(){this.listeners=new Set();this.requests=[];this.next=0;this.tokens=0;}
  onNotification(fn){this.listeners.add(fn);return()=>this.listeners.delete(fn);}
  emit(method,params){for(const fn of this.listeners)fn({method,params});}
  async request(method,params){
    this.requests.push({method,params});
    if(method==='model/list')return structuredClone(modelCatalog);
    if(method==='config/read')return {config:{mcp_servers:{'example.server':{enabled:true}}}};
    if(method==='thread/start')return {model:'gpt-6-luna',reasoningEffort:params.config.model_reasoning_effort,thread:{id:'worker-read'}};
    if(method==='turn/start'){
      const id='turn-'+(++this.next);const threadId=params.threadId;
      setTimeout(()=>{
        this.emit('turn/started',{threadId,turn:{id}});
        this.emit('item/started',{threadId,turnId:id,item:{type:'agentMessage',id:'comment-'+id,phase:'commentary'}});
        this.emit('item/agentMessage/delta',{threadId,turnId:id,itemId:'comment-'+id,delta:'I will propose read parameters.'});
        this.emit('item/started',{threadId,turnId:id,item:{type:'agentMessage',id:'final-'+id,phase:'final_answer'}});
        this.emit('item/agentMessage/delta',{threadId,turnId:id,delta:'{"actions":[{"tool":"read","arguments":{"path":"a.txt"}}'});
        this.emit('item/agentMessage/delta',{threadId,turnId:id,delta:']}'});
        this.tokens+=2000;
        this.emit('thread/tokenUsage/updated',{threadId,turnId:id,tokenUsage:{total:{totalTokens:this.tokens},last:{inputTokens:1900,cachedInputTokens:1000,totalTokens:2000}}});
        this.emit('turn/completed',{threadId,turn:{id,status:'completed'}});
      },5);
      return {turn:{id}};
    }
    return {};
  }
}
test('domain thread, model, effort and schema remain stable; only new facts append',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'perseus-codex-worker-'));const client=new FakeClient();const events=[];
  try{
    const pool=new WorkerPool({client,dataRoot:dir,emit:e=>events.push(e)});const signal=new AbortController().signal;
    const facts=[{kind:'user',text:'read a.txt'}];
    const first=[];for await(const action of pool.generate('read',facts,{signal,revision:1,epoch:0}))first.push(action);
    const second=[];for await(const action of pool.generate('read',[...facts,{kind:'native',result:'observed'}],{signal,revision:2,epoch:0}))second.push(action);
    assert.equal(first.length,1);assert.equal(second.length,1);
    assert.equal(client.requests.filter(x=>x.method==='thread/start').length,1);
    assert.deepEqual(client.requests.find(x=>x.method==='thread/start').params.config.mcp_servers,{'example.server':{enabled:false}});
    assert.equal(client.requests.find(x=>x.method==='thread/start').params.config['features.hooks'],false);
    assert.equal(client.requests.find(x=>x.method==='thread/start').params.config.model_reasoning_effort,'high');
    assert.equal(client.requests.filter(x=>x.method==='model/list').length,1);
    assert.deepEqual(client.requests.find(x=>x.method==='thread/start').params.environments,[]);
    const turns=client.requests.filter(x=>x.method==='turn/start');
    assert.equal(turns[0].params.model,'gpt-6-luna');assert.equal(turns[1].params.threadId,turns[0].params.threadId);
    assert.equal(turns[0].params.effort,'high');
    assert.deepEqual(turns[0].params.environments,[]);
    assert.deepEqual(turns[0].params.outputSchema,turns[1].params.outputSchema);
    assert.deepEqual(JSON.parse(turns[1].params.input[0].text).observations,[{kind:'native',result:'observed'}]);
    const starts=events.filter(e=>e.event==='worker_model_start');assert.equal(starts[0].promptIdentity,starts[1].promptIdentity);
    assert.equal(events.filter(e=>e.event==='worker_model_end').every(e=>e.observedUsageIncrements===1),true);
  }finally{await rm(dir,{recursive:true,force:true});}
});

class CancelClient extends FakeClient {
  constructor(confirm){super();this.confirm=confirm;this.closed=false;}
  async request(method,params){
    this.requests.push({method,params});
    if(method==='config/read')return {config:{}};
    if(method==='model/list')return structuredClone(modelCatalog);
    if(method==='thread/start')return {model:'gpt-6-luna',reasoningEffort:params.config.model_reasoning_effort,thread:{id:'worker-read'}};
    if(method==='turn/start'){
      setTimeout(()=>{
        this.emit('turn/started',{threadId:params.threadId,turn:{id:'cancel-turn'}});
        this.emit('item/agentMessage/delta',{threadId:params.threadId,turnId:'cancel-turn',delta:'{"actions":[{"tool":"read","arguments":{"path":"a.txt"}}'});
      },1);
      return {turn:{id:'cancel-turn'}};
    }
    if(method==='turn/interrupt'&&this.confirm)
      this.emit('turn/completed',{threadId:params.threadId,turn:{id:'cancel-turn',status:'interrupted'}});
    return {};
  }
  async close(){this.closed=true;return {quiescent:true};}
}
test('cancellation completion arriving during interrupt is observed without a race',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'perseus-codex-cancel-'));const client=new CancelClient(true);
  try{
    const pool=new WorkerPool({client,dataRoot:dir,cancellationGraceMs:100});const controller=new AbortController();
    const iterator=pool.generate('read',[{kind:'user',text:'read'}],{signal:controller.signal,revision:1,epoch:0});
    assert.equal((await iterator.next()).value.tool,'read');
    controller.abort('owner stopped');
    await assert.rejects(iterator.next(),error=>error==='owner stopped');
    assert.equal(client.closed,false);assert.equal(client.listeners.size,0);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('unconfirmed cancellation retires the owned inference host',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'perseus-codex-cancel-'));const client=new CancelClient(false);
  try{
    const pool=new WorkerPool({client,dataRoot:dir,cancellationGraceMs:20});const controller=new AbortController();
    const iterator=pool.generate('read',[{kind:'user',text:'read'}],{signal:controller.signal,revision:1,epoch:0});
    await iterator.next();controller.abort('owner stopped');
    await assert.rejects(iterator.next(),/closing the private inference host/);
    assert.equal(client.closed,true);assert.equal(client.listeners.size,0);
  }finally{await rm(dir,{recursive:true,force:true});}
});

class DynamicClient extends FakeClient {
  constructor(){super();this.threadCount=0;this.threadTokens=new Map();}
  async request(method,params){
    if(method==='thread/start'){
      this.requests.push({method,params});
      return {model:'gpt-6-luna',reasoningEffort:params.config.model_reasoning_effort,thread:{id:'dynamic-'+(++this.threadCount)}};
    }
    if(method!=='turn/start')return super.request(method,params);
    this.requests.push({method,params});
    const id='turn-'+(++this.next),threadId=params.threadId;
    setTimeout(()=>{
      this.emit('turn/started',{threadId,turn:{id}});
      this.emit('item/started',{threadId,item:{type:'agentMessage',id:'final-'+id,phase:'final_answer'}});
      const tool=params.outputSchema.properties.actions.items.properties.tool.enum[0];
      this.emit('item/agentMessage/delta',{threadId,turnId:id,itemId:'final-'+id,
        delta:JSON.stringify({actions:[{tool,arguments_json:JSON.stringify({command:['node','--test']})}]})});
      const total=(this.threadTokens.get(threadId)??0)+1000;this.threadTokens.set(threadId,total);
      this.emit('thread/tokenUsage/updated',{threadId,tokenUsage:{total:{totalTokens:total},last:{inputTokens:900,cachedInputTokens:700}}});
      this.emit('turn/completed',{threadId,turn:{id,status:'completed'}});
    },1);
    return {turn:{id}};
  }
}
test('dynamic domains decode parameters, reuse a positive thread and replace changed complement threads',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'perseus-dynamic-worker-'));const client=new DynamicClient();const events=[];
  try{
    const pool=new WorkerPool({client,dataRoot:dir,emit:entry=>events.push(entry)});
    const registry=new ToolRegistry({tools:[COMMAND_TOOL]});
    const facts=[{kind:'user_prompt',prompt:'Run tests'},
      {kind:'tool_observation',tool:'command_exec',arguments:{command:['node','--test']},result:{exitCode:0}}];
    const first=registry.derive(facts),node1=first.find(domain=>domain.predicate),complement1=first.find(domain=>!domain.predicate);
    const signal=new AbortController().signal;
    const run=async(domain,revision)=>{const actions=[];for await(const action of pool.generate(domain,facts,{signal,revision,epoch:0}))actions.push(action);return actions;};
    assert.deepEqual(await run(node1,1),[{tool:'command_exec',arguments:{command:['node','--test']}}]);
    await run(complement1,1);
    facts.push({kind:'tool_observation',tool:'command_exec',arguments:{command:['python3','inspect.py']},result:{exitCode:0}});
    const second=registry.derive(facts),node2=second.find(domain=>domain.id===node1.id),complement2=second.find(domain=>!domain.predicate);
    await run(node2,2);await run(complement2,2);
    const turns=client.requests.filter(entry=>entry.method==='turn/start');
    assert.equal(turns[0].params.threadId,turns[2].params.threadId);
    assert.notEqual(turns[1].params.threadId,turns[3].params.threadId);
    assert.deepEqual(JSON.parse(turns[2].params.input[0].text).observations,[facts[2]]);
    assert.deepEqual(JSON.parse(turns[3].params.input[0].text).observations,facts);
    const starts=events.filter(entry=>entry.event==='worker_model_start');
    assert.equal(starts[0].promptIdentity,starts[2].promptIdentity);
    assert.notEqual(starts[1].promptIdentity,starts[3].promptIdentity);
    assert.ok(turns.every(entry=>entry.params.model==='gpt-6-luna'&&entry.params.effort==='high'));
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('effective model capability effort drives thread config, turn params and stable cache identity',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'perseus-capability-worker-')),client=new FakeClient(),events=[];
  const originalRequest=client.request.bind(client);
  client.request=async(method,params,options)=>{
    if(method==='model/list'){
      client.requests.push({method,params});
      const page=structuredClone(modelCatalog);
      page.data[0].supportedReasoningEfforts=page.data[0].supportedReasoningEfforts.filter(option=>option.reasoningEffort!=='high');
      return page;
    }
    return originalRequest(method,params,options);
  };
  try{
    const pool=new WorkerPool({client,dataRoot:dir,emit:event=>events.push(event)}),signal=new AbortController().signal;
    const facts=[{kind:'user_prompt',prompt:'inspect'}];
    for(let revision=1;revision<=2;revision++)for await(const action of pool.generate('read',facts,{signal,revision,epoch:0}))void action;
    const starts=client.requests.filter(row=>row.method==='thread/start'),turns=client.requests.filter(row=>row.method==='turn/start');
    assert.equal(starts.length,1);assert.equal(starts[0].params.config.model_reasoning_effort,'medium');
    assert.ok(turns.every(row=>row.params.effort==='medium'));
    const expected=promptIdentity({model:'gpt-6-luna',effort:'medium',instructions:acquisitionInstructions('read'),outputSchema:actionOutputSchema('read'),domainVersion:1});
    assert.ok(events.filter(event=>event.event==='worker_model_start').every(event=>event.promptIdentity===expected&&event.effort==='medium'));
    assert.equal(events.find(event=>event.event==='worker_model_resolved').effortAdjusted,true);
    assert.equal(Object.hasOwn(DEFAULT_CONFIG,'actorModel'),false);assert.equal(Object.hasOwn(DEFAULT_CONFIG,'actorEffort'),false);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('unverified capabilities and changed native effort cannot start a model turn',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'perseus-unknown-capability-'));
  try{
    for(const failure of ['catalog','native-effort']){
      const client=new FakeClient(),request=client.request.bind(client);
      client.request=async(method,params,options)=>{
        if(failure==='catalog'&&method==='model/list')return {data:[],nextCursor:null};
        const response=await request(method,params,options);
        if(failure==='native-effort'&&method==='thread/start')return {...response,reasoningEffort:'ultra'};
        return response;
      };
      const pool=new WorkerPool({client,dataRoot:dir}),signal=new AbortController().signal;
      await assert.rejects(async()=>{for await(const action of pool.generate('read',[],{signal,revision:1,epoch:0}))void action;});
      assert.equal(client.requests.filter(row=>row.method==='turn/start').length,0);
      if(failure==='native-effort')assert.ok(client.requests.some(row=>row.method==='thread/unsubscribe'));
    }
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('failed generation retires its native history instead of appending duplicate facts on retry',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'perseus-failed-worker-'));const client=new DynamicClient();
  const originalEmit=client.emit.bind(client);let corrupt=true;
  client.emit=(method,params)=>{
    if(corrupt&&method==='item/agentMessage/delta')params={...params,delta:'{"actions":[{"tool":"wrong","arguments_json":"{}"}]}'};
    originalEmit(method,params);
  };
  try{
    const pool=new WorkerPool({client,dataRoot:dir});const registry=new ToolRegistry({tools:[COMMAND_TOOL]});
    const domain=registry.derive([])[0],facts=[{kind:'user_prompt',prompt:'Inspect tests'}],signal=new AbortController().signal;
    const run=async()=>{for await(const action of pool.generate(domain,facts,{signal,revision:1,epoch:0}))void action;};
    await assert.rejects(run(),/fixed native tool/);corrupt=false;await run();
    const turns=client.requests.filter(entry=>entry.method==='turn/start');
    assert.notEqual(turns[0].params.threadId,turns[1].params.threadId);
    assert.deepEqual(JSON.parse(turns[1].params.input[0].text).observations,facts);
    assert.ok(client.requests.some(entry=>entry.method==='thread/unsubscribe'&&entry.params.threadId===turns[0].params.threadId));
  }finally{await rm(dir,{recursive:true,force:true});}
});
