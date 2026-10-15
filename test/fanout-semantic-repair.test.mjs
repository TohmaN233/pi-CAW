import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, workflow, agent, settle } from './fixtures.mjs';
import { digest } from '../core/workflow-revisions.mjs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

function pool({ checked=false, aggregate=false }={}) {
  const node={...agent('pool'),subagent_count:'auto',input_bindings:{records:'/inputs/records'},
    fanout:{input:'records',item_name:'record',result_output:'results',distribution:checked?'one_per_item':'partition',...(checked?{}:{batch_size:2}),scheduling:'parallel',max_concurrency:2,join:'all_required',...(!aggregate?{result_mode:'per_item'}:{})},
    outputs_schema:{type:'object',properties:{results:{type:'array',items:{type:'object',properties:{value:{type:'integer'}},required:['value'],additionalProperties:false}}},required:['results'],additionalProperties:false}};
  if(checked){node.access='bounded_write';node.path_scope={binding:'run.allowed_paths'};node.fanout.workspace_field='workspace';node.fanout.write_paths_field='destinations';node.completion_contract={on_missing:'block',outcome:'artifact',host_check:{tool:'check',success_field:'complete',correction_field:'diagnostic'}};}
  const graph=workflow([node]);graph.inputs_schema.properties.records={type:'array',items:checked?{type:'object',properties:{value:{type:'integer'},workspace:{type:'string'},destinations:{type:'array',items:{type:'string'}}},required:['value','workspace','destinations'],additionalProperties:false}:{type:'integer'},minItems:1};graph.inputs_schema.required.push('records');return graph;
}
const completed=value=>({outcome:'completed',result:{value}});
async function start(f,graph,records=[1,2]) {
  await f.service.call('create_workflow',{workflow:graph});
  if(graph.host_tools){await mkdir(join(f.workspace,'item'));records=records.map(value=>({value,workspace:'item',destinations:['item']}));}
  const run=await f.service.call('run',{workflow_id:graph.id,workspace:f.workspace,access:'bounded_write',allowed_paths:['.'],inputs:{task:'Repair exact selected items',records}});
  return (await settle(f.service,run.run_id)).state;
}
async function checker(f,execute) {
  const identity={name:'fanout-semantic-check',version:'1',sha256:digest('fanout semantic fixture')};
  const contract={id:'check',identity,argv:['check'],env_allow:[],input_schema:{type:'object',properties:{inputs:{},output:{}},required:['inputs','output'],additionalProperties:false},output_schema:{type:'object',properties:{complete:{type:'boolean'},diagnostic:{type:'string'}},required:['complete','diagnostic'],additionalProperties:false},permissions:{network:false,read_paths:['.'],write_paths:['.']},output_cap_bytes:131072,deadline_ms:5000,idempotency:{mode:'reconcile_required'}};
  f.host.getHostTools=()=>({check:{identity,contract,attestation:{qualified:true,cancellable:true,effect_observation:true,tool_identity:identity,broker_id:'fixture',evidence_sha256:digest('fixture qualified')},execute,cancel:async()=>({termination_confirmed:true,evidence:[{kind:'fixture stopped'}],effects:{observed:true,changed_paths:[],outside_paths:[],artifacts:[]}})}});await f.service.refreshContext();return contract;
}
const effects={observed:true,changed_paths:[],outside_paths:[],artifacts:[]};

test('checked blocked fanout corrects the exact reason in the same task session without checking blocked output',async t=>{
  const turns=[];const f=await fixture(t,{resultFor:(request,input)=>{if(request.node_id!=='pool')return {text:'review'};turns.push({request,input});return {items:[turns.length===1?{outcome:'blocked',block_reason:'Need the exact source section'}:completed(9)]};}});
  let checks=0;const contract=await checker(f,async()=>{checks++;return {exit_code:0,output:{complete:true,diagnostic:'ok'},effects,diagnostic:'ok'};});const graph=pool({checked:true});graph.host_tools=[contract];const state=await start(f,graph,[1]);
  assert.equal(state.nodes.pool.status,'succeeded',JSON.stringify(state.nodes.pool.error));assert.equal(turns.length,2);assert.equal(f.requests.length,1);assert.equal(checks,1);assert.match(turns[1].input.prompt,/Need the exact source section/);
  const attempt=state.nodes.pool.attempts[0],rejected=attempt.native_rejected_turns[0];assert.equal(rejected.reason,'Need the exact source section');assert.equal(rejected.agent_id,attempt.dispatch.receipt.thread_id);assert.equal(attempt.worker_completion_turns[0],2);
});

