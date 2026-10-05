import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSpeculatorProfile, awaitProfile } from '../src/model-capabilities.mjs';
const entry=(efforts=['low','medium','high'],defaults='medium')=>({model:'gpt-6-luna',defaultReasoningEffort:defaults,
  supportedReasoningEfforts:efforts.map(reasoningEffort=>({reasoningEffort})),inputModalities:['text']});
const config={speculatorModel:'gpt-6-luna',speculatorEffort:'high'};
test('catalog pagination selects exact Luna and only supported effort, without upgrading model or strength',async()=>{
  const requests=[];const client={request:async(method,params)=>{requests.push({method,params});return params.cursor
    ? {data:[entry(['low','medium'])],nextCursor:null}:{data:[{...entry(),model:'unrelated'}],nextCursor:'next'};}};
  const profile=await readSpeculatorProfile(client,config);
  assert.equal(profile.model,'gpt-6-luna');assert.equal(profile.effort,'medium');assert.equal(profile.effortAdjusted,true);
  assert.equal(requests[1].params.cursor,'next');assert.ok(requests.every(row=>row.method==='model/list'&&row.params.includeHidden));
  assert.ok(Object.isFrozen(profile)&&Object.isFrozen(profile.supportedReasoningEfforts));
});
test('absent requested effort uses legal native model default, never Actor or global defaults',async()=>{
  const client={request:async()=>({data:[entry()],nextCursor:null})};
  const profile=await readSpeculatorProfile(client,{speculatorModel:'gpt-6-luna'});
  assert.equal(profile.effort,'medium');assert.equal(profile.effortAdjusted,false);
});
test('missing, incompatible and ambiguous capabilities fail closed',async()=>{
  const invalid=[[],[entry([])],[entry(['low'],'medium')],[entry(['xhigh'],'xhigh')],[entry(),entry()],
    [{...entry(),inputModalities:['image']}]];
  for(const data of invalid)await assert.rejects(readSpeculatorProfile({request:async()=>({data,nextCursor:null})},config),{name:'ModelCapabilityError'});
  await assert.rejects(readSpeculatorProfile({request:async()=>{throw new Error('private-provider-detail');}},config),error=>error.code==='MODEL_CATALOG_UNAVAILABLE'&&!error.message.includes('private-provider'));
  await assert.rejects(readSpeculatorProfile({request:async()=>({data:[],nextCursor:'cycle'})},config),{code:'INVALID_MODEL_CATALOG_CURSOR'});
});
test('one cancelled domain does not abort another domain waiting for the shared model profile',async()=>{
  let finish;const pending=new Promise(resolve=>{finish=resolve;});const controller=new AbortController();
  const cancelled=awaitProfile(pending,controller.signal),other=awaitProfile(pending,new AbortController().signal);
  controller.abort(new Error('domain stopped'));await assert.rejects(cancelled,/domain stopped/);
  finish({effort:'high'});assert.deepEqual(await other,{effort:'high'});
});
