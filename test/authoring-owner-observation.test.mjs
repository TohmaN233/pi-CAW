import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture, binding, settle } from './fixtures.mjs';
import { DEFAULT_PROVIDER_SLOTS, BUILTIN_ROLE_DEFAULTS, DEFAULT_ROUTING } from '../lib/defaults.mjs';
import { SEMANTIC_BLUEPRINT_CONTRACT } from '../core/authoring/blueprint-contract.mjs';
import { sourceSectionInventory } from '../core/skill-import/source-dispositions.mjs';
import { reviewIds } from '../core/skill-import/review-checklist.mjs';
import { canonicalJSON, digest } from '../core/workflow-revisions.mjs';

async function authoring(t,error) {
  let plan;
  const f=await fixture(t,{resultFor:request=>{
    if(request.node_id==='expand')return {proposal:structuredClone(plan)};
    if(request.node_id==='final')return {checks:reviewIds().map(()=>({status:'pass',evidence:'The exact source contract is preserved in the compiled answer activity.'}))};
    throw new Error(`Unexpected offline dispatch ${request.node_id}`);
  }});
  const settings=await f.service.call('settings');
  await f.service.call('save_settings',{expected_revision:settings.revision,settings:{schema_version:1,
    providers:DEFAULT_PROVIDER_SLOTS.map(provider=>({...provider,binding:{...binding}})),roles:structuredClone(BUILTIN_ROLE_DEFAULTS),routing:structuredClone(DEFAULT_ROUTING)}},{human:true});
  const pack=await f.service.call('build_workflow',{workflow_id:'owner-observation-source',name:'Owner observation',brief:'# Workflow\n\nRead the supplied task and return a concise supported answer.',provider_id:'pi-worker'},{human:true});
  const sections=sourceSectionInventory(await f.service.store.resources(pack.workflow.id,pack.revision_hash)).map(section=>section.section_id);
  plan={contract:SEMANTIC_BLUEPRINT_CONTRACT,purpose:'Answer the supplied task from supported evidence.',
    source_dispositions:sections.map(section_id=>({section_id,disposition:'workflow',activity_keys:['answer'],note:'The answer activity implements this source instruction.'})),requirement_assignments:[],runtime_dependencies:[],records:[],lists:[],enums:[],
    activities:[{key:'answer',instructions:'Read the supplied task and return a concise supported answer.',profile:'worker_read',source_sections:sections,inputs:[{name:'task',from:'input:task'}],outputs:[{name:'answer',kind:'text',values:[],type_ref:''}],tool:''}],approvals:[],sequences:[],parallels:[],choices:[]};
  if(error){const prepare=f.service.workbench.authoring.prepare.bind(f.service.workbench.authoring);f.service.workbench.authoring.prepare=async(runId,nodeId,authority)=>{if(nodeId==='final')throw Object.assign(new Error(error.message),{code:error.code});return prepare(runId,nodeId,authority);};}
  const started=await f.service.call('start_authoring',{workflow_id:pack.workflow.id,revision_hash:pack.revision_hash,run_id:'owner-observation'},{human:true});
  await settle(f.service,started.run_id);
  return {...f,started,workerPath:join(f.service.runtime.runs.directory(started.run_id),'pi-worker.json')};
}

