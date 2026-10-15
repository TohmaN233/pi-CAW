import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,writeFile,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve,sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import * as sdk from '@earendil-works/pi-coding-agent';
import * as ai from '@earendil-works/pi-ai/compat';
import { PiSdkHost } from '../lib/pi-sdk-host.mjs';
import { PiCawService } from '../lib/service.mjs';
import { workflow,agent,settle,fixture } from './fixtures.mjs';
import { digest,canonicalJSON } from '../core/workflow-revisions.mjs';
import { resolveBinding } from '../lib/models.mjs';

const effects=()=>({observed:true,changed_paths:[],outside_paths:[],artifacts:[]});
async function nativeFixture(t,responses){
  const root=await mkdtemp(join(tmpdir(),'pi-caw-portable-sdk-')),workspace=join(root,'workspace'),agentDir=join(root,'agent');await mkdir(workspace);await mkdir(agentDir);
  await writeFile(join(agentDir,'settings.json'),JSON.stringify({packages:[],retry:{enabled:false}}));
  const faux=ai.fauxProvider({provider:'portable-'+randomUUID(),models:[{id:'worker',reasoning:false}],tokensPerSecond:0});faux.setResponses(responses);
  const modelRuntime=await sdk.ModelRuntime.create({authPath:join(agentDir,'auth.json'),modelsPath:null,refreshOnCreate:false});modelRuntime.registerNativeProvider(faux.provider);await modelRuntime.refresh({allowNetwork:false});
  const parent=sdk.SessionManager.create(workspace,join(agentDir,'sessions'));parent.appendMessage(ai.fauxAssistantMessage('Original chat remains independent.'));
  const context={cwd:workspace,sessionManager:parent,modelRegistry:new sdk.ModelRegistry(modelRuntime),model:faux.getModel(),thinkingLevel:'off',isProjectTrusted:()=>false};
  let registry={};const host=new PiSdkHost({sdk,Type:ai.Type,supportedThinking:ai.getSupportedThinkingLevels,agentDir,getContext:()=>context,getHostTools:()=>registry});host.modelRuntimes.set(faux.getModel().provider,modelRuntime);
  const service=await new PiCawService({directory:join(root,'state'),host}).initialize();
  t.after(async()=>{await service.close();assert(resolve(root).startsWith(resolve(tmpdir())+sep));await rm(root,{recursive:true,maxRetries:3,retryDelay:100});});
  return {root,workspace,agentDir,faux,host,service,parent,setTools:async tools=>{registry=tools;await service.refreshContext();}};
}
const submit=result=>[ai.fauxAssistantMessage(ai.fauxToolCall('caw_submit_result',{result,summary:'Offline semantic result'}),{stopReason:'toolUse'}),ai.fauxAssistantMessage('Submitted exact values.')];

