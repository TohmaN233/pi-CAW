import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir,writeFile,readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture,workflow,agent,settle } from './fixtures.mjs';
import { canonicalJSON,digest } from '../core/workflow-revisions.mjs';
import { executeCompletionCheck } from '../lib/runtime-completion-checks.mjs';
import { validateWorkflowGraph } from '../core/workflow-validator.mjs';
import { validateLoopRegions } from '../core/workflow-loops.mjs';
import { normalizeNodeRuntimeRequirements } from '../core/runtime-requirements.mjs';
import { leaseToken } from '../core/workflow-execution-envelope.mjs';
import { requireHostCompletionProof,readCompletionCheckArtifact } from '../core/execution/host-completion-check.mjs';
import { validateHostToolContract,requireHostToolInputCapacity } from '../core/execution/host-tool-runner.mjs';

const effects=()=>({observed:true,changed_paths:[],outside_paths:[],artifacts:[]});
const textSchema={type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false};
const ranges={type:'array',items:{type:'object',properties:{start_line:{type:'integer',minimum:1},end_line:{type:'integer',minimum:1}},required:['start_line','end_line'],additionalProperties:false}};
function checker({amendment=false}={}){
  const identity={name:'portable-render-check',version:'1',sha256:digest('portable checker fixture')};
  return {id:'render_check',identity,argv:['render_check'],env_allow:[],
    input_schema:{type:'object',properties:{inputs:{},output:{}},required:['inputs','output'],additionalProperties:false},
    output_schema:{type:'object',properties:{complete:{type:'boolean'},diagnostic:{type:'string'},...(amendment?{repair_scope:{type:'object',properties:{markdown:ranges},additionalProperties:false}}:{})},required:['complete','diagnostic',...(amendment?['repair_scope']:[])],additionalProperties:false},
    permissions:{network:false,read_paths:['.'],write_paths:['.']},output_cap_bytes:131072,deadline_ms:5000,idempotency:{mode:'reconcile_required'}};
}
async function installChecker(f,contract,execute){
  f.host.getHostTools=()=>({[contract.id]:{identity:contract.identity,contract,attestation:{qualified:true,cancellable:true,effect_observation:true,tool_identity:contract.identity,broker_id:'synthetic-render',evidence_sha256:digest('synthetic qualification')},execute,
    cancel:async()=>({termination_confirmed:true,evidence:[{kind:'synthetic stop',sha256:digest('synthetic stop')}],effects:effects()})}});
  await f.service.refreshContext();
}
function checkedAgent(kind='main',mode='worker',contract=checker()){
  return {...agent('checked',kind==='main'?{kind,mode}:{kind:'provider',provider_id:'worker'}),access:'bounded_write',path_scope:{binding:'run.allowed_paths'},
    completion_contract:{on_missing:'block',outcome:'artifact',host_check:{tool:contract.id,success_field:'complete',...(mode!=='orchestration'?{correction_field:'diagnostic'}:{})}}};
}
async function launch(f,graph,inputs={task:'Synthetic task'}){
  await f.service.call('create_workflow',{workflow:graph});
  return f.service.call('run',{workflow_id:graph.id,workspace:f.workspace,access:'bounded_write',allowed_paths:['.'],inputs});
}

