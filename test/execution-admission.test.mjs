import test from 'node:test';
import assert from 'node:assert/strict';
import { requestPiExecutionAdmission } from '../lib/pi-sdk-host.mjs';
import { fixture, workflow, settle } from './fixtures.mjs';

const argsFor = f => ({workflow_id:'example',workspace:f.workspace,access:'read_only',inputs:{task:'selected source explanation',taskId:'host-prepared-task'}});
async function prepared(t) {
 const f=await fixture(t), graph=workflow();graph.inputs_schema.properties.taskId={type:'string'};
 await f.service.call('create_workflow',{workflow:graph});return f;
}

test('model and Workbench new runs share admission before Run intent, detached bootstrap or Pi child creation',async t=>{
 const f=await prepared(t), denied=[];let bootstraps=0;
 f.host.detachedBootstrap=()=>{bootstraps++;throw new Error('Unexpected bootstrap before admission');};
 f.host.executionAdmissionRequired=()=>true;
 f.host.authorizeExecution=async request=>{denied.push(request);throw Object.assign(new Error('A learning execution needs an exact prepared task'),{code:'PI_LEARNING_WORKFLOW_SCOPE'});};
 const unscoped={...argsFor(f),inputs:{task:'raw request'}};
 await assert.rejects(f.service.call('run',unscoped),{code:'PI_LEARNING_WORKFLOW_SCOPE'});
 await assert.rejects(f.service.call('start',unscoped,{human:true}),{code:'PI_LEARNING_WORKFLOW_SCOPE'});
 assert.equal(denied.length,2);assert.ok(denied.every(request=>request.session_id===f.mainSession && request.operation==='run' && request.required));
 assert.ok(denied.every(request=>request.workflow_id==='example' && request.revision_hash && request.workflow.id==='example'));
 assert.equal(bootstraps,0);assert.equal(f.requests.length,0);assert.equal((await f.service.call('runs')).length,0);
 delete f.host.detachedBootstrap;
 f.host.authorizeExecution=async request=>{
   assert.equal(request.args.inputs.taskId,'host-prepared-task');assert.equal(request.args.workspace,f.workspace);
   return {authorized:true,session_id:request.session_id,operation:request.operation,scope:'learning'};
 };
 const run=await f.service.call('start',argsFor(f),{human:true});
 assert.equal((await settle(f.service,run.run_id)).state.nodes.work.status,'succeeded');assert.equal(f.requests.length,1);
});

test('required unavailable, disabled, false or foreign admission never falls back to execution',async t=>{
 const f=await prepared(t);f.host.capabilities.execution_admission_required=true;
 await assert.rejects(f.service.call('run',argsFor(f)),{code:'PI_EXECUTION_ADMISSION_REQUIRED'});
 for(const response of [false,null,{authorized:false}]) {
   f.host.authorizeExecution=async()=>response;
   await assert.rejects(f.service.call('run',argsFor(f)),{code:'PI_EXECUTION_ADMISSION_DENIED'});
 }
 for(const response of [{authorized:true,session_id:'foreign-session',operation:'run'},{authorized:true,session_id:f.mainSession,operation:'role_launch'}]) {
   f.host.authorizeExecution=async()=>response;
   await assert.rejects(f.service.call('run',argsFor(f)),{code:'PI_EXECUTION_ADMISSION_SCOPE'});
 }
 f.host.authorizeExecution=async request=>{
   if(request.args.inputs.taskId!=='host-prepared-task')throw Object.assign(new Error('Foreign task'),{code:'PI_LEARNING_TASK_SCOPE'});
   return {authorized:true,session_id:request.session_id,operation:request.operation};
 };
 await assert.rejects(f.service.call('run',{...argsFor(f),inputs:{task:'foreign',taskId:'foreign-task'}}),{code:'PI_LEARNING_TASK_SCOPE'});
 assert.equal(f.requests.length,0);assert.equal((await f.service.call('runs')).length,0);
});