test('real offline Pi SDK Main corrections preserve inherited model and exact JSONL turn evidence',{timeout:30000},async t=>{
  const f=await nativeFixture(t,[...submit({text:'rejected'}),...submit({text:'accepted'}),...submit({text:'review'})]);
  const identity={name:'sdk-render',version:'1',sha256:digest('offline sdk render')},contract={id:'sdk_render',identity,argv:['sdk_render'],env_allow:[],
    input_schema:{type:'object',properties:{inputs:{},output:{}},required:['inputs','output'],additionalProperties:false},output_schema:{type:'object',properties:{complete:{type:'boolean'},diagnostic:{type:'string'}},required:['complete','diagnostic'],additionalProperties:false},permissions:{network:false,read_paths:['.'],write_paths:['.']},input_cap_bytes:1024*1024,output_cap_bytes:131072,deadline_ms:5000,idempotency:{mode:'reconcile_required'}};
  let checks=0;await f.setTools({sdk_render:{identity,contract,attestation:{qualified:true,cancellable:true,effect_observation:true,tool_identity:identity,broker_id:'offline-sdk',evidence_sha256:digest('offline qualification')},
    execute:async request=>{checks++;await request.authorize();return {exit_code:0,output:{complete:request.input.output.text==='accepted',diagnostic:'Correct rejected text'},effects:effects(),diagnostic:'Observed offline result'};},
    cancel:async()=>({termination_confirmed:true,evidence:[{kind:'Offline exact stop',sha256:digest('offline exact stop')}],effects:effects()})}});
  const checked={...agent('checked',{kind:'main',mode:'worker'}),access:'bounded_write',path_scope:{binding:'run.allowed_paths'},completion_contract:{on_missing:'block',outcome:'artifact',host_check:{tool:contract.id,success_field:'complete',correction_field:'diagnostic'}}};
  const graph=workflow([checked]);graph.host_tools=[contract];await f.service.call('create_workflow',{workflow:graph});const published=await f.service.store.snapshot(graph.id);
  const run=await f.service.call('run',{workflow_id:graph.id,workspace:f.workspace,access:'bounded_write',allowed_paths:['.'],inputs:{task:'Offline exact checked task'},detached_host:false});const state=(await settle(f.service,run.run_id)).state;
  assert.equal(state.nodes.checked.status,'succeeded',JSON.stringify(state.error));assert.equal(checks,2);
  const record=await f.service.runtime.runs.read(run.run_id),attempt=record.state.nodes.checked.attempts[0],receipt=attempt.dispatch.receipt;
  assert.equal(record.pins.root.revision_hash,published.revision_hash);assert.equal(receipt.observed_model.provider,f.faux.getModel().provider);assert.equal(receipt.observed_model.model_id,'worker');assert.notEqual(receipt.thread_id,f.parent.getSessionId());
  const transcript=await readFile(receipt.session_file,'utf8'),lines=transcript.split('\n').filter(Boolean).map(line=>JSON.parse(line));
  const observedTurns=lines.filter(entry=>entry.type==='message'&&entry.message.role==='assistant').map(entry=>entry.id);
  const checksRecorded=Object.values(attempt.completion_checks);assert(checksRecorded.every(check=>observedTurns.includes(check.identity.turn_id)));assert.equal(new Set(checksRecorded.map(check=>check.identity.turn_id)).size,2);
  assert.equal(f.parent.getEntries().filter(entry=>entry.type==='message').length,1);
  assert.equal(digest(canonicalJSON(record.pins.root.workflow)),digest(canonicalJSON(published.workflow)));
});

test('real offline Pi SDK amendment turns block filesystem tools and accept the dynamic amendment schema',{timeout:20000},async t=>{
  const response=[ai.fauxAssistantMessage(ai.fauxToolCall('write',{path:'forbidden.txt',content:'must not write'}),{stopReason:'toolUse'}),...submit({amendments:[{field:'text',start_line:1,end_line:1,replacement:'fixed\n'}]})];
  const f=await nativeFixture(t,response),binding=resolveBinding({provider:f.faux.getModel().provider,model_id:'worker',thinking:'off'},f.host.catalog());
  const schema={type:'object',properties:{amendments:{type:'array',items:{type:'object',properties:{field:{type:'string'},start_line:{type:'integer'},end_line:{type:'integer'},replacement:{type:'string'}},required:['field','start_line','end_line','replacement'],additionalProperties:false}}},required:['amendments'],additionalProperties:false};
  const task=await f.host.createTask({kind:'subagent',run_id:randomUUID(),node_id:'repair',name:'Semantic amendment',binding,workspace:f.workspace,access:'bounded_write',allowed_paths:['.'],resources:[],schema:{type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false},validateResult:()=>{assert.fail('A dynamic amendment must not run the original full-result validator');}});
  const output=await task.run({prompt:'Produce an amendment only.',schema,semantic_only:true});await f.host.releaseTask(task);
  assert.equal(output.result.amendments[0].replacement,'fixed\n');assert.deepEqual(output.changed_paths,[]);await assert.rejects(readFile(join(f.workspace,'forbidden.txt')),{code:'ENOENT'});
  const entries=await readFile(task.session_file,'utf8');assert.match(entries,/NATIVE_TEXT_AMENDMENT/);assert.match(entries,/semantic submission and pinned resource reads only/);
});