for(const [kind,mode]of [['main','orchestration'],['main','worker'],['provider','worker']])test(`automatic completion checks correct and seal ${kind}/${mode} Pi turns`,async t=>{
  let turns=0,calls=0;
  const f=await fixture(t,{resultFor:request=>request.node_id==='checked'?{text:++turns===1?'rejected':'accepted'}:{text:'final review'}});
  const contract=checker();await installChecker(f,contract,async request=>{
    calls++;await request.authorize();assert.equal(request.context.workspace,f.workspace);
    const complete=request.input.output.text==='accepted';
    return {exit_code:0,output:{complete,diagnostic:complete?'Accepted':'Replace rejected with accepted'},effects:effects(),diagnostic:'Synthetic verifier completed'};
  });
  const graph=workflow([checkedAgent(kind,mode,contract)]);graph.host_tools=[contract];
  const source=digest(canonicalJSON(graph));
  const run=await launch(f,graph),snapshot=await settle(f.service,run.run_id);
  assert.equal(snapshot.state.nodes.checked.status,'succeeded',JSON.stringify(f.notifications));assert.equal(calls,2);assert.equal(turns,2);
  const record=await f.service.runtime.runs.read(run.run_id),attempt=record.state.nodes.checked.attempts[0];
  assert.equal(Object.keys(attempt.completion_checks).length,2);assert.equal(digest(canonicalJSON(record.pins.root.workflow)),source);
  const checked=attempt.completion.evidence.find(item=>item.kind==='pi_host_completion_check');assert(checked);
  const slot=attempt.completion_checks[checked.reference.slot_id];assert.equal(slot.identity.turn_id,attempt.completion.evidence.find(item=>item.kind==='pi_session').turn_id);
  // A duplicate proposal consumes durable evidence without repeating effects.
  const authority=await f.service.authority(run.run_id),args={...authority,node_id:'checked',attempt_id:attempt.id,lease_token:leaseToken(authority.control_token,run.run_id,'checked',attempt.id)};
  if(kind==='main')await f.service.runtime.completeHostMainResult(run.run_id,args);else await f.service.runtime.completeNode(run.run_id,{...args,completion:attempt.completion});
  assert.equal(calls,2);
});

test('negative automatic checks exhaust the bounded correction budget visibly',async t=>{
  let calls=0,turns=0;
  const f=await fixture(t,{resultFor:request=>request.node_id==='checked'?(turns++,{text:'bad'}):{text:'final'}}),contract=checker();
  await installChecker(f,contract,async()=>({exit_code:0,output:(calls++,{complete:false,diagnostic:'Still invalid'}),effects:effects(),diagnostic:'Rejected'}));
  const node=checkedAgent();node.retry.max_attempts=2;const graph=workflow([node]);graph.host_tools=[contract];
  const run=await launch(f,graph),snapshot=await settle(f.service,run.run_id);
  assert.equal(snapshot.state.nodes.checked.status,'failed');assert.equal(snapshot.state.nodes.checked.error.code,'RETRY_LIMIT');assert.equal(calls,2);assert.equal(turns,2);assert.equal(snapshot.state.nodes.final.status,'pending');
});

