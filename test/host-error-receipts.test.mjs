import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fixture,workflow,agent} from './fixtures.mjs';
import {digest} from '../core/workflow-revisions.mjs';
import {executeCompletionCheck} from '../lib/runtime-completion-checks.mjs';
import {PiCawService} from '../lib/service.mjs';
import {WorkflowRuntime} from '../core/workflow-runtime.mjs';

test('runtime rejects invalid program deadline evidence before journal admission',async()=>{
 const runtime=Object.create(WorkflowRuntime.prototype);
 for(const command_timeout_ms of [0,-1,3600001,1.5,'5000',null])await assert.rejects(
   runtime.recordExecutorEvent('uncreated',{event:{kind:'tool_operation',metadata:{tool:'run_task_program',command_timeout_ms}}}),
   {code:'EXECUTOR_EVENT_SCHEMA'});
});

const effects=()=>({observed:true,changed_paths:['effect.txt'],outside_paths:[],artifacts:[]});
const outputSchema={type:'object',properties:{complete:{type:'boolean'},diagnostic:{type:'string'}},required:['complete','diagnostic'],additionalProperties:false};
function contract(check=false){return {id:'builtin_effect',identity:{name:'builtin-effect-fixture',version:'1',sha256:digest('builtin-effect-fixture')},argv:[],input_schema:check?{type:'object',properties:{inputs:{},output:{}},required:['inputs','output'],additionalProperties:false}:{type:'object',additionalProperties:false},output_schema:outputSchema,env_allow:[],permissions:{network:false,read_paths:['.'],write_paths:['.']},output_cap_bytes:1024,deadline_ms:1000,idempotency:{mode:'reconcile_required'}};}
async function setup(t,{check=false,unconfirmed=false}={}){
 const f=await fixture(t),tool=contract(check),original=Object.assign(new Error('builtin effect threw after writing'),{code:'FIXTURE_FAILURE'}),cleanup=new Error('effect owner stop failed');let calls=0,cancels=0;
 f.service.builtinHostTools[tool.id]={identity:tool.identity,contract:tool,attestation:{qualified:true,cancellable:true,effect_observation:true,tool_identity:tool.identity,broker_id:'fixture-broker',evidence_sha256:digest('fixture-qualified')},
  execute:async()=>{calls++;await writeFile(join(f.workspace,'effect.txt'),'original effect');throw original;},
  cancel:async()=>{cancels++;if(unconfirmed)throw cleanup;return {termination_confirmed:true,evidence:[{kind:'closed',sha256:digest('fixture closed')}],effects:effects()};}};
 await f.service.refreshContext();
 const node=check?{...agent('effect'),access:'bounded_write',path_scope:{binding:'run.allowed_paths'},completion_contract:{on_missing:'block',outcome:'artifact',host_check:{tool:tool.id,success_field:'complete',correction_field:'diagnostic'}}}
  :{id:'effect',type:'tool',executor:{kind:'tool',tool:tool.id},access:'bounded_write',path_scope:{binding:'run.allowed_paths'},retry:{max_attempts:2},approval:{required:false},input_bindings:{},outputs_schema:outputSchema};
 const graph=workflow([node]);graph.host_tools=[tool];await f.service.call('create_workflow',{workflow:graph});
 const run=await f.service.runtime.start({workflow_id:graph.id,workspace:f.workspace,access:'bounded_write',allowed_paths:['.'],main_actor:f.mainSession,inputs:{task:'fixture'}});
 return {...f,tool,node,run,authority:{control_token:run.control_token},original,cleanup,calls:()=>calls,cancels:()=>cancels};
}

test('builtin tool exception saves the exact original intent receipt before failing the node',async t=>{
 const f=await setup(t);await assert.rejects(f.service.executeNode(f.run.run_id,'effect',f.authority,new AbortController().signal),error=>error===f.original);
 const record=await f.service.runtime.runs.read(f.run.run_id),attempt=record.state.nodes.effect.attempts[0];
 assert.equal(f.calls(),1);assert.equal(f.cancels(),1);assert.equal(attempt.status,'failed');assert.equal(attempt.host_tool.phase,'received');
 assert.deepEqual(attempt.host_tool.receipt,f.original.host_tool_receipt);assert.equal(attempt.host_tool.receipt.attempt_id,attempt.id);assert.equal(attempt.host_tool.receipt.input_sha256,attempt.host_tool.input_sha256);
 assert.deepEqual(attempt.host_tool.receipt.effects,effects());assert.equal(await f.service.runQuiescent(record),true);assert.equal(await readFile(join(f.workspace,'effect.txt'),'utf8'),'original effect');
});

test('unconfirmed builtin tool stop preserves interrupted ownership and uncertain intent',async t=>{
 const f=await setup(t,{unconfirmed:true});await assert.rejects(f.service.executeNode(f.run.run_id,'effect',f.authority,new AbortController().signal),error=>error instanceof AggregateError&&error.errors[0]===f.original&&error.errors[1]===f.cleanup&&error.quiescent===false);
 const record=await f.service.runtime.runs.read(f.run.run_id),attempt=record.state.nodes.effect.attempts[0];assert.equal(record.state.status,'interrupted');assert.equal(attempt.status,'interrupted');assert.equal(attempt.host_tool.receipt,null);
 assert.equal(await f.service.runQuiescent(record),false);assert.equal((await f.service.enrichNotification({run_id:f.run.run_id,status:'failed'})).ownership_released,false);
 await assert.rejects(f.service.runtime.retryNode(f.run.run_id,{...f.authority,node_id:'effect'}),{code:'HOST_TOOL_RECONCILIATION_REQUIRED'});assert.equal(f.calls(),1);
});