test('cross-host resource completion protocol executes exact source bytes with filtered environment and current Pi receipt',{timeout:20000},async t=>{
  const f=await fixture(t),sourceIdentity={name:'workflow-resource-program',version:'1',sha256:digest('foreign host implementation')};
  const contract={id:'portable_render',identity:sourceIdentity,argv:['node','program/render.mjs','.scratch','@INPUT@'],env_allow:['PI_CAW_FIXTURE_FLAG'],
    input_schema:{type:'object',properties:{inputs:{},output:{}},required:['inputs','output'],additionalProperties:false},output_schema:{type:'object',properties:{complete:{type:'boolean'},diagnostic:{type:'string'}},required:['complete','diagnostic'],additionalProperties:false},permissions:{network:false,read_paths:['.'],write_paths:['.']},input_cap_bytes:1024*1024,output_cap_bytes:131072,deadline_ms:5000,idempotency:{mode:'reconcile_required'}};
  const code="import {readFileSync,writeFileSync} from 'node:fs'; const packet=JSON.parse(readFileSync(process.argv[2],'utf8')); writeFileSync('render.txt',packet.output.text); writeFileSync('environment.json',JSON.stringify({flag:process.env.PI_CAW_FIXTURE_FLAG??null,unlisted:process.env.PI_CAW_UNDECLARED??null})); process.stdout.write(JSON.stringify({complete:true,diagnostic:'Rendered exact synthetic resource'}));";
  const checked={...agent('checked',{kind:'main',mode:'worker'}),access:'bounded_write',path_scope:{binding:'run.allowed_paths'},resources:['program/render.mjs'],completion_contract:{on_missing:'block',outcome:'artifact',host_check:{tool:contract.id,success_field:'complete',correction_field:'diagnostic'}}};
  const graph=workflow([checked]);graph.host_tools=[contract];graph.requirements.executables=['node'];f.service.toolRunner.env={...process.env,PI_CAW_FIXTURE_FLAG:'declared',PI_CAW_UNDECLARED:'must be absent'};
  await f.service.call('create_workflow',{workflow:graph,resources:{'program/render.mjs':code}});const source=await f.service.store.snapshot(graph.id);
  assert.deepEqual(f.service.workflowCapabilityBlockers(graph),[]);
  const started=await f.service.call('run',{workflow_id:graph.id,workspace:f.workspace,access:'bounded_write',allowed_paths:['.'],inputs:{task:'Execute synthetic source renderer'}}),state=(await settle(f.service,started.run_id)).state;
  assert.equal(state.nodes.checked.status,'succeeded',JSON.stringify({error:state.error,pi_owner_error:state.pi_owner_error,notifications:f.notifications,attempts:state.nodes.checked.attempts.map(attempt=>({status:attempt.status,error:attempt.error,completion_checks:attempt.completion_checks}))}));assert.deepEqual(JSON.parse(await readFile(join(f.workspace,'environment.json'),'utf8')),{flag:'declared',unlisted:null});
  const record=await f.service.runtime.runs.read(started.run_id),slot=Object.values(record.state.nodes.checked.attempts[0].completion_checks)[0];
  assert.equal(record.pins.root.revision_hash,source.revision_hash);assert.deepEqual(record.pins.root.workflow.host_tools[0].identity,sourceIdentity);assert.notEqual(slot.receipt.broker.implementation_identity.sha256,sourceIdentity.sha256);assert.equal(slot.receipt.broker.implementation_identity.name,'workflow-resource-program');
  assert(slot.receipt.effects.changed_paths.includes('render.txt'));
  const attempt=record.state.nodes.checked.attempts[0],event=attempt.executor_events.find(event=>event.kind==='tool_operation'&&event.metadata.tool==='run_task_program'&&event.metadata.phase==='completed');
  assert(event,'Real HostToolRunner must preserve the private program evidence sink');
  const launch=attempt.executor_events.find(event=>event.kind==='tool_operation'&&event.metadata.tool==='run_task_program'&&event.metadata.phase==='started');
  assert.equal(launch.metadata.command_timeout_ms,contract.deadline_ms,'The pinned Host deadline must reach actual resource execution');
  const operation=await f.service.runtime.runs.readExecutorResult(started.run_id,attempt.id,event.metadata.evidence_sha256);
  const retained=operation.metadata.output_evidence;
  assert(retained.manifest_path.startsWith(join(f.service.runtime.runs.directory(started.run_id),'execution-materials',attempt.id,'checks')));
  assert.equal(JSON.parse(await readFile(retained.stream_paths.stdout,'utf8')).complete,true);
  assert.equal(JSON.parse(await readFile(retained.manifest_path,'utf8')).outcome.exit_code,0);
});