test('an actual stopped detached owner exposes its settled schema error instead of healthy reviewing and leaves journals unchanged',async t=>{
  const f=await authoring(t,{code:'PI_CAW_EXECUTION',message:'$: unexpected property: description'}),runId=f.started.run_id;
  const record=await f.service.runtime.runs.read(runId);assert.equal(record.state.status,'running');assert.equal(record.state.nodes.final.status,'ready');assert.equal(f.service.active.has(runId),false);
  const actualWorker=JSON.parse(await readFile(f.workerPath,'utf8'));assert.equal(actualWorker.status,'attention');assert.ok(actualWorker.settled_at);
  const owner=await f.service.detachedOwners.launch({run_id:runId,controller_hash:record.state.control_hash,main_actor:record.state.main_actor,
    controller_journal:join(f.service.runtime.runs.directory(runId),'events.jsonl'),runtime_entry:fileURLToPath(new URL('./fixtures/settled-authoring-owner.mjs',import.meta.url)),
    boot:{run_directory:f.service.runtime.runs.directory(runId),error:actualWorker.error}});
  const stopped=await f.service.detachedOwners.stop(runId,'offline_observation_check');assert.equal(stopped.owner_id,owner.owner_id);assert.equal(stopped.termination.confirmed,true);
  const beforeWorker=await readFile(f.workerPath),beforeOwner=await readFile(f.service.detachedOwners.paths(runId).status),beforeRun=await f.service.runtime.runs.read(runId);
  const observed=await f.service.call('advance_authoring',{run_id:runId});
  assert.equal(observed.phase,'attention');assert.equal(observed.status,'attention');assert.equal(observed.run_status,'running');assert.deepEqual(observed.error,actualWorker.error);
  assert.equal(observed.worker.owner_id,owner.owner_id);assert.equal(observed.worker.journal_sha256,digest(beforeWorker));assert.equal(observed.worker.owner_journal_sha256,digest(beforeOwner));
  assert.deepEqual(await readFile(f.workerPath),beforeWorker);assert.deepEqual(await readFile(f.service.detachedOwners.paths(runId).status),beforeOwner);
  assert.equal((await f.service.runtime.runs.read(runId)).sequence,beforeRun.sequence);assert.equal(f.mainRequests.length,0);
});

test('a settled in-process semantic repair error remains observable even while the final node is ready',async t=>{
  const f=await authoring(t,{code:'GENERATION_REPAIR_SCOPE',message:'Semantic repair cannot remove unrelated requirement req_teacher_approval'});
  const observed=await f.service.call('advance_authoring',{run_id:f.started.run_id});assert.equal(observed.phase,'attention');assert.match(observed.error.message,/Semantic repair cannot remove unrelated requirement req_teacher_approval/);
});

test('a legitimate settled reviewer result awaiting human acceptance still presents the normal exact review',async t=>{
  const f=await authoring(t),worker=JSON.parse(await readFile(f.workerPath,'utf8'));assert.equal(worker.status,'awaiting_acceptance');assert.ok(worker.settled_at);
  const observed=await f.service.call('advance_authoring',{run_id:f.started.run_id});assert.equal(observed.phase,'review_required');assert.ok(observed.proposal_sha256);assert.equal(observed.error,undefined);
});

test('foreign worker identity, oversized or unreadable journals and detached signature mismatches fail visibly',async t=>{
  const f=await authoring(t,{code:'PI_CAW_EXECUTION',message:'Exact stopped owner failure'}),runId=f.started.run_id,original=await readFile(f.workerPath),worker=JSON.parse(original);
  for(const patch of [{run_id:'foreign-run'},{session_id:'foreign-chat'},{status:'invented-status'},{settled_at:'invalid-time'}]){
    await writeFile(f.workerPath,canonicalJSON({...worker,...patch}));await assert.rejects(f.service.workbench.authoring.observe({run_id:runId}),{code:'AUTHORING_OWNER_IDENTITY'});
  }
  await writeFile(f.workerPath,Buffer.alloc(128*1024+1,32));await assert.rejects(f.service.workbench.authoring.observe({run_id:runId}),{code:'AUTHORING_OWNER_JOURNAL'});
  await writeFile(f.workerPath,'{');await assert.rejects(f.service.workbench.authoring.observe({run_id:runId}),SyntaxError);
  await writeFile(f.workerPath,original);
  const record=await f.service.runtime.runs.read(runId),paths=f.service.detachedOwners.paths(runId);await mkdir(paths.directory,{recursive:true});
  await writeFile(paths.status,canonicalJSON({schema_version:1,run_id:runId,main_actor:record.state.main_actor,controller_hash:digest('foreign-controller'),owner_id:'12345678-1234-1234-1234-123456789abc',revision:1,generation:1,pid:worker.process_id,started_at:worker.started_at,phase:'stopped'}));
  await assert.rejects(f.service.workbench.authoring.observe({run_id:runId}),{code:'AUTHORING_OWNER_IDENTITY'});
});
