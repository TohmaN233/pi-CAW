import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import * as sdk from '@earendil-works/pi-coding-agent';
import * as ai from '@earendil-works/pi-ai/compat';
import { WorkflowStore } from '../core/workflow-store.mjs';
import { WorkflowRunStore } from '../core/workflow-run-store.mjs';
import { createDraft } from '../core/workflow-schema.mjs';

// No web application, Mode Pack, course registry, external auth or paid call.
const root=resolve(import.meta.dirname,'../.artifacts',`native-pi-modes-${randomUUID()}`);
const cwd=join(root,'workspace'), agentDir=join(root,'agent'), state=join(root,'state');
await mkdir(join(cwd,'product'),{recursive:true});await mkdir(agentDir);
process.env.PI_CODING_AGENT_DIR=agentDir;process.env.PI_CAW_DIR=state;
await writeFile(join(agentDir,'settings.json'),JSON.stringify({packages:[],retry:{enabled:false}}));
const g={...createDraft('native-main-modes','Native Pi Main modes'),status:'ready',
  inputs_schema:{type:'object',properties:{task:{type:'string'}},required:['task']},
  outputs_schema:{type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false},
  skill_policy:{mode:'cooperative',implicit:'allow',ambient_allow:[],shadowed_skill_paths:[]},
  finalization:{required:true,node_id:'final'}};
const node=(id,mode,access)=>({id,type:'agent',executor:{kind:'main',mode},role:id==='final'?'finalizer':'implementer',
  access,...(access==='bounded_write'?{path_scope:['product']}:{}),approval:{required:false},retry:{max_attempts:3},
  prompt_template:'Complete the declared native Pi task and submit a concise result.',input_bindings:{task:'/inputs/task'},outputs_schema:g.outputs_schema});
g.nodes=[{id:'start',type:'start'},node('focus','worker','read_only'),node('final','orchestration','bounded_write'),{id:'end',type:'end'}];
g.edges=g.nodes.slice(0,-1).map((n,i)=>({id:`edge-${i}`,source:n.id,target:g.nodes[i+1].id}));
await (await new WorkflowStore(join(state,'workflows')).initialize()).create(g);
const faux=ai.fauxProvider({provider:`native-pi-${randomUUID()}`,models:[{id:'current-main',reasoning:false}],tokensPerSecond:0});
const runtime=await sdk.ModelRuntime.create({authPath:join(agentDir,'auth.json'),modelsPath:null,refreshOnCreate:false});
runtime.registerNativeProvider(faux.provider);await runtime.refresh({allowNetwork:false});
const manager=sdk.SessionManager.create(cwd,join(agentDir,'sessions'));
manager.appendMessage(ai.fauxAssistantMessage('PRIVATE_NATIVE_PARENT_DECISION'));
let api;
const loader=new sdk.DefaultResourceLoader({cwd,agentDir,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,
  additionalExtensionPaths:[resolve(import.meta.dirname,'../extensions/pi-caw.ts')],
  extensionFactories:[{name:'native-smoke-capture',factory:pi=>{api=pi;}}]});
await loader.reload();assert.deepEqual(loader.getExtensions().errors,[]);
const session=(await sdk.createAgentSession({cwd,agentDir,modelRuntime:runtime,model:faux.getModel(),thinkingLevel:'off',
  sessionManager:manager,resourceLoader:loader,tools:['read','write','bash','caw']})).session;
const errors=[];
const call=(operation,args={})=>new Promise((resolveCall,reject)=>api.events.emit('pi-caw:host-command',{
  session_id:manager.getSessionId(),operation,args,resolve:resolveCall,reject}));
