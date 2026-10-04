import test from 'node:test';
import assert from 'node:assert/strict';
import { mainExecutionMode } from '../core/main-execution-mode.mjs';
import { validateWorkflowGraph } from '../core/workflow-validator.mjs';
import { workflow, agent, fixture, settle } from './fixtures.mjs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { snapshotOrchestration, orchestrationChanges } from '../lib/orchestration-audit.mjs';
import { createOwnerRpcServer, ownerRpc } from '../lib/detached-owner.mjs';
import { remoteError } from '../lib/pi-worker.mjs';
import { SEMANTIC_BLUEPRINT_CONTRACT } from '../core/authoring/blueprint-contract.mjs';
import { lowerSemanticBlueprint } from '../core/authoring/workflow-forge.mjs';
import { sourceSectionInventory } from '../core/skill-import/source-dispositions.mjs';
import { routeAgent } from '../core/skill-import/routing-rules.mjs';
const cooperative = {mode:'cooperative'}, strict = {mode:'strict'};

test('Main modes default to worker, preserve old Run context and obey frozen node decisions', () => {
  const n=agent('n',{kind:'main'});
  assert.equal(mainExecutionMode(n,cooperative),'worker');
  assert.equal(mainExecutionMode(n,cooperative,{pi_caw_main_context:'auto'}),'orchestration');
  assert.equal(mainExecutionMode(n,strict,{pi_caw_main_context:'auto'}),'worker');
  const constraints={pi_caw_main_modes:{flow:{n:'orchestration'}}};
  assert.equal(mainExecutionMode(n,cooperative,constraints,'flow'),'orchestration');
  assert.throws(()=>mainExecutionMode(n,strict,constraints,'flow'),{code:'MAIN_ORCHESTRATION_POLICY'});
});

test('graph validation rejects model bindings, non-Main mode fields and Strict orchestration', () => {
  const g=workflow([]), n=g.nodes.find(node=>node.id==='final');
  n.executor={kind:'main',mode:'worker'}; assert.equal(validateWorkflowGraph(g).valid,true);
  n.executor.mode='orchestration'; assert.equal(validateWorkflowGraph(g).valid,true);
  g.skill_policy.mode='strict'; g.skill_policy.implicit='deny'; assert(validateWorkflowGraph(g).errors.some(e=>e.code==='MAIN_ORCHESTRATION_POLICY'));
  g.skill_policy.mode='cooperative'; g.skill_policy.implicit='allow'; n.executor.model='fixed'; assert(validateWorkflowGraph(g).errors.some(e=>e.code==='MAIN_EXECUTION_MODE'));
  delete n.executor.model;n.executor.mode='auto'; assert(validateWorkflowGraph(g).errors.some(e=>e.code==='MAIN_EXECUTION_MODE'));
  n.executor={kind:'provider',provider_id:'worker',mode:'worker'};assert(validateWorkflowGraph(g).errors.some(e=>e.code==='MAIN_EXECUTION_MODE'));
});

test('one Run mixes worker and orchestration and records exact per-node receipts', async t => {
  const f=await fixture(t), g=workflow([agent('focused',{kind:'main',mode:'worker'})]);
  g.nodes.find(node=>node.id==='final').executor.mode='orchestration';
  await f.service.call('create_workflow',{workflow:g});
  const run=await f.service.call('run',{workflow_id:g.id,workspace:f.workspace,access:'read_only',inputs:{task:'Mixed Main modes'}});
  await settle(f.service,run.run_id);
  const r=await f.service.runtime.runs.read(run.run_id);
  assert.deepEqual(r.state.constraints.pi_caw_main_modes.example,{focused:'worker',final:'orchestration'});
  assert.equal(r.state.nodes.focused.attempts[0].dispatch.receipt.executor,'pi-isolated-main');
  assert.equal(r.state.nodes.final.attempts[0].dispatch.receipt.executor,'pi-current-chat-main');
  assert.deepEqual(f.mainRequests.map(q=>q.main_mode),['worker','orchestration']);
  assert.equal(r.state.status,'running','Human acceptance remains pending');
});