test('unsupported learning Role launch is denied before Role profile, journal or child creation',async t=>{
 const f=await prepared(t);f.host.executionAdmissionRequired=()=>true;
 f.host.authorizeExecution=async request=>{assert.equal(request.operation,'role_launch');throw Object.assign(new Error('Use the curated learning Workflow'),{code:'PI_LEARNING_ROLE_UNSUPPORTED'});};
 f.service.workbench.roleProfile=async()=>{throw new Error('Role profile must not be reached');};
 await assert.rejects(f.service.call('launch_role',{role_id:'raw-role',workspace:f.workspace,task:'raw delegation'},{human:true}),{code:'PI_LEARNING_ROLE_UNSUPPORTED'});
 assert.equal(f.requests.length,0);assert.equal(f.service.roleTasks.size,0);
});

test('an existing teacher Run retains its current owner and leases when later new execution is denied',async t=>{
 const f=await prepared(t), run=await f.service.call('run',argsFor(f));
 await settle(f.service,run.run_id);
 let checks=0;f.host.executionAdmissionRequired=()=>true;
 f.host.authorizeExecution=async()=>{checks++;throw Object.assign(new Error('New execution denied'),{code:'PI_LEARNING_WORKFLOW_SCOPE'});};
 const record=await f.service.runtime.runs.read(run.run_id), attempt=record.state.nodes.final.attempts.at(-1);
 await f.service.call('accept_final',{run_id:run.run_id,accepted:true,proposal_sha256:attempt.result_proposal.sha256},{human:true});
 assert.equal((await settle(f.service,run.run_id)).state.status,'succeeded');assert.equal(checks,0);
 await assert.rejects(f.service.call('run',argsFor(f)),{code:'PI_LEARNING_WORKFLOW_SCOPE'});assert.equal(checks,1);
});

test('a new execution with an existing detached Run ID still uses parent admission instead of owner RPC',async t=>{
 const f=await prepared(t);let ownerCalls=0;
 f.service.detachedOwnerFor=async()=>{ownerCalls++;return {run_id:'existing-run',phase:'running'};};
 f.host.authorizeExecution=async()=>{throw Object.assign(new Error('Exact parent admission denied'),{code:'PI_LEARNING_WORKFLOW_SCOPE'});};
 await assert.rejects(f.service.call('run',{...argsFor(f),run_id:'existing-run'}),{code:'PI_LEARNING_WORKFLOW_SCOPE'});
 await assert.rejects(f.service.call('start',{...argsFor(f),run_id:'existing-run'},{human:true}),{code:'PI_LEARNING_WORKFLOW_SCOPE'});
 assert.equal(ownerCalls,0);assert.equal(f.requests.length,0);
});


test('private Extension event awaits asynchronous attestation and required registration cannot be downgraded',async()=>{
 const selection={session_id:'learning-session',operation:'run',args:{inputs:{taskId:'prepared'}},required:true};
 const required=[];
 const result=await requestPiExecutionAdmission((name,request)=>{
   assert.equal(name,'pi-caw:execution-admission');assert.equal(request.args.inputs.taskId,'prepared');
   request.required=false;
   request.authorize=Promise.resolve({authorized:true,session_id:request.session_id,operation:request.operation});
 },selection,sid=>required.push(sid));
 assert.equal(result.authorized,true);assert.deepEqual(required,['learning-session']);
 await assert.rejects(requestPiExecutionAdmission((_name,request)=>{request.required=false;},selection),{code:'PI_EXECUTION_ADMISSION_REQUIRED'});
 await assert.rejects(requestPiExecutionAdmission((_name,request)=>{request.authorized=false;},selection),{code:'PI_EXECUTION_ADMISSION_DENIED'});
 const optional={...selection,required:false};
 assert.deepEqual(await requestPiExecutionAdmission(()=>{},optional),{authorized:true,session_id:optional.session_id,operation:'run'});
 await assert.rejects(requestPiExecutionAdmission((_name,request)=>{request.required=true;},optional),{code:'PI_EXECUTION_ADMISSION_REQUIRED'});
});
