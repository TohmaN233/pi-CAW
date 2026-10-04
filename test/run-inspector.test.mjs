import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, workflow, settle } from './fixtures.mjs';
import { inspectRun, readExecutionSession } from '../lib/run-inspector.mjs';
import { runFeedback } from '../lib/run-feedback.mjs';

async function finished(t) {
 const f=await fixture(t);await f.service.store.create(workflow());
 const start=await f.service.call('run',{workflow_id:'example',inputs:{task:'Inspect the actual task'},workspace:f.workspace,access:'read_only',allowed_paths:[],require_approval:false});
 await settle(f.service,start.run_id);
 const proposal=await f.service.call('final_proposal',{run_id:start.run_id});
 await f.service.call('accept_final',{run_id:start.run_id,proposal_sha256:proposal.proposal_sha256,accepted:true},{human:true});
 await settle(f.service,start.run_id);
 return {...f,id:start.run_id};
}
function entries(run,node,id,count=75) {
 return [{type:'session',id},{type:'custom',customType:'pi-caw:task',data:{run_id:run,node_id:node}},
  {type:'message',id:'prompt',message:{role:'user',content:[{type:'text',text:'Actual dispatched task'}]}},
  ...Array.from({length:count},(_,i)=>({type:'message',id:`m${i}`,message:{role:'assistant',model:'worker',provider:'fixture',content:[{type:'text',text:`中文回复 ${i}`}]}}))];
}
test('inspector scopes exact actor/node/attempt and omits controller/provider secrets',async t=>{
 const f=await finished(t),s=f.service;
 const summary=await s.call('inspect_run',{run_id:f.id});assert.equal(summary.nodes.find(n=>n.id==='work').model.model_id,'worker');
 assert.equal(JSON.stringify(summary).includes('control_token'),false);assert.equal(JSON.stringify(summary).includes('prompt_template'),false);
 await assert.rejects(s.call('inspect_run',{run_id:f.id,session_file:'arbitrary'}),{code:'INSPECT_ARGUMENTS'});
 await assert.rejects(s.call('inspect_run',{run_id:f.id,node_id:'unknown'}),{code:'INSPECT_NODE'});
 await assert.rejects(s.call('inspect_run',{run_id:f.id,node_id:'work',attempt_id:'foreign'}),{code:'INSPECT_ATTEMPT'});
 const identity=f.host.mainIdentity;f.host.mainIdentity=()=>({session_id:'another-chat'});
 await assert.rejects(s.call('inspect_run',{run_id:f.id}),{code:'INSPECT_ACTOR'});f.host.mainIdentity=identity;
});
test('native transcript pages are receipt-bound, ordered, Unicode-safe, and ignore partial live writes',async t=>{
 const f=await finished(t),s=f.service,record=await s.runtime.runs.observe(f.id),receipt=record.state.nodes.work.attempts[0].dispatch.receipt;
 const file=receipt.session_file;await writeFile(file,entries(f.id,'work',receipt.thread_id).map(e=>JSON.stringify(e)).join('\n')+'\n{"incomplete":');
 const snapshot=await inspectRun(s,{run_id:f.id,node_id:'work'});const transcript=snapshot.detail.transcript;
 assert.equal(snapshot.detail.instruction.text,'Actual dispatched task');assert.equal(snapshot.detail.instruction_kind,'actual');
 assert.equal(transcript.messages.length,40);assert.equal(transcript.messages[0].id,'m35');assert.equal(transcript.pending,true);
 const earlier=await inspectRun(s,{run_id:f.id,node_id:'work',before:transcript.before});
 assert.equal(earlier.detail.transcript.messages[0].id,'prompt');assert.equal(earlier.detail.transcript.messages.at(-1).id,'m34');assert.equal(earlier.detail.transcript.before,null);
 await assert.rejects(readExecutionSession({...receipt,thread_id:'other'},{run_id:f.id,node_id:'work'}),{code:'INSPECT_SESSION_IDENTITY'});
 await assert.rejects(readExecutionSession(receipt,{run_id:'another-run',node_id:'work'}),{code:'INSPECT_SESSION_BINDING'});
 await writeFile(file,entries(f.id,'work',receipt.thread_id).map(e=>JSON.stringify(e)).join('\n')+'\nnot-json\n');
 await assert.rejects(readExecutionSession(receipt,{run_id:f.id,node_id:'work'}),SyntaxError);
});
test('fan-out selects actual native sessions rather than guessing one child',async t=>{
 const f=await finished(t),s=f.service;
 const sessions=await Promise.all([0,1].map(async i=>{const receipt={thread_id:`child-${i}`,session_file:join(f.root,`child-${i}.jsonl`)};
  await writeFile(receipt.session_file,entries(f.id,'work',receipt.thread_id,1).map(e=>JSON.stringify(e)).join('\n')+'\n');return receipt;}));
 await s.runtime.runs.mutate(f.id,'recover',state=>{state.nodes.work.attempts[0].dispatch.receipt.sessions=sessions;});
 const detail=(await inspectRun(s,{run_id:f.id,node_id:'work',session_index:1})).detail;
 assert.equal(detail.session_count,2);assert.equal(detail.session_index,1);assert.equal(detail.transcript.messages.at(-1).id,'m0');
 await assert.rejects(inspectRun(s,{run_id:f.id,node_id:'work',session_index:2}),{code:'INSPECT_SESSION_INDEX'});
});
test('tool activity updates compact feedback without injecting prompts; cleaned process stays inspectable',async t=>{
 const f=await finished(t),s=f.service,r=await s.runtime.runs.observe(f.id);
 const first=runFeedback(r);r.state.nodes.work.attempts[0].executor_events=[{kind:'tool_operation',sequence:1,metadata:{tool:'read',phase:'start'}}];r.state.nodes.work.attempts[0].executor_event_count=1;
 const second=runFeedback(r);assert.notDeepEqual(first,second);assert.equal(second.nodes.find(n=>n.id==='work').activity.tool,'read');
 await s.retention.sweep({completed_now:true});const result=await inspectRun(s,{run_id:f.id,node_id:'work'});
 assert.equal(result.process_cleaned,true);assert.equal(result.status,'succeeded');assert.equal(result.nodes.length,0);
});