async function checkOptions(f){
 const lease=await f.service.runtime.claimNode(f.run.run_id,{...f.authority,node_id:'effect',owner:'fixture',request_id:'fixture-check'}),args={...f.authority,...lease,node_id:'effect'};
 const envelope=await f.service.runtime.execution(f.run.run_id,args);
 return {args,options:{definition:f.node,envelope,output:{text:'fixture result'},turn:{session_id:'fixture-session',turn_id:'fixture-turn'},resources:[],signal:new AbortController().signal}};
}

test('builtin completion-check exception durably settles its exact slot and replay never reexecutes',async t=>{
 const f=await setup(t,{check:true}),{args,options}=await checkOptions(f);
 await assert.rejects(executeCompletionCheck(f.service,f.run.run_id,args,options),error=>error===f.original);
 const record=await f.service.runtime.runs.read(f.run.run_id),attempt=record.state.nodes.effect.attempts[0],slots=Object.values(attempt.completion_checks);assert.equal(slots.length,1);assert.equal(slots[0].phase,'received');
 const receipt=slots[0].receipt;assert.deepEqual(receipt,f.original.host_tool_receipt);assert.equal(receipt.attempt_id,args.attempt_id);assert.equal(receipt.input_sha256,slots[0].identity.input_sha256);assert.deepEqual(receipt.effects,effects());
 assert.equal(await f.service.runQuiescent(record),true);
 await assert.rejects(executeCompletionCheck(f.service,f.run.run_id,args,options),{code:'PI_HOST_CHECK_FAILED'});assert.equal(f.calls(),1);assert.equal(f.cancels(),1);
});

test('unconfirmed builtin completion check interrupts the dispatched Pi owner and forbids retry',async t=>{
 const f=await setup(t,{check:true,unconfirmed:true});
 await assert.rejects(f.service.executeNode(f.run.run_id,'effect',f.authority,new AbortController().signal),error=>error instanceof AggregateError&&error.errors[0]===f.original&&error.quiescent===false);
 const record=await f.service.runtime.runs.read(f.run.run_id),attempt=record.state.nodes.effect.attempts[0];assert.equal(record.state.status,'interrupted');assert.equal(Object.values(attempt.completion_checks)[0].receipt,null);assert.equal(await f.service.runQuiescent(record),false);
 assert.equal((await f.service.enrichNotification({run_id:f.run.run_id,status:'failed'})).ownership_released,false);
 await assert.rejects(f.service.runtime.retryNode(f.run.run_id,{...f.authority,node_id:'effect'}),{code:'HOST_CHECK_RECONCILIATION_REQUIRED'});assert.equal(f.calls(),1);
});

test('builtin failure receipt persistence errors preserve both failures and keep the intent uncertain',async t=>{
 const f=await setup(t),disk=new Error('fixture receipt journal failed');f.service.runtime.recordHostToolReceipt=async()=>{throw disk;};
 await assert.rejects(f.service.executeNode(f.run.run_id,'effect',f.authority,new AbortController().signal),error=>error instanceof AggregateError&&error.errors[0]===f.original&&error.errors[1]===disk);
 const record=await f.service.runtime.runs.read(f.run.run_id);assert.equal(record.state.nodes.effect.attempts[0].host_tool.receipt,null);assert.equal(await f.service.runQuiescent(record),false);assert(f.original.host_tool_receipt);assert.equal(f.cancels(),1);
});

test('completion failure receipt cannot settle a different immutable intent',async t=>{
 const f=await setup(t,{check:true}),{args,options}=await checkOptions(f),execute=f.service.toolRunner.execute.bind(f.service.toolRunner);
 f.service.toolRunner.execute=async(...request)=>{try{return await execute(...request);}catch(error){error.host_tool_receipt.input_sha256=digest('different input');throw error;}};
 await assert.rejects(executeCompletionCheck(f.service,f.run.run_id,args,options),error=>error instanceof AggregateError&&error.errors[0]===f.original&&error.errors[1].code==='HOST_CHECK_INTENT');
 const record=await f.service.runtime.runs.read(f.run.run_id);assert.equal(Object.values(record.state.nodes.effect.attempts[0].completion_checks)[0].receipt,null);assert.equal(await f.service.runQuiescent(record),false);assert.equal(f.calls(),1);
});

test('operation projection carries only bounded Host command deadlines while retaining complete evidence',async()=>{
 for(const value of [1,3600000,0,-1,1.5,3600001,'3600000',null]){
  let full,event;const service={runtime:{runs:{saveExecutorResult:async(_run,_attempt,payload)=>{full=payload;return {artifact:'fixture.json',sha256:digest('fixture')};}},recordExecutorEvent:async(_run,args)=>{event=args.event;}}};
  await PiCawService.prototype.recordTaskOperation.call(service,'run',{attempt_id:'attempt'},{phase:'started',command_timeout_ms:value});
  assert.equal(full.metadata.command_timeout_ms,value);
  if(Number.isSafeInteger(value)&&value>0&&value<=3600000)assert.equal(event.metadata.command_timeout_ms,value);
  else assert.equal(Object.hasOwn(event.metadata,'command_timeout_ms'),false);
 }
});