test('the initiating Agent selects a node mode, with invalid requests rejected before Run admission', async t => {
  const f=await fixture(t), g=workflow([]);await f.service.call('create_workflow',{workflow:g});
  await assert.rejects(f.service.call('run',{workflow_id:g.id,workspace:f.workspace,inputs:{task:'bad'},main_modes:{missing:'worker'}}),{code:'MAIN_EXECUTION_NODE'});
  assert.equal((await f.service.call('runs')).length,0);
  await assert.rejects(f.service.call('run',{workflow_id:g.id,workspace:f.root,inputs:{task:'bad workspace'},main_modes:{final:'orchestration'}}),{code:'PI_MAIN_WORKSPACE'});
  assert.equal((await f.service.call('runs')).length,0);
  const run=await f.service.call('run',{workflow_id:g.id,workspace:f.workspace,access:'read_only',inputs:{task:'Context matters'},main_modes:{final:'orchestration'}});
  await settle(f.service,run.run_id);assert.equal(f.mainRequests[0].main_mode,'orchestration');
});

test('native orchestration audits shell/helper changes without widening its write grant', async t => {
  const root=await mkdtemp(join(tmpdir(),'pi-caw-native-audit-'));t.after(()=>rm(root,{recursive:true,maxRetries:3}));
  const before=await snapshotOrchestration(root);
  await writeFile(join(root,'output.txt'),'Native helper output');
  const after=await snapshotOrchestration(root), grant={access:'bounded_write',allowed_paths:['output.txt']};
  assert.deepEqual(orchestrationChanges(before,after,grant),['output.txt']);
  assert.throws(()=>orchestrationChanges(before,after,{access:'read_only',allowed_paths:[]}),{code:'PI_ORCHESTRATION_SCOPE'});
  await writeFile(join(root,'outside.txt'),'An actual out-of-grant write');
  const outside=await snapshotOrchestration(root);
  assert.throws(()=>orchestrationChanges(before,outside,grant),error=>error.code==='PI_ORCHESTRATION_SCOPE'&&error.outside_paths.includes('outside.txt'));
});

test('the parent RPC preserves application validation failures and distinguishes real disconnection', async t => {
  const server=await createOwnerRpcServer({run_id:'mode-rpc',handle:async()=>{throw Object.assign(new Error('Audit schema rejects this field'),{code:'EVENT_METADATA'});}});
  t.after(()=>server.close());
  await assert.rejects(ownerRpc(server.descriptor,'test',{}),error=>{
    const classified=remoteError(error);
    return classified===error&&classified.code==='EVENT_METADATA'&&classified.rpc_application_error===true;
  });
  const transport=remoteError(Object.assign(new Error('Connection refused'),{code:'ECONNREFUSED'}));
  assert.equal(transport.code,'PI_PARENT_MAIN_DISCONNECTED');assert.equal(transport.quiescent,false);
});

test('Main profiles preserve node modes through Forge and both routing choices',()=>{
  const resources={'source/SKILL.md':Buffer.from('# Focus\n\nPrepare a focused observation, then integrate it using the current conversation.\n')};
  const ids=sourceSectionInventory(resources).map(s=>s.section_id);
  const activities=['main_read','orchestration_read'].map((profile,i)=>({key:`step_${i}`,profile,tool:'',source_sections:ids,instructions:i?'Integrate the observation with current conversation decisions.':'Prepare a concise observation.',inputs:[],outputs:[{name:'observation',kind:'text',type_ref:'',values:[]}]}));
  const plan={contract:SEMANTIC_BLUEPRINT_CONTRACT,purpose:'Focus then integrate',source_dispositions:ids.map(section_id=>({section_id,disposition:'workflow',activity_keys:['step_0','step_1'],note:'Focused work and contextual integration'})),requirement_assignments:[],records:[],lists:[],enums:[],activities,approvals:[],sequences:[{key:'sequence',members:['step_0','step_1'],failure_meaning:'all_required'}],parallels:[],choices:[]};
  for(const selection_mode of ['automatic','fixed']){
    const routing_rules={selection_mode,routes:{}};
    const ir=lowerSemanticBlueprint({workflow:{id:'modes',requirements:{}}},resources,plan,{routing_rules});
    assert.deepEqual(ir.nodes.filter(n=>n.type==='agent').map(n=>routeAgent(n,routing_rules,[]).executor),[{kind:'main',mode:'worker'},{kind:'main',mode:'orchestration'}]);
  }
});