test('Main per-item fanout isolates directories, persists prefix declarations and applies only sealed line amendments',async t=>{
  const initial=[],amendments=[],checked=[];const contract=checker({amendment:true});
  const f=await fixture(t,{resultFor:(request,input)=>{
    if(request.node_id!=='checked')return {text:'review'};
    if(input.schema.properties.amendments){amendments.push(request.workspace);assert.equal(input.semantic_only,true);return {amendments:[{field:'markdown',start_line:1,end_line:1,replacement:'accepted\n'}]};}
    initial.push(request.workspace);return {items:[{outcome:'completed',result:{markdown:request.workspace.endsWith('one')?'rejected\nkeep exact\n':'accepted\nkeep exact\n'}}]};
  }});
  await Promise.all(['one','two'].map(name=>mkdir(join(f.workspace,name))));
  await installChecker(f,contract,async request=>{
    await request.authorize();checked.push(request.context.workspace);const markdown=request.input.output.markdown,complete=markdown.startsWith('accepted');
    await writeFile(join(request.context.workspace,'render.txt'),markdown);
    return {exit_code:0,output:{complete,diagnostic:complete?'Ready':'Correct line one',repair_scope:complete?{}:{markdown:[{start_line:1,end_line:1}]}},effects:{...effects(),changed_paths:['render.txt']},diagnostic:'Rendered synthetic text'};
  });
  const node=checkedAgent();node.input_bindings={task:'/inputs/task',pages:'/inputs/pages'};node.subagent_count='auto';
  node.required_artifacts=['one','two'].map(name=>({requirement_id:'render_'+name,path:name+'/render.txt'}));
  node.fanout={input:'pages',item_name:'page',result_output:'results',distribution:'one_per_item',scheduling:'parallel',max_concurrency:2,join:'all_required',result_mode:'per_item',workspace_field:'workspace',write_paths_field:'destinations',shared_prefix:{common_inputs:['task']}};
  node.outputs_schema={type:'object',properties:{results:{type:'array',items:{type:'object',properties:{markdown:{type:'string'}},required:['markdown'],additionalProperties:false}}},required:['results'],additionalProperties:false};
  node.completion_contract.host_check.text_amendment={fields:['markdown'],repair_scope_field:'repair_scope',max_edits:4,max_replacement_bytes:1024};
  const graph=workflow([node]);graph.host_tools=[contract];graph.inputs_schema.properties.pages={type:'array',items:{type:'object',properties:{workspace:{type:'string'},destinations:{type:'array',items:{type:'string'}}},required:['workspace','destinations'],additionalProperties:false}};graph.inputs_schema.required.push('pages');
  const run=await launch(f,graph,{task:'Common instructions',pages:['one','two'].map(name=>({workspace:name,destinations:[name]}))}),snapshot=await settle(f.service,run.run_id);
  assert.equal(snapshot.state.nodes.checked.status,'succeeded',JSON.stringify(f.notifications));assert.equal(initial.length,2);assert.equal(amendments.length,1);assert.equal(checked.length,3);
  assert.deepEqual(snapshot.state.nodes.checked.output.results,[{markdown:'accepted\nkeep exact\n'},{markdown:'accepted\nkeep exact\n'}]);
  const attempt=snapshot.state.nodes.checked.attempts[0],prefix=attempt.executor_events.find(event=>event.kind==='shared_prefix_prepared');assert.equal(prefix.metadata.transport_cache,false);
  assert.equal(Object.keys(attempt.native_item_results).length,2);assert.equal(new Set(attempt.dispatch.receipt.sessions.map(item=>item.thread_id)).size,2);
  for(const slot of Object.values(attempt.completion_checks)){
    const stored=await readCompletionCheckArtifact(f.service.runtime,run.run_id,attempt.id,slot.receipt.output_ref);
    if(stored.output.complete)assert.deepEqual(stored.workspace_snapshot.entries.map(item=>item.path),['render.txt']);
    else assert.equal(Object.hasOwn(stored,'workspace_snapshot'),false);
  }
  assert.deepEqual(attempt.completion.changed_paths.sort(),['one/render.txt','two/render.txt']);
  assert.equal(await readFile(join(f.workspace,'one','render.txt'),'utf8'),'accepted\nkeep exact\n');
});

test('current Main acceptance loops reject, retry and accept without changing finite fresh-review defaults',async t=>{
  let reviews=0,work=0;
  const f=await fixture(t,{resultFor:request=>request.node_id==='review'?{accepted:++reviews>=2}:request.node_id==='work'?(work++,{text:'new work'}):{text:'final'}});
  const review={...agent('review',{kind:'main',mode:'orchestration'}),outputs_schema:{type:'object',properties:{accepted:{type:'boolean'}},required:['accepted'],additionalProperties:false}};
  const graph=workflow([agent('work'),review]);graph.loops=[{id:'acceptance',entry_node:'work',exit_node:'review',node_ids:['work','review'],max_rounds:null,review_context:'current_main',until:{op:'eq',args:[{path:'/nodes/review/output/accepted'},{value:true}]}}];
  const run=await launch(f,graph),snapshot=await settle(f.service,run.run_id);
  assert.equal(snapshot.state.loops.acceptance.status,'accepted');assert.equal(snapshot.state.loops.acceptance.round,2);assert.equal(reviews,2);assert.equal(work,2);
  assert(f.mainRequests.filter(request=>request.node_id==='review').every(request=>request.context_mode==='current'));
  const ordinary=structuredClone(graph);delete ordinary.loops[0].review_context;ordinary.loops[0].max_rounds=3;
  assert.throws(()=>validateLoopRegions(ordinary),{code:'LOOP_REVIEW_CONTEXT'});
  const unbounded=structuredClone(graph);delete unbounded.loops[0].review_context;assert.throws(()=>validateLoopRegions(unbounded),{code:'LOOP_SCHEMA'});
});