const tool=(name,args)=>ai.fauxAssistantMessage(ai.fauxToolCall(name,args),{stopReason:'toolUse'});
let runId, signalStarted, releaseFirstReply;
const firstRequest=new Promise(resolveRequest=>{signalStarted=resolveRequest;});
const firstReply=new Promise(resolveReply=>{releaseFirstReply=resolveReply;});
try {
  await session.bindExtensions({mode:'rpc',onError:error=>errors.push(error),abortHandler:()=>{void session.abort();}});
  faux.setResponses([
    async context=>{assert(!JSON.stringify(context).includes('PRIVATE_NATIVE_PARENT_DECISION'));signalStarted();await firstReply;return tool('caw_submit_result',{result:{text:'Focused worker done'},summary:'Worker done'});},
    ai.fauxAssistantMessage('Worker submitted.'),
    context=>{assert(JSON.stringify(context).includes('PRIVATE_NATIVE_PARENT_DECISION'));return tool('caw',{action:'main_task'});},
    tool('bash',{command:'echo NATIVE_PI_ORCHESTRATION'}),
    tool('write',{path:'product/native.txt',content:'Native Pi orchestration product'}),
    tool('caw',{action:'main_result',args:{result:{text:'Native Pi product saved'},summary:'Orchestration done'}}),
    ai.fauxAssistantMessage('Ready for human acceptance.'),
    ai.fauxAssistantMessage('Awaiting human review.'),
  ]);
  const launched=await call('run',{workflow_id:g.id,workspace:cwd,access:'bounded_write',allowed_paths:[join(cwd,'product')],inputs:{task:'Produce one native Pi file'}});
  runId=launched.run_id;
  await firstRequest;
  const pending=await call('inspect_run',{run_id:runId,node_id:'focus'});
  assert.equal(pending.detail.transcript.messages.some(item=>item.message.role==='assistant'),false);
  assert(pending.detail.events.some(event=>event.metadata.phase==='dispatch_started'));
  releaseFirstReply();
  const runs=await new WorkflowRunStore(join(state,'runs')).initialize();let record;
  const deadline=Date.now()+25000;
  while(Date.now()<deadline){record=await runs.read(runId);if(record.state.nodes.final.attempts.at(-1)?.result_proposal)break;
    if(['failed','interrupted'].includes(record.state.status))throw new Error(JSON.stringify(record.state.nodes));
    await new Promise(resolveWait=>setTimeout(resolveWait,25));}
  assert(record.state.nodes.final.attempts.at(-1)?.result_proposal,'Native orchestration did not produce its exact result');
  assert.deepEqual(errors,[]);
  const worker=record.state.nodes.focus.attempts[0].dispatch.receipt, current=record.state.nodes.final.attempts[0];
  assert.equal(worker.main_mode,'worker');assert.equal(worker.executor,'pi-isolated-main');assert.notEqual(worker.thread_id,manager.getSessionId());
  assert.equal(worker.observed_model.model_id,'current-main');
  const inspected=await call('inspect_run',{run_id:runId,node_id:'focus'});
  assert.equal(inspected.detail.instruction_kind,'actual');
  assert(inspected.detail.transcript.messages.some(item=>item.message.role==='assistant'));
  assert(inspected.detail.transcript.messages.some(item=>item.message.role==='toolResult' && item.message.toolName==='caw_submit_result'));
  assert(!JSON.stringify(inspected).includes('PRIVATE_NATIVE_PARENT_DECISION'));
  assert(!JSON.stringify(inspected).includes('control_token'));
  assert.equal(current.dispatch.receipt.main_mode,'orchestration');assert.equal(current.dispatch.receipt.thread_id,manager.getSessionId());
  assert.equal(await readFile(join(cwd,'product/native.txt'),'utf8'),'Native Pi orchestration product');
  const result=await runs.readExecutorResult(runId,current.id,current.result_proposal.sha256);
  assert.deepEqual(result.changed_paths,['product/native.txt']);
  assert(manager.getEntries().some(e=>e.message?.role==='toolResult'&&e.message.toolName==='bash'&&!e.message.isError));
  const receipt={host:'native-pi',sdk_version:sdk.VERSION,real_model_calls:0,pi_own_required:false,mode_pack_required:false,
    worker_context_isolated:true,orchestration_keeps_current_context:true,native_shell_and_write_verified:true,
    human_acceptance_pending:true,real_execution_inspector_verified:true,parent_session_id:manager.getSessionId(),run_id:runId,evidence_directory:root};
  await writeFile(join(root,'receipt.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt,null,2));
} finally {
  releaseFirstReply();
  if(runId)await call('cancel',{run_id:runId});
  await session.extensionRunner.emit({type:'session_shutdown'});await session.abort();session.dispose();
}