test('partial partition keeps accepted siblings and corrects only unresolved original positions',async t=>{
  const turns=[];const f=await fixture(t,{resultFor:(request,input)=>{if(request.node_id!=='pool')return {text:'review'};turns.push(input);return turns.length===1?{items:[completed(10),{outcome:'blocked',block_reason:'Second item needs correction'}]}:{items:[completed(20)]};}});
  const state=await start(f,pool());assert.equal(state.nodes.pool.status,'succeeded',JSON.stringify(state.nodes.pool.error));assert.deepEqual(state.nodes.pool.output.results,[{value:10},{value:20}]);assert.equal(f.requests.length,1);assert.equal(turns.length,2);assert.match(turns[1].prompt,/positions \[2\]/);assert.match(turns[1].prompt,/exactly 1 ordered/);assert.deepEqual(state.nodes.pool.attempts[0].worker_completion_turns,{'0':1,'1':2});
});

test('invalid completed partition entries retain valid siblings before their same-session correction',async t=>{
  const turns=[];const f=await fixture(t,{resultFor:(request,input)=>{if(request.node_id!=='pool')return {text:'review'};turns.push(input);return turns.length===1?{items:[completed(10),{outcome:'completed',result:{value:'bad'}}]}:{items:[completed(20)]};}});
  const state=await start(f,pool());assert.equal(state.nodes.pool.status,'succeeded',JSON.stringify(state.nodes.pool.error));assert.deepEqual(state.nodes.pool.output.results,[{value:10},{value:20}]);assert.equal(f.requests.length,1);assert.match(turns[1].prompt,/positions \[2\]/);assert.match(turns[1].prompt,/expected integer/);assert.equal(state.nodes.pool.attempts[0].native_rejected_turns[0].category,'invalid');
});

test('partition correction preserves every exact long blocker in the same worker prompt and durable evidence',async t=>{
  const first='First exact blocker '.repeat(204),second='Second independent blocker must survive';let turns=0;const prompts=[];
  const f=await fixture(t,{resultFor:(request,input)=>{if(request.node_id!=='pool')return {text:'review'};prompts.push(input.prompt);return ++turns===1?{items:[{outcome:'blocked',block_reason:first},{outcome:'blocked',block_reason:second}]}:{items:[completed(10),completed(20)]};}});
  const state=await start(f,pool());assert.equal(state.nodes.pool.status,'succeeded',JSON.stringify(state.nodes.pool.error));assert.equal(f.requests.length,1);assert(prompts[1].includes(first));assert(prompts[1].includes(second));
  const attempt=state.nodes.pool.attempts[0],event=attempt.executor_events.find(event=>event.kind==='tool_operation'&&event.metadata.tool==='fanout_semantic_result');assert(event);const operation=await f.service.runtime.runs.readExecutorResult(state.run_id,attempt.id,event.metadata.evidence_sha256);
  assert.deepEqual(operation.metadata.issues.map(issue=>issue.reason),[first,second]);assert.equal(operation.metadata.turn_id,attempt.native_rejected_turns[0].turn_id);assert(attempt.native_rejected_turns[0].reason.includes(event.metadata.artifact));
});

for(const overflow of [false,true])test(`long partition diagnostics ${overflow?'fail visibly at the prompt bound':'remain locatable on exhaustion'}`,async t=>{
  const first='Exact long partition reason '.repeat(146),second='Distinct second unresolved reason',reasons=[first,second];let turns=0;
  const f=await fixture(t,{resultFor:request=>request.node_id==='pool'?(turns++,{items:reasons.map(block_reason=>({outcome:'blocked',block_reason}))}):{text:'review'}});
  if(overflow){const current=await f.service.call('settings');await f.service.call('save_settings',{settings:{...current.settings,global:{enabled:true,console_title:'Fixture',max_prompt_chars:4096}},expected_revision:current.revision},{human:true});}
  const graph=pool();graph.nodes.find(node=>node.id==='pool').retry.max_attempts=2;const state=await start(f,graph),attempt=state.nodes.pool.attempts[0];
  assert.equal(state.nodes.pool.status,'failed');assert.equal(state.nodes.pool.error.code,overflow?'PI_PROMPT_LIMIT':'NATIVE_AGENT_REPAIR_EXHAUSTED');assert.equal(turns,overflow?1:2);
  const event=attempt.executor_events.filter(event=>event.kind==='tool_operation'&&event.metadata.tool==='fanout_semantic_result').at(-1);assert(event);assert(state.nodes.pool.error.message.includes(event.metadata.artifact));
  const retained=await f.service.runtime.runs.readExecutorResult(state.run_id,attempt.id,event.metadata.evidence_sha256);assert.deepEqual(retained.metadata.issues.map(issue=>issue.reason),reasons);
  if(!overflow)for(const reason of reasons)assert(state.nodes.pool.error.message.includes(reason));
});