test('node-scoped executable activation ignores skipped branches and pins selected scope evidence',async t=>{
  const f=await fixture(t),node=agent('needed');node.runtime_requirements={executables:['synthetic-unavailable'],source_requirement_ids:['selected_branch']};
  const graph=workflow([node]);const gate={id:'gate',type:'condition',cases:[{label:'needed',when:{op:'eq',args:[{path:'/inputs/select'},{value:true}]}}],default_label:'skip'};
  graph.nodes.splice(1,0,gate);graph.edges=[{id:'start-gate',source:'start',target:'gate'},{id:'gate-needed',source:'gate',target:'needed',label:'needed'},{id:'gate-final',source:'gate',target:'final',label:'skip'},{id:'needed-final',source:'needed',target:'final'},{id:'final-end',source:'final',target:'end'}];graph.inputs_schema.properties.select={type:'boolean'};graph.inputs_schema.required.push('select');
  const resolutions=[];f.service.runtime.environmentResolver=async requirements=>{resolutions.push(requirements);return {status:requirements.executables.length?'setup_required':'ready',tools:[],requirements};};
  const skipped=await launch(f,graph,{task:'Skip dependent branch',select:false});assert.equal((await settle(f.service,skipped.run_id)).state.nodes.needed.status,'skipped');assert.equal(resolutions.some(item=>item.executables.length),false);
  const selected=await f.service.call('run',{workflow_id:graph.id,workspace:f.workspace,access:'read_only',inputs:{task:'Select dependent branch',select:true}});const snapshot=await settle(f.service,selected.run_id);
  assert.equal(snapshot.state.environment_attention.node_id,'needed');assert.equal(snapshot.state.environment_attention.source_requirement_ids[0],'selected_branch');assert.equal(f.requests.length,0);
  assert.throws(()=>normalizeNodeRuntimeRequirements({executables:['node'],condition:'invented'}),{code:'NODE_RUNTIME_REQUIREMENTS'});
});

test('automatic checks retain uncertain effects, forbid replay and block retry and retention',async t=>{
  let calls=0;const f=await fixture(t),contract=checker();
  await installChecker(f,contract,async()=>{calls++;await writeFile(join(f.workspace,'effect.txt'),'effect before lost receipt');throw Object.assign(new Error('Verifier transport lost its exact result'),{code:'SYNTHETIC_UNCERTAIN'});});
  const graph=workflow([checkedAgent()]);graph.host_tools=[contract];const run=await launch(f,graph);await settle(f.service,run.run_id);
  const record=await f.service.runtime.runs.read(run.run_id),attempt=record.state.nodes.checked.attempts[0];
  assert.equal(calls,1);assert.equal(Object.values(attempt.completion_checks).length,1);assert.equal(Object.values(attempt.completion_checks)[0].receipt,null);
  assert.equal(await f.service.runQuiescent(record),false);
  const auth=await f.service.authority(run.run_id);
  await assert.rejects(f.service.runtime.retryNode(run.run_id,{...auth,node_id:'checked',reconciliation:{attempt_id:attempt.id,dispatch_request_id:attempt.dispatch.request_id,outcome:'terminated',evidence:[{kind:'Pi session closed'}]}}),{code:'HOST_CHECK_RECONCILIATION_REQUIRED'});
  assert.equal(calls,1);assert.equal(await readFile(join(f.workspace,'effect.txt'),'utf8'),'effect before lost receipt');
});

function directoryPool(kind='main'){
  const node={...agent('pool',kind==='main'?{kind:'main',mode:'worker'}:{kind:'provider',provider_id:'worker'}),access:'bounded_write',path_scope:{binding:'run.allowed_paths'},subagent_count:'auto',input_bindings:{task:'/inputs/task',pages:'/inputs/pages'},
    fanout:{input:'pages',item_name:'page',result_output:'results',distribution:'one_per_item',scheduling:'parallel',max_concurrency:2,join:'all_required',result_mode:'per_item',workspace_field:'workspace',write_paths_field:'destinations'},
    outputs_schema:{type:'object',properties:{results:{type:'array',items:textSchema}},required:['results'],additionalProperties:false}};
  const graph=workflow([node]);graph.inputs_schema.properties.pages={type:'array',items:{type:'object',properties:{workspace:{type:'string'},destinations:{type:'array',items:{type:'string'}}},required:['workspace','destinations'],additionalProperties:false}};graph.inputs_schema.required.push('pages');return graph;
}

