import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveContent, readArchive, discloseResult, AsyncContextView } from "./harness/packages/agent/src/context-disclosure.ts";
import { EvidenceLedger } from "./harness/packages/agent/src/evidence-ledger.ts";
import { SpeculativeSessionRuntime } from "./harness/packages/agent/src/se-runtime.ts";
import { runAgentLoop } from "./harness/packages/agent/src/agent-loop.ts";
import { AssistantMessageEventStream } from "./harness/packages/ai/src/utils/event-stream.ts";
import { convertResponsesMessages } from "./harness/packages/ai/src/providers/openai-responses-shared.ts";

test("derived context views preserve Actor calls and text in the next provider request", async () => {
  const model:any={id:"test",provider:"test",api:"openai-responses",contextWindow:1000000,reasoning:true,input:["text"]};
  const runtime:any=new SpeculativeSessionRuntime();
  // Exercise detached views on every turn, including replacement of a tool result.
  runtime.manageContext=(context:any)=>({...context,messages:context.messages.map((m:any)=>
    m.role==="toolResult"?{...m,content:[{type:"text",text:"archived-result-reference"}]}:m)});
  let requests=0;
  const stream:any=(_model:any,context:any)=>{
    const index=requests++;
    if(index===1){
      const wire:any[]=convertResponsesMessages(model,context,new Set());
      assert(wire.some(m=>m.type==="function_call"&&m.call_id==="call_test"));
      assert(wire.some(m=>m.role==="assistant"&&m.content.some((b:any)=>b.text==="Remember my action")));
      assert(wire.some(m=>m.type==="function_call_output"&&m.call_id==="call_test"&&m.output==="archived-result-reference"));
    }
    const message:any={role:"assistant",api:model.api,provider:model.provider,model:model.id,
      content:index===0?[{type:"text",text:"Remember my action"},{type:"toolCall",id:"call_test",name:"probe",arguments:{}}]:[{type:"text",text:"Finished"}],
      stopReason:index===0?"toolUse":"stop",timestamp:Date.now(),usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
    const s=new AssistantMessageEventStream();
    s.push({type:"start",partial:message});s.push({type:"done",reason:message.stopReason,message});s.end(message);return s;
  };
  const messages=await runAgentLoop([{role:"user",content:"Complete the probe",timestamp:0}],
    {systemPrompt:"test",messages:[],tools:[{name:"probe",label:"probe",description:"probe",parameters:{type:"object",properties:{}} as any,
      execute:async()=>({content:[{type:"text",text:"original result"}],details:{}})}]},
    {model,convertToLlm:(m:any)=>m} as any,async()=>{},undefined,stream,runtime);
  assert.equal(requests,2);
  assert.equal(messages.filter(m=>m.role==="assistant").length,2);
  assert.equal((messages.find(m=>m.role==="toolResult") as any).content[0].text,"original result");
});

test("lossless disclosure, structured records and boundary compaction", async () => {
  const state = await mkdtemp(join(tmpdir(), "perseus09-test-"));
  process.env.PERSEUS_STATE_DIR = state;
  process.env.PERSEUS_DISCLOSURE_BYTES = "1024";
  try {
    const original = [{ type: "text", text: "中文🙂\n".repeat(12000) }];
    const result = await discloseResult({ content: original, isError: false }, { tool: "test" });
    const header = JSON.parse(result.content[0].text);
    assert(header.original_preserved);
    const fragments: any[] = [];
    async function walk(path: string): Promise<void> {
      const page = await readArchive(path);
      if (page.kind === "verbatim_json_fragment") fragments.push(page);
      else for (const child of page.children) await walk(child.read_file);
    }
    await walk(header.read_file);
    fragments.sort((a,b)=>a.part-b.part);
    assert.deepEqual(JSON.parse(fragments.map(p=>p.text).join("")), original);
    assert.deepEqual(JSON.parse(await readFile(join(state,"context-archive",header.original_sha256,"original.json"),"utf8")),original);
    await assert.rejects(readArchive("/__perseus_context__/../secret"));
    const small={content:[{type:"text",text:"OK"}]};assert.equal(await discloseResult(small,{}),small);
    const image={content:[{type:"image",mimeType:"image/png",data:"A".repeat(20000)}]};
    assert.equal(await discloseResult(image,{}),image);

    const ledger = new EvidenceLedger();
    const observation=(id:string,text:string,args:any,tool="list_files"):any=>({id,tool,arguments:args,
      content:[{type:"text",text}],isError:false,start:0,end:1});
    assert.equal(ledger.ingest(observation("a","/app/a\n/app/b\n",{path:"/app"})).units.length,2);
    assert.equal(ledger.ingest(observation("b","/app/b\n/app/c\n",{path:"/"})).units.length,1);
    const lines=new EvidenceLedger();
    assert.equal(lines.ingest(observation("c","a.cpp:5:hello",{cwd:"/app",argv:["grep","hello"]},"run_command")).units.length,1);
    assert.equal(lines.ingest(observation("d","a.cpp:5:hello",{cwd:"/app",argv:["grep","hell"]},"run_command")).units.length,0);

    const records=Array.from({length:100},(_,i)=>({source:{filesystem:true},location:{path:`/app/${i}`},value:{exists:true}}));
    const structured=await archiveContent([{type:"text",text:JSON.stringify({units:records})}],{});
    assert.equal(JSON.parse(structured[0].text).structured_records,100);
    const instructions={role:"user",content:"Do not alter unrelated files"};
    const tool={role:"toolResult",toolCallId:"call1",toolName:"test",content:original};
    const view=new AsyncContextView();view.schedule([instructions,tool],1000);
    let committed=0;
    for(let i=0;i<1000&&!committed;i++){await new Promise(r=>setTimeout(r,2));committed=view.commit().changed;}
    assert.equal(committed,1);
    const current=view.view([instructions,tool,{role:"user",content:"new instruction"}]);
    assert.equal(current[0],instructions);assert.equal(current[1].toolCallId,"call1");assert.equal(current[2].content,"new instruction");
    assert.deepEqual(tool.content,original);
    view.reset();assert.equal(view.view([tool])[0],tool);

    const runtime:any=new SpeculativeSessionRuntime();const events:any[]=[];let cancelled=0;
    runtime.controller={record:(e:any)=>events.push(e),reset:()=>{}};
    runtime.predictions.add({cancel:()=>cancelled++});
    runtime.futures.set("old",{observation:undefined,abort:{abort:()=>cancelled++}});
    runtime.contextView.commit=()=>({changed:1});runtime.contextView.schedule=()=>{};
    runtime.manageContext({messages:[],tools:[]},{model:{contextWindow:10000}});
    assert.equal(cancelled,2);assert.equal(runtime.futures.size,0);assert.equal(runtime.closed,false);
    assert(events.some(e=>e.event==="context_compaction_committed"));
  } finally {await rm(state,{recursive:true,force:true});delete process.env.PERSEUS_DISCLOSURE_BYTES;}
});