test('unchecked fanout exhaustion retains its final exact semantic reason',async t=>{
  const detail='Exact retained semantic detail. '.repeat(100);let turns=0;const f=await fixture(t,{resultFor:request=>request.node_id==='pool'?{items:[{outcome:'blocked',block_reason:detail+'Precise final reason '+(++turns)}]}:{text:'review'}});const graph=pool();graph.nodes.find(node=>node.id==='pool').retry.max_attempts=2;const state=await start(f,graph,[1]);
  assert.equal(turns,2);assert.equal(state.nodes.pool.status,'failed');assert.equal(state.nodes.pool.error.message,detail+'Precise final reason 2');assert.equal(state.nodes.pool.error.code,'NATIVE_AGENT_REPAIR_EXHAUSTED');assert.equal(state.nodes.pool.attempts[0].native_rejected_turns[0].count,2);
});

test('failed mechanical Host checks propagate without a semantic retry',async t=>{
  let turns=0,checks=0;const f=await fixture(t,{resultFor:request=>request.node_id==='pool'?(turns++,{items:[completed(1)]}):{text:'review'}});const contract=await checker(f,async()=>{checks++;throw Object.assign(new Error('Exact Host transport failed'),{code:'FIXTURE_HOST_TRANSPORT'});});const graph=pool({checked:true});graph.host_tools=[contract];const state=await start(f,graph,[1]);
  assert.equal(state.nodes.pool.status,'failed');assert.equal(turns,1);assert.equal(checks,1);assert.equal(state.nodes.pool.attempts[0].native_rejected_turns,undefined);assert.match(state.nodes.pool.error.message,/Exact Host transport failed/);
});

test('checked fanout rejects a wrong-count completed turn before Host effects and checks only its correction',async t=>{
  let turns=0,checks=0;const prompts=[];
  const f=await fixture(t,{resultFor:(request,input)=>{if(request.node_id!=='pool')return {text:'review'};prompts.push(input.prompt);return {items:++turns===1?[completed(1),completed(2)]:[completed(3)]};}});
  const contract=await checker(f,async()=>{checks++;return {exit_code:0,output:{complete:true,diagnostic:'Accepted exact corrected item'},effects,diagnostic:'ok'};});const graph=pool({checked:true});graph.host_tools=[contract];const state=await start(f,graph,[1]);
  assert.equal(state.nodes.pool.status,'succeeded',JSON.stringify(state.nodes.pool.error));assert.equal(turns,2);assert.equal(f.requests.length,1);assert.equal(checks,1);assert.match(prompts[1],/exactly 1 ordered items; received 2/);
  const attempt=state.nodes.pool.attempts[0];assert.equal(Object.keys(attempt.completion_checks).length,1);assert.equal(attempt.native_rejected_turns[0].category,'invalid');assert.deepEqual(state.nodes.pool.output.results,[{value:3}]);
});

test('aggregate fanout invalid semantics also consume the pinned same-session bound',async t=>{
  let turns=0;const f=await fixture(t,{resultFor:request=>request.node_id==='pool'?(turns++,{items:[{value:'invalid'}]}):{text:'review'}});const graph=pool({aggregate:true});graph.nodes.find(node=>node.id==='pool').retry.max_attempts=2;const state=await start(f,graph,[1]);assert.equal(state.nodes.pool.status,'failed');assert.equal(turns,2);assert.equal(f.requests.length,1);assert.match(state.nodes.pool.error.message,/expected integer/);
});