for(const kind of ['main','provider'])test(`accepted ${kind} fanout siblings survive a failed Pi child and exact retry`,async t=>{
  const calls={one:0,two:0};let failed=false;
  const f=await fixture(t,{resultFor:request=>{
    if(request.node_id!=='pool')return {text:'final'};
    const name=request.workspace.endsWith('one')?'one':'two';calls[name]++;
    if(name==='two'&&!failed){failed=true;throw Object.assign(new Error('Synthetic child session failed before result'),{code:'SYNTHETIC_PI_FAILURE'});}
    return {items:[{outcome:'completed',result:{text:name}}]};
  }});await Promise.all(['one','two'].map(name=>mkdir(join(f.workspace,name))));
  const graph=directoryPool(kind),inputs={task:'Independent pieces',pages:['one','two'].map(name=>({workspace:name,destinations:[name]}))};
  const run=await launch(f,graph,inputs);const first=await settle(f.service,run.run_id),attempt=first.state.nodes.pool.attempts[0];
  assert.equal(first.state.nodes.pool.status,'failed');assert.equal(attempt.native_item_results[0].result.text,'one');
  await f.service.call('retry',{run_id:run.run_id,node_id:'pool',reconciliation:{attempt_id:attempt.id,dispatch_request_id:attempt.dispatch.request_id,outcome:'terminated',evidence:[{kind:'Exact synthetic child shutdown'}]}},{human:true});
  const second=await settle(f.service,run.run_id);assert.equal(second.state.nodes.pool.status,'succeeded',JSON.stringify(f.notifications));
  assert.deepEqual(calls,{one:1,two:2});assert.deepEqual(second.state.nodes.pool.attempts[1].inherited_native_item_indices,[0]);assert.deepEqual(second.state.nodes.pool.output.results,[{text:'one'},{text:'two'}]);
});

test('scoped ready executable paths bind the selected lease without rewriting global pins',async t=>{
  const f=await fixture(t),node=agent('needed');node.runtime_requirements={executables:[{name:'node',version:'>=22'}],source_requirement_ids:['node_for_selected_task']};
  const graph=workflow([node]);graph.requirements.executables=[{name:'node',version:'>=20'}];await f.service.call('create_workflow',{workflow:graph});
  const calls=[];f.service.runtime.environmentResolver=async requirements=>{calls.push(requirements);return {status:'ready',requirements,tools:requirements.executables.map(item=>({name:item.name,status:'found',path:process.execPath}))};};
  const run=await f.service.runtime.start({workflow_id:graph.id,workspace:f.workspace,access:'read_only',inputs:{task:'Selected node'},main_actor:f.mainSession});
  const root=await f.service.runtime.runs.read(run.run_id),pinsHash=root.state.pins_hash;
  const envelope=await f.service.runtime.claimNode(run.run_id,{control_token:run.control_token,node_id:'needed',owner:'synthetic host',request_id:'exact-selected-node'});
  assert.equal(calls.length,2);assert.equal(calls[0].executables[0].version,'>=20.0.0');assert.equal(calls[1].executables[0].version,'>=22.0.0');
  const after=await f.service.runtime.runs.read(run.run_id),attempt=after.state.nodes.needed.attempts[0];assert.equal(after.state.pins_hash,pinsHash);assert.equal(after.state.constraints.runtime_requirements.executables[0].version,'>=20.0.0');
  assert.equal(attempt.runtime_environment_scope.scope_sha256,after.state.nodes.needed.runtime_environment_binding.scope_sha256);assert.equal(envelope.constraints.runtime_environment.scope_sha256,attempt.runtime_environment_scope.scope_sha256);
  await f.service.runtime.transition(run.run_id,'runtime_environment_rebound',state=>{state.nodes.needed.runtime_environment_binding.environment.tools[0].path=join(f.workspace,'invented-node.exe');});
  await assert.rejects(f.service.runtime.execution(run.run_id,{node_id:'needed',attempt_id:envelope.attempt_id,lease_token:envelope.lease_token,control_token:run.control_token}),{code:'ENVIRONMENT_BINDING_STALE'});
});

test('Host check replay uses exact durable evidence and detects changed effects before completion',async t=>{
  let calls=0;const f=await fixture(t),contract=checker();contract.input_cap_bytes=1024*1024;
  await installChecker(f,contract,async()=>{calls++;await writeFile(join(f.workspace,'verified.txt'),'accepted bytes');return {exit_code:0,output:{complete:true,diagnostic:'Accepted'},effects:{...effects(),changed_paths:['verified.txt']},diagnostic:'Accepted'};});
  const definition=checkedAgent();definition.required_artifacts=[{requirement_id:'verified_product',path:'verified.txt'}];
  const graph=workflow([definition]);graph.host_tools=[contract];await f.service.call('create_workflow',{workflow:graph});
  const run=await f.service.runtime.start({workflow_id:graph.id,workspace:f.workspace,access:'bounded_write',allowed_paths:['.'],inputs:{task:'x'.repeat(150000)},main_actor:f.mainSession});
  const envelope=await f.service.runtime.claimHostMain(run.run_id,{control_token:run.control_token,node_id:'checked',owner:f.mainSession,request_id:'explicit-checked-lease'}),args={control_token:run.control_token,node_id:'checked',attempt_id:envelope.attempt_id,lease_token:envelope.lease_token};
  const options={definition,envelope,output:{text:'Accepted'},turn:{session_id:'synthetic-private-session',turn_id:'actual-synthetic-turn'},resources:[]};
  const first=await executeCompletionCheck(f.service,run.run_id,args,options),second=await executeCompletionCheck(f.service,run.run_id,args,options);assert.equal(calls,1);assert.deepEqual(first.reference,second.reference);
  const record=await f.service.runtime.runs.read(run.run_id),attempt=record.state.nodes.checked.attempts[0],slot=attempt.completion_checks[first.reference.slot_id];assert(slot.input_ref.bytes>128*1024);
  await requireHostCompletionProof(f.service.runtime,run.run_id,record,definition,attempt,options.output,first.reference);
  await writeFile(join(f.workspace,'verified.txt'),'changed after exact check');
  await assert.rejects(requireHostCompletionProof(f.service.runtime,run.run_id,record,definition,attempt,options.output,first.reference),{code:'HOST_CHECK_SNAPSHOT_STALE'});assert.equal(calls,1);
  const normal=checker();assert.throws(()=>requireHostToolInputCapacity(normal,{text:'x'.repeat(150000)}),{code:'HOST_TOOL_INPUT_LIMIT'});
  assert.throws(()=>validateHostToolContract({...contract,input_cap_bytes:16*1024*1024+1}),{code:'HOST_TOOL_CONTRACT'});
});

test('explicit current Main loop cancellation settles its current Pi owner and never releases final acceptance',async t=>{
  let enterReview;const entered=new Promise(resolve=>{enterReview=resolve;});
  const f=await fixture(t,{resultFor:(request,input)=>{
    if(request.node_id!=='review')return {text:'work'};
    enterReview();return new Promise((_resolve,reject)=>input.signal.addEventListener('abort',()=>reject(Object.assign(new Error('Synthetic current turn cancelled'),{code:'PI_TASK_ABORTED'})),{once:true}));
  }});
  const review={...agent('review',{kind:'main',mode:'orchestration'}),outputs_schema:{type:'object',properties:{accepted:{type:'boolean'}},required:['accepted'],additionalProperties:false}};
  const graph=workflow([agent('work'),review]);graph.loops=[{id:'acceptance',entry_node:'work',exit_node:'review',node_ids:['work','review'],max_rounds:null,review_context:'current_main',until:{op:'eq',args:[{path:'/nodes/review/output/accepted'},{value:true}]}}];
  const run=await launch(f,graph);await entered;await f.service.call('cancel',{run_id:run.run_id},{human:true});
  const record=await f.service.runtime.runs.read(run.run_id);assert.equal(record.state.status,'cancelled');assert.notEqual(record.state.nodes.final.status,'succeeded');assert.equal(record.state.loops.acceptance.round,1);assert.equal(await f.service.runQuiescent(record),true);
});
