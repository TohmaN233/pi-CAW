import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, binding, settle } from './fixtures.mjs';
import { DEFAULT_PROVIDER_SLOTS, BUILTIN_ROLE_DEFAULTS, DEFAULT_ROUTING } from '../lib/defaults.mjs';
import { SEMANTIC_BLUEPRINT_CONTRACT, SEMANTIC_REPAIR_CONTRACT } from '../core/authoring/blueprint-contract.mjs';
import { AUTHORING_REVIEW_INPUTS_RESOURCE, authoringReviewIdentity } from '../core/authoring/authoring-workflows.mjs';
import { sourceSectionInventory } from '../core/skill-import/source-dispositions.mjs';
import { reviewIds } from '../core/skill-import/review-checklist.mjs';
import { canonicalJSON, digest } from '../core/workflow-revisions.mjs';
import { CURRENT_AUTHORING_SEMANTIC_BLUEPRINT_SCHEMA } from '../core/authoring/blueprint-contract.mjs';
import { PiCawService } from '../lib/service.mjs';
import { AUTHORING_PLANNER_PROMPT_V27,AUTHORING_PLANNER_PROMPT_V28,AUTHORING_REVIEW_PROMPT_V24,AUTHORING_REVIEW_PROMPT_V25 } from '../core/authoring/authoring-workflows.mjs';
import { validateAuthoringSourceRefresh } from '../lib/authoring.mjs';
import { observedSourceRequirements } from '../core/skill-import/source-requirements.mjs';
import { validateRepairTargets } from '../core/skill-import/generation-repair.mjs';
import { sourceContractMap } from '../core/skill-import/source-contracts.mjs';
import { validateGenerationProposal } from '../core/skill-import/proposal-validation.mjs';
import { generationRetryClass, semanticGenerationRepair } from '../core/skill-import/generation-retry-policy.mjs';
import { normalizeSemanticBlueprint } from '../core/authoring/blueprint-contract.mjs';
import { validateData } from '../core/workflow-data-schema.mjs';
import { EXPANSION_PROPOSAL_SCHEMA } from '../core/skill-import/expansion-run.mjs';

const fixtureTool = () => ({ id: 'fixture-tool', identity: { name: 'fixture-tool', version: '1', sha256: 'a'.repeat(64) },
  argv: ['fixture'], input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  output_schema: { type: 'object', properties: { base: { type: 'string' } }, required: ['base'], additionalProperties: false },
  env_allow: [], permissions: { network: false, read_paths: ['.'], write_paths: [] }, output_cap_bytes: 131072,
  deadline_ms: 5000, idempotency: { mode: 'safe' } });

// This fixture persists a completed planner artifact without dispatching any
// model, as a paused retained authoring attempt would supply to recheck.
async function retainPlanner(f, output, id) {
  const started = await f.service.workbench.authoring.start({ workflow_id: f.pack.workflow.id, revision_hash: f.pack.revision_hash, run_id: id }, { launch: false });
  const runtime = f.service.runtime, control = { control_token: started.control_token }, state = await runtime.get(id);
  const lease = await runtime.claimNode(id, { ...control, node_id: 'expand', owner: state.main_actor, request_id: 'fixture-retained' });
  const dispatch = { ...control, ...lease, request_id: 'fixture-retained', envelope_hash: digest(canonicalJSON(output)) };
  await runtime.recordDispatchIntent(id, dispatch);
  await runtime.recordDispatchReceipt(id, { ...dispatch, receipt: { task_id: 'fixture', invocation_id: lease.attempt_id, executor: 'fixture-planner' } });
  const completion = { status: 'succeeded', summary: 'Retained fixture planner', structured_output: output, artifacts: [], changed_paths: [], outside_paths: [], evidence: [{ kind: 'fixture_retained_planner' }] };
  const durable = await runtime.runs.saveExecutorResult(id, lease.attempt_id, completion);
  await runtime.recordExecutorEvent(id, { ...control, ...lease, event: { kind: 'result_proposed', metadata: { ...durable, final_acceptance_required: false } } });
  await runtime.recordExecutorEvent(id, { ...control, ...lease, event: { kind: 'session_state', metadata: { status: 'closed' } } });
  await runtime.completeNode(id, { ...lease, completion });
  return started;
}

async function authoringFixture(t, { plannerResult, reviewResult, sourceSchema, brief = '# Workflow\n\n## Process\n\nRead the supplied task and return a concise supported answer.' } = {}) {
  let plan, plannerCalls = 0, reviewCalls = 0;
  const f = await fixture(t, { resultFor: request => {
    if (request.node_id === 'expand') return plannerResult?.(structuredClone(plan), ++plannerCalls) ?? { proposal: structuredClone(plan) };
    if (request.node_id === 'final') {
      const review = { checks: reviewIds().map(() => ({ status: 'pass', evidence: 'The compiled activity preserves the pinned source instructions and declared answer handoff.' })) };
      return reviewResult?.(review, ++reviewCalls) ?? review;
    }
    throw new Error(`Unexpected model dispatch: ${request.node_id}`);
  } });
  const current = await f.service.call('settings');
  await f.service.call('save_settings', { expected_revision: current.revision, settings: {
    schema_version: 1, providers: DEFAULT_PROVIDER_SLOTS.map(provider => ({ ...provider, binding: { ...binding } })),
    roles: structuredClone(BUILTIN_ROLE_DEFAULTS), routing: structuredClone(DEFAULT_ROUTING),
  } }, { human: true });
  let pack = await f.service.call('build_workflow', { workflow_id: 'authoring-source', name: 'Answer workflow',
    brief, provider_id: 'pi-worker' }, { human: true });
  const resources = await f.service.store.resources(pack.workflow.id, pack.revision_hash);
  if(sourceSchema){
    resources['source/author-result.schema.json']=Buffer.from(JSON.stringify(sourceSchema));
    pack=await f.service.store.save(pack.workflow.id,pack.workflow,{expected_revision:pack.revision_hash,resources});
  }
  const sections = sourceSectionInventory(resources).map(section => section.section_id);
  plan = { contract: SEMANTIC_BLUEPRINT_CONTRACT, purpose: 'Answer the supplied task from supported evidence.',
    source_dispositions: sections.map(section_id => ({ section_id, disposition: 'workflow', activity_keys: ['answer'], note: 'The source process is implemented by the answer activity.' })),
    requirement_assignments: [], runtime_dependencies: [], records: [], lists: [], enums: [],
    activities: [{ key: 'answer', instructions: 'Read the supplied task and return a concise supported answer.', profile: 'worker_read',
      source_sections: sections, inputs: [{ name: 'task', from: 'input:task' }], outputs: [{ name: 'answer', kind: 'text', values: [], type_ref: '' }], tool: '' }],
    approvals: [], sequences: [], parallels: [], choices: [] };
  if(sourceSchema){
    const contract=[...sourceContractMap(resources).values()].find(item=>item.json_pointer==='');
    plan.activities[0].outputs=[{name:'result',kind:'object',type_ref:'',values:[],contract_ref:contract.contract_id}];
    plan.activities.push({key:'assess',instructions:'Assess the newly authored semantic draft and empty artifact list.',profile:'worker_read',source_sections:sections,inputs:[{name:'draft',from:'answer.result.draft'},{name:'files',from:'answer.result.files'}],outputs:[{name:'assessment',kind:'text',type_ref:'',values:[]}],tool:''});
    plan.source_dispositions.forEach(item=>item.activity_keys.push('assess'));
    plan.sequences=[{key:'process',members:['answer','assess'],failure_meaning:'all_required'}];
  }
  return { ...f, pack, plan };
}

const schemaRecord=(properties,required=Object.keys(properties))=>({type:'object',additionalProperties:false,properties,required});
const semanticResultSchema={...schemaRecord({
  draft:schemaRecord({
    summary:{type:'string',minLength:1,maxLength:4096},notes:{type:'string',maxLength:20000},
    segments:{type:'array',maxItems:48,items:schemaRecord({
      checkForUnderstanding:{type:'string',description:'State a short question or observable check of learner understanding.',minLength:1,maxLength:4096},
      revisits:{type:'array',maxItems:100,items:schemaRecord({concept:{type:'string',minLength:1,maxLength:4096},progression:{enum:['complexity','transfer']}},['concept'])},
    },['checkForUnderstanding'])},
  },['summary']),
  files:{type:'array',minItems:0,maxItems:0,items:schemaRecord({path:{type:'string',maxLength:4096},format:{enum:['tex','Rmd']}},['path'])},
}),description:'An exact bounded semantic result.'};

test('shared proposal admission qualifies nested source schemas for initial plans and targeted repair artifacts before Forge',async t=>{
  const f=await authoringFixture(t,{sourceSchema:semanticResultSchema}),started=await retainPlanner(f,{proposal:f.plan},'schema-admission-retained');
  const record=await f.service.runtime.runs.read(started.run_id),resources=await f.service.store.resources(f.pack.workflow.id,f.pack.revision_hash),options={pack:f.pack,resources,provenance:record.pins.root.provenance,context:f.service.runtime.context};
  const before=canonicalJSON(f.plan),initial=validateGenerationProposal({proposal:f.plan},options),author=initial.compiled.workflow.nodes.find(node=>node.id===initial.proposal.nodes.find(item=>item.semantic_key==='answer').id);
  assert.deepEqual(author.outputs_schema.properties.result,semanticResultSchema);
  validateData(initial.proposal,EXPANSION_PROPOSAL_SCHEMA);
  const projected=validateGenerationProposal({proposal:initial.proposal,host_pipeline:initial.pipeline_trace},options);
  assert.deepEqual(projected.proposal,initial.proposal);
  const corruptedProjection=structuredClone(initial.proposal);corruptedProjection.nodes.find(node=>node.semantic_key==='answer').outputs_schema.properties.result.properties.draft.properties.summary.maxLength=1;
  assert.throws(()=>validateGenerationProposal({proposal:corruptedProjection,host_pipeline:initial.pipeline_trace},options),error=>error.code==='GENERATION_PROJECTION_CONFLICT'&&semanticGenerationRepair(error)===false);
  for(const description of [true,'x'.repeat(16001)]){
    const invalid=structuredClone(initial.proposal);invalid.nodes.find(node=>node.semantic_key==='answer').outputs_schema.properties.result.properties.draft.properties.segments.items.properties.checkForUnderstanding.description=description;
    assert.throws(()=>validateData(invalid,EXPANSION_PROPOSAL_SCHEMA),error=>error.code==='DATA_INVALID'&&generationRetryClass(error)==='mechanical');
  }
  assert.throws(()=>normalizeSemanticBlueprint(f.plan),error=>error.code==='AUTHORING_FORMAT'&&semanticGenerationRepair(error)===false);
  assert.equal(canonicalJSON(f.plan),before);
  const hostPlan=structuredClone(f.plan),host=fixtureTool();host.output_schema=schemaRecord({baseline:schemaRecord({courseGoal:{type:'string',minLength:1,maxLength:4000}})});
  hostPlan.activities.unshift({key:'selected_context',instructions:'Read the selected context through the registered Host.',profile:'main_read',tool:host.id,source_sections:hostPlan.activities[0].source_sections,inputs:[],outputs:[{name:'baseline',kind:'object',type_ref:'',values:[]}]});
  hostPlan.activities[1].inputs.push({name:'goal',from:'selected_context.baseline.courseGoal'});
  hostPlan.source_dispositions.forEach(item=>item.activity_keys.push('selected_context'));hostPlan.sequences[0].members.unshift('selected_context');
  const hostQualified=validateGenerationProposal({proposal:hostPlan},{...options,pack:{...f.pack,workflow:{...f.pack.workflow,host_tools:[host]}},context:{...options.context,host_tool_contracts:[host]}});
  assert.deepEqual(hostQualified.proposal.nodes.find(node=>node.semantic_key==='selected_context').outputs_schema,host.output_schema);
  assert.ok(hostQualified.proposal.nodes.find(node=>node.semantic_key==='answer').input_bindings.goal.endsWith('/baseline/courseGoal'));
  const empty={source_dispositions:[],requirement_assignments:[],runtime_dependencies:[],records:[],lists:[],enums:[],activities:[],approvals:[],sequences:[],parallels:[],choices:[]};
  const changed=structuredClone(f.plan.activities[1]);changed.instructions='Assess the new draft for clarity.';
  const repaired=validateGenerationProposal({proposal:{contract:SEMANTIC_REPAIR_CONTRACT,purpose:'',upsert:{...empty,activities:[changed]},remove:empty}},{...options,previousPlan:f.plan,repairFeedback:{findings:[{semantic_keys:['assess'],affected_semantic_fields:['activities.assess.instructions']}]}});
  assert.deepEqual(repaired.compiled.workflow.nodes.find(node=>node.id===repaired.proposal.nodes.find(item=>item.semantic_key==='answer').id).outputs_schema.properties.result,semanticResultSchema);
  validateData(repaired.proposal,EXPANSION_PROPOSAL_SCHEMA);
  assert.equal(repaired.authoring_plan.activities.find(item=>item.key==='assess').instructions,changed.instructions);
  assert.equal(f.requests.length,0);
});

test('retained Run recheck reuses a full pinned semantic schema plan without planner calls or semantic repair attempts',{timeout:20000},async t=>{
  const reviewDispatched=Promise.withResolvers();
  const f=await authoringFixture(t,{sourceSchema:semanticResultSchema,reviewResult:review=>{reviewDispatched.resolve();return review;}}),started=await retainPlanner(f,{proposal:f.plan},'schema-retained');
  const source=await f.service.runtime.runs.read(started.run_id),originalHash=source.state.nodes.expand.attempts[0].result_proposal.sha256;
  const replay=await f.service.call('recheck_authoring',{source_run_id:started.run_id,run_id:'schema-recheck',allow_semantic_repair:true},{human:true});
  await settle(f.service,replay.run_id);
  let progress=await f.service.call('advance_authoring',{run_id:replay.run_id});
  if(progress.phase==='reviewing'){await reviewDispatched.promise;await settle(f.service,replay.run_id);progress=await f.service.call('advance_authoring',{run_id:replay.run_id});}
  const record=await f.service.runtime.runs.read(replay.run_id);
  assert.equal(progress.phase,'review_required',JSON.stringify(progress));
  assert.deepEqual(f.requests.map(request=>request.node_id),['final']);
  assert.equal(record.state.nodes.expand.attempts.length,1);
  assert.equal(record.state.nodes.expand.attempts[0].dispatch.receipt.executor,'host-generation-replay');
  assert.equal(record.state.nodes.expand.attempts[0].dispatch.receipt.source_result_sha256,originalHash);
  assert.equal(record.state.generation_repair,undefined);
  assert.deepEqual(record.state.generation_projection.authoring_plan,f.plan);
});

test('public recheck materializes exact initial/patch semantic projections before stale ledgers or changed repair bases, preserving original hashes',async t=>{
  for(const patch of [false,true]){
    const f=await authoringFixture(t),empty={source_dispositions:[],requirement_assignments:[],runtime_dependencies:[],records:[],lists:[],enums:[],activities:[],approvals:[],sequences:[],parallels:[],choices:[]};
    const output=patch?{proposal:{contract:SEMANTIC_REPAIR_CONTRACT,purpose:'',upsert:empty,remove:empty}}:{proposal:f.plan};
    const started=await retainPlanner(f,output,patch?'projected-patch':'projected-initial'),prior=await f.service.runtime.runs.read(started.run_id),attempt=prior.state.nodes.expand.attempts[0];
    const rawHash=digest(canonicalJSON(output)),projected=structuredClone(f.plan),stale=structuredClone(f.plan);
    projected.activities[0].instructions='Explain the supplied task clearly using its supported evidence.';stale.activities[0].instructions='Return an older explanation.';
    await f.service.runtime.transition(started.run_id,'generation_projection',state=>{
      state.generation_projection={source_attempt_id:attempt.id,source_output_hash:rawHash,authoring_plan:projected};
      state.generation_repair={previous_proposal:{contract:'changed-base'},latest_cumulative_plan:{attempt_id:attempt.id},
        plan_ledger:[{attempt_id:attempt.id,output_hash:rawHash,proposal:stale}]};
    },{expected_sequence:prior.sequence});
    // Hold the isolated fixture driver: this test exercises replay selection,
    // not a planner/reviewer dispatch or any existing user Run.
    f.service.launchDriver=async()=>{};
    const sourceBefore=await f.service.runtime.runs.read(started.run_id),replayed=await f.service.call('recheck_authoring',
      {source_run_id:started.run_id,source_attempt_id:attempt.id,run_id:'exact-projected-recheck'},{human:true});
    assert.equal(replayed.recheck.semantic_source,'exact_semantic_projection');assert.equal(replayed.recheck.result_sha256,attempt.result_proposal.sha256);
    const target=await f.service.runtime.runs.read(replayed.run_id);
    assert.deepEqual(target.state.nodes.expand.output,{proposal:projected});
    assert.equal(target.state.nodes.expand.attempts[0].dispatch.receipt.source_result_sha256,attempt.result_proposal.sha256);
    assert.equal((await f.service.runtime.runs.read(started.run_id)).sequence,sourceBefore.sequence);
    const verified=await f.service.runtime.runs.readExecutorResult(started.run_id,attempt.id,attempt.result_proposal.sha256);
    assert.equal(digest(canonicalJSON(verified.structured_output)),rawHash);
    const current=await f.service.runtime.runs.read(started.run_id);
    await f.service.runtime.transition(started.run_id,'generation_projection',state=>{state.generation_projection.source_output_hash=digest('wrong original');},{expected_sequence:current.sequence});
    await assert.rejects(f.service.call('recheck_authoring',{source_run_id:started.run_id,run_id:'projection-conflict-must-not-start'},{human:true}),{code:'GENERATION_PROJECTION_CONFLICT'});
    await assert.rejects(access(f.service.runtime.runs.directory('projection-conflict-must-not-start')),{code:'ENOENT'});
    assert.equal(f.requests.length,0);assert.equal(f.mainRequests.length,0);
  }
});

test('malformed pinned schema is a mechanical admission failure and cannot release Run or semantic repair attempts',async t=>{
  const f=await authoringFixture(t,{sourceSchema:semanticResultSchema}),started=await retainPlanner(f,{proposal:f.plan},'schema-valid-retained'),record=await f.service.runtime.runs.read(started.run_id),resources=await f.service.store.resources(f.pack.workflow.id,f.pack.revision_hash);
  resources['source/author-result.schema.json']=Buffer.from('{ broken');
  assert.throws(()=>validateGenerationProposal({proposal:f.plan},{pack:f.pack,resources,provenance:record.pins.root.provenance,context:f.service.runtime.context}),error=>{
    assert.equal(error.code,'SOURCE_CONTRACT_SCHEMA');assert.equal(generationRetryClass(error),'mechanical');assert.equal(semanticGenerationRepair(error),false);return true;
  });
  f.pack=await f.service.store.save(f.pack.workflow.id,f.pack.workflow,{expected_revision:f.pack.revision_hash,resources});
  await assert.rejects(f.service.workbench.authoring.start({workflow_id:f.pack.workflow.id,revision_hash:f.pack.revision_hash,run_id:'schema-corrupt-start'},{launch:false}),error=>{
    assert.equal(error.code,'SOURCE_CONTRACT_SCHEMA');assert.equal(generationRetryClass(error),'mechanical');assert.equal(semanticGenerationRepair(error),false);return true;
  });
  await assert.rejects(access(f.service.runtime.runs.directory('schema-corrupt-start')),{code:'ENOENT'});
  assert.equal((await f.service.runtime.runs.read(started.run_id)).state.nodes.expand.attempts.length,1);
  assert.equal(f.requests.length,0);
});

async function reviewed(f, id = 'authoring-first', extra = {}) {
  const started = await f.service.call('start_authoring', { workflow_id: f.pack.workflow.id, revision_hash: f.pack.revision_hash, run_id: id, ...extra }, { human: true });
  await settle(f.service, started.run_id);
  const progress = await f.service.call('advance_authoring', { run_id: started.run_id });
  assert.equal(progress.phase, 'review_required', JSON.stringify(f.notifications));
  return { started, progress };
}

test('Pi authoring runs planner, Host compiler and independent review before exact human publication and cleanup', async t => {
  const f = await authoringFixture(t);
  const preview=await f.service.call('authoring_prompt_preview',{workflow_id:f.pack.workflow.id,revision_hash:f.pack.revision_hash});
  assert.deepEqual(preview.output_schemas.expand.properties.proposal,CURRENT_AUTHORING_SEMANTIC_BLUEPRINT_SCHEMA);
  const { started, progress } = await reviewed(f);
  const record = await f.service.runtime.runs.read(started.run_id), identity = authoringReviewIdentity(record);
  assert.deepEqual(f.requests.map(request => request.node_id), ['expand', 'final']);
  assert.deepEqual(f.requests[0].schema.properties.proposal, CURRENT_AUTHORING_SEMANTIC_BLUEPRINT_SCHEMA);
  assert.equal(f.mainRequests.length, 0);
  for (const stage of ['expand', 'graph_assembly', 'execution_binding', 'deterministic_validation']) assert.equal(record.state.nodes[stage].status, 'succeeded');
  assert.equal(record.state.nodes.final.status, 'running');
  const finalAttempt = record.state.nodes.final.attempts.at(-1);
  assert.equal(finalAttempt.dispatch.receipt.executor, 'pi-sdk-authoring-review');
  assert.deepEqual(finalAttempt.dispatch.receipt.authoring_review_context, identity);
  assert.equal(progress.canonical_proposal_hash, digest(canonicalJSON(progress.proposal)));
  const reviewRequest = f.requests.find(request => request.node_id === 'final');
  assert.ok(reviewRequest.resources.some(resource => resource.sha256 === identity.proposal_hash));
  assert.ok(reviewRequest.resources.some(resource => resource.path === AUTHORING_REVIEW_INPUTS_RESOURCE));
  const factResource=reviewRequest.resources.find(resource=>resource.path==='__authoring__/review-facts.json');
  assert.ok(factResource);
  const facts=JSON.parse(await readFile(factResource.object_path,'utf8'));
  assert.equal(facts.proposal_hash,identity.proposal_hash);
  assert.equal((await f.service.store.snapshot(f.pack.workflow.id)).revision_hash, f.pack.revision_hash);
  await assert.rejects(f.service.call('accept_authoring', { run_id: started.run_id, accepted: true, proposal_sha256: '0'.repeat(64) }, { human: true }), { code: 'PI_FINAL_CHANGED' });
  assert.equal((await f.service.runtime.runs.read(started.run_id)).sequence, record.sequence);
  const deployed = await f.service.call('accept_authoring', { run_id: started.run_id, workflow_id: f.pack.workflow.id,
    expected_revision: f.pack.revision_hash, accepted: true, proposal_sha256: progress.proposal_sha256 }, { human: true });
  assert.equal(deployed.provenance.kind, 'workflow_conversion');
  assert.equal(deployed.provenance.conversion.proposal_hash, identity.proposal_hash);
  assert.equal(deployed.workflow.import_status.source_independent, true);
  assert.equal(deployed.authoring_cleanup.private_authoring_artifacts_purged, true);
  assert.deepEqual(deployed.authoring_cleanup.cleanup_transaction.steps, { library: true, workspace: true, job: true, run: true });
  assert.equal((await f.service.store.revisions(f.pack.workflow.id)).length, 1);
  await assert.rejects(f.service.runtime.runs.read(started.run_id), { code: 'ENOENT' });
  await assert.rejects(access(join(f.service.directory, 'authoring-workspaces', started.run_id)), { code: 'ENOENT' });
  const retry = await f.service.workbench.authoring.purge({ run_id: started.run_id, workflow_id: f.pack.workflow.id, control_token: started.control_token });
  assert.equal(retry.cleanup_transaction.status, 'complete');
});

test('authoring recheck replays durable planner output and executes a fresh compiler and independent reviewer', async t => {
  const f = await authoringFixture(t), { started } = await reviewed(f);
  const before = await f.service.runtime.runs.read(started.run_id), prior = before.state.nodes.expand.attempts.at(-1);
  const rechecked = await f.service.call('recheck_authoring', { source_run_id: started.run_id, run_id: 'authoring-recheck' }, { human: true });
  assert.equal(rechecked.recheck.planner_invoked, false);
  assert.equal(rechecked.recheck.result_sha256, prior.result_proposal.sha256);
  await settle(f.service, rechecked.run_id);
  const progress = await f.service.call('advance_authoring', { run_id: rechecked.run_id });
  assert.equal(progress.phase, 'review_required', JSON.stringify(f.notifications));
  assert.equal(f.requests.filter(request => request.node_id === 'expand').length, 1);
  assert.equal(f.requests.filter(request => request.node_id === 'final').length, 2);
  const record = await f.service.runtime.runs.read(rechecked.run_id), replay = record.state.nodes.expand.attempts.at(-1);
  assert.equal(replay.dispatch.receipt.executor, 'host-generation-replay');
  assert.equal(replay.dispatch.receipt.source_result_sha256, prior.result_proposal.sha256);
  assert.ok(replay.result_proposal?.sha256);
  assert.deepEqual(record.state.generation_projection.authoring_plan, f.plan);
  for (const stage of ['graph_assembly', 'execution_binding', 'deterministic_validation']) {
    assert.equal(record.state.nodes[stage].status, 'succeeded');
    assert.equal(record.state.nodes[stage].output.proposal_hash, progress.canonical_proposal_hash);
  }
  await assert.rejects(f.service.call('accept_authoring', { run_id: rechecked.run_id, accepted: true,
    proposal_sha256: progress.proposal_sha256, expected_revision: f.pack.revision_hash }, { human: true }),
  { code: 'AUTHORING_PURGE_INCOMPLETE', cause_code: 'AUTHORING_CLEANUP_CONFLICT' });
  assert.equal((await f.service.store.snapshot(f.pack.workflow.id)).provenance.kind, 'workflow_conversion');
  assert.equal((await f.service.runtime.runs.read(rechecked.run_id)).state.status, 'succeeded');
  await f.service.call('cancel', { run_id: started.run_id }, { human: true });
  const cleaned = await f.service.workbench.authoring.purge({ run_id: rechecked.run_id, workflow_id: f.pack.workflow.id,
    control_token: rechecked.control_token });
  assert.equal(cleaned.cleanup_transaction.status, 'complete');
});

test('review-only replay keeps semantic repair disabled after independent review and compiler errors', async t => {
  const f = await authoringFixture(t, { reviewResult: review => {
    review.checks[reviewIds().indexOf('method_fidelity')] = { status:'fail', evidence:'The answer phase omits the prescribed explanation method.' };
    return review;
  } });
  const started = await retainPlanner(f, {proposal:f.plan}, 'review-only-retained');
  const replay = await f.service.call('recheck_authoring', {source_run_id:started.run_id,run_id:'review-only-no-repair',allow_semantic_repair:false}, {human:true});
  await settle(f.service,replay.run_id);
  const record = await f.service.runtime.runs.read(replay.run_id);
  assert.equal(record.state.nodes.expand.attempts.length,1);
  assert.equal(f.requests.filter(request=>request.node_id==='expand').length,0);
  assert.equal(f.requests.filter(request=>request.node_id==='final').length,1);
  assert.equal(await f.service.workbench.authoring.automaticSemanticRepairAllowed(record),false);
  await assert.rejects(f.service.workbench.authoring.afterReview(replay.run_id,{control_token:replay.control_token}),{code:'GENERATION_RECHECK_REVIEW_FINDINGS'});
  const error=Object.assign(new Error('Semantic compilation defect'),{code:'AUTHORING_SEMANTIC',findings:[{kind:'semantic',semantic_keys:['answer'],affected_semantic_fields:['activities.instructions'],message:'Missing method'}]});
  await assert.rejects(f.service.workbench.authoring.repairFailure(replay.run_id,{control_token:replay.control_token},error),failure=>failure===error);
  assert.equal((await f.service.runtime.runs.read(replay.run_id)).state.nodes.expand.attempts.length,1);
});

test('explicit additive Host contract refresh replays retained meaning with both exact identities recorded', async t => {
  const f = await authoringFixture(t), seed = structuredClone(f.pack.workflow);
  seed.host_tools = [fixtureTool()];
  f.pack = await f.service.store.save(seed.id, seed, { expected_revision: f.pack.revision_hash });
  const old = f.pack, started = await retainPlanner(f, { proposal: f.plan }, 'contract-retained');
  const next = structuredClone(old.workflow); next.host_tools[0].identity.sha256 = 'b'.repeat(64);
  next.host_tools[0].output_schema.properties.note = { type: 'string' };
  const selected = await f.service.store.save(next.id, next, { expected_revision: old.revision_hash });
  f.service.runtime.context.host_tool_contracts = selected.workflow.host_tools;
  await assert.rejects(f.service.workbench.authoring.recheck({ source_run_id: started.run_id, run_id: 'implicit-refresh' }), { code: 'EXPANSION_HOST_TOOL_CONFLICT' });
  await assert.rejects(access(f.service.runtime.runs.directory('implicit-refresh')), { code: 'ENOENT' });
  const replay = await f.service.workbench.authoring.recheck({ source_run_id: started.run_id, source_revision: selected.revision_hash, run_id: 'contract-recheck' });
  await settle(f.service, replay.run_id);
  assert.deepEqual(f.requests.map(request => request.node_id), ['final']);
  const record = await f.service.runtime.runs.read(replay.run_id), attempt = record.state.nodes.expand.attempts[0];
  const completion = await f.service.runtime.runs.readExecutorResult(replay.run_id, attempt.id, attempt.result_proposal.sha256);
  const evidence = completion.evidence.find(item => item.kind === 'host_generation_recheck').source_contract_refresh;
  assert.equal(record.pins.root.provenance.source_revision, selected.revision_hash);
  assert.equal(evidence.previous_source_revision, old.revision_hash);
  assert.equal(evidence.selected_source_revision, selected.revision_hash);
  assert.deepEqual(evidence.host_tools[0].previous_identity, old.workflow.host_tools[0].identity);
  assert.deepEqual(evidence.host_tools[0].selected_identity, selected.workflow.host_tools[0].identity);
});

test('source refresh rejects source, resources and nonadditive Host contract changes', () => {
  const old = { workflow: { id: 'source', revision: 1, name: 'Source', host_tools: [fixtureTool()] }, revision_hash: 'a'.repeat(64),
    resources: [{ path: 'source.txt', sha256: digest('source') }], provenance: { kind: 'source' }, import_report: { observed: true } };
  const resources = { 'source.txt': Buffer.from('source') };
  const edits = [
    pack => { pack.workflow.name = 'Changed'; }, pack => { pack.provenance.kind = 'changed'; },
    pack => { pack.import_report.observed = false; }, pack => { pack.resources[0].path = 'changed.txt'; },
    pack => { pack.workflow.host_tools[0].id = 'another'; },
    pack => { pack.workflow.host_tools[0].input_schema.properties.newInput = { type: 'string' }; },
    pack => { pack.workflow.host_tools[0].argv = ['changed']; },
    pack => { pack.workflow.host_tools[0].permissions.network = true; },
    pack => { pack.workflow.host_tools[0].idempotency.mode = 'reconcile_required'; },
    pack => { pack.workflow.host_tools[0].output_schema.properties.base.type = 'integer'; },
    pack => { pack.workflow.host_tools[0].output_schema.required = []; },
    pack => { pack.workflow.host_tools[0].output_schema.properties.note = { type: 'string' }; pack.workflow.host_tools[0].output_schema.required.push('note'); },
  ];
  for (const edit of edits) { const next = structuredClone(old); edit(next); assert.throws(() => validateAuthoringSourceRefresh(old, next, resources, resources)); }
  assert.throws(() => validateAuthoringSourceRefresh(old, structuredClone(old), resources, { 'source.txt': Buffer.from('changed') }), { code: 'GENERATION_RECHECK_SOURCE_CHANGED' });
});

test('explicit semantic repair replays a valid retained plan and invokes only one targeted patch', async t => {
  const empty = { source_dispositions: [], requirement_assignments: [], runtime_dependencies: [], records: [], lists: [], enums: [], activities: [], approvals: [], sequences: [], parallels: [], choices: [] };
  const f = await authoringFixture(t, { plannerResult: plan => ({ proposal: { contract: SEMANTIC_REPAIR_CONTRACT, purpose: '',
    upsert: { ...empty, source_dispositions: plan.source_dispositions }, remove: empty } }) });
  const defective = structuredClone(f.plan); defective.source_dispositions[0].disposition = 'reference'; defective.source_dispositions[0].activity_keys = [];
  const started = await retainPlanner(f, { proposal: defective }, 'semantic-retained');
  await assert.rejects(f.service.call('recheck_authoring', { source_run_id: started.run_id, run_id: 'strict-recheck' }, { human: true }), { code: 'AUTHORING_SEMANTIC' });
  await assert.rejects(access(f.service.runtime.runs.directory('strict-recheck')), { code: 'ENOENT' });
  const replay = await f.service.call('recheck_authoring', { source_run_id: started.run_id, run_id: 'semantic-recheck', allow_semantic_repair: true }, { human: true });
  assert.equal(replay.recheck.initial_planner_invoked, false);
  assert.ok(replay.recheck.semantic_feedback.findings.length);
  await settle(f.service, replay.run_id);
  const record = await f.service.runtime.runs.read(replay.run_id);
  assert.deepEqual(f.requests.map(request => request.node_id), ['expand', 'final']);
  assert.equal(f.requests[0].schema.properties.proposal.properties.contract.const, SEMANTIC_REPAIR_CONTRACT);
  assert.equal(record.state.nodes.expand.attempts[0].dispatch.receipt.executor, 'host-generation-replay');
  assert.deepEqual(record.state.generation_projection.authoring_plan, { ...f.plan, loops: [] });
});

test('malformed retained protocol and mechanical Host conflict fail before any replay Run or model', async t => {
  const f = await authoringFixture(t), malformed = structuredClone(f.plan); malformed.records=null;
  const bad = await retainPlanner(f, { proposal: malformed }, 'malformed-retained');
  await assert.rejects(f.service.call('recheck_authoring', { source_run_id: bad.run_id, run_id: 'malformed-recheck', allow_semantic_repair: true }, { human: true }), { code: 'GENERATION_PROPOSAL_CONTRACT' });
  await assert.rejects(access(f.service.runtime.runs.directory('malformed-recheck')), { code: 'ENOENT' });
  const seed = structuredClone(f.pack.workflow); seed.host_tools = [fixtureTool()];
  f.pack = await f.service.store.save(seed.id, seed, { expected_revision: f.pack.revision_hash });
  const defective = structuredClone(f.plan); defective.source_dispositions[0].disposition = 'reference'; defective.source_dispositions[0].activity_keys = [];
  const conflict = await retainPlanner(f, { proposal: defective }, 'conflict-retained');
  const other = fixtureTool(); other.identity.sha256 = 'b'.repeat(64); f.service.runtime.context.host_tool_contracts = [other];
  await assert.rejects(f.service.workbench.authoring.recheck({ source_run_id: conflict.run_id, run_id: 'conflict-recheck', allow_semantic_repair: true }), { code: 'EXPANSION_HOST_TOOL_CONFLICT' });
  await assert.rejects(access(f.service.runtime.runs.directory('conflict-recheck')), { code: 'ENOENT' });
  assert.equal(f.requests.length, 0);
});

test('new pinned approval-state observations receive targeted assignments in both ordinary and replay repair', async t => {
  for (const replay of [false, true]) await t.test(replay ? 'retained replay' : 'ordinary driver', async t => {
    const empty = { source_dispositions: [], requirement_assignments: [], runtime_dependencies: [], records: [], lists: [], enums: [], activities: [], approvals: [], sequences: [], parallels: [], choices: [] };
    let assignments;
    const f = await authoringFixture(t, { brief: '# Workflow\n\n## Process\n\nRead the supplied task and return a concise supported answer. The answer remains pending teacher review.',
      plannerResult: (plan, index) => !replay && index === 1 ? { proposal: plan } : { proposal: { contract: SEMANTIC_REPAIR_CONTRACT, purpose: '', upsert: { ...empty, requirement_assignments: assignments }, remove: empty } } });
    const resources = await f.service.store.resources(f.pack.workflow.id, f.pack.revision_hash);
    const observations = observedSourceRequirements(resources); assert.ok(observations.length);
    assignments = observations.map(item => ({ requirement_id: item.requirement_id, activity_keys: ['answer'] }));
    const started = replay ? await retainPlanner(f, { proposal: f.plan }, 'new-observation-retained') : null;
    const run = replay ? await f.service.call('recheck_authoring', { source_run_id: started.run_id, run_id: 'new-observation-replay', allow_semantic_repair: true }, { human: true })
      : await f.service.call('start_authoring', { workflow_id: f.pack.workflow.id, revision_hash: f.pack.revision_hash, run_id: 'new-observation-driver' }, { human: true });
    await settle(f.service, run.run_id);
    assert.equal((await f.service.call('advance_authoring', { run_id: run.run_id })).phase, 'review_required', JSON.stringify(f.notifications));
    const expands = f.requests.filter(request => request.node_id === 'expand'); assert.equal(expands.length, replay ? 1 : 2);
    assert.equal(expands.at(-1).schema.properties.proposal.properties.contract.const, SEMANTIC_REPAIR_CONTRACT);
    const record = await f.service.runtime.runs.read(run.run_id);
    assert.deepEqual(record.state.generation_projection.authoring_plan.requirement_assignments, assignments);
  });
});

test('synthetic revision accepts three new source targets but rejects invented IDs or unrelated spans', async () => {
  const plan = JSON.parse(await readFile(new URL('./fixtures/artifact-revision-plan.json', import.meta.url), 'utf8'));
  const text = JSON.parse(await readFile(new URL('./fixtures/artifact-revision-source.json', import.meta.url), 'utf8'));
  const resources = Object.fromEntries(Object.entries(text).map(([path, value]) => [path, Buffer.from(value)]));
  const currentSourceRequirements = observedSourceRequirements(resources);
  const missing = currentSourceRequirements.filter(item => !plan.requirement_assignments.some(assignment => assignment.requirement_id === item.requirement_id));
  assert.deepEqual(missing.map(item => item.requirement_id), ['observed_method_rule_8', 'observed_method_rule_12', 'observed_method_rule_18']);
  const feedback = { code: 'GENERATION_DETERMINISTIC_AUDIT', findings: missing.map(item => ({ semantic_keys: [item.requirement_id], affected_semantic_fields: ['requirement_assignments'], source_spans: item.source_spans })) };
  assert.equal(validateRepairTargets(plan, feedback).valid, false);
  assert.deepEqual(validateRepairTargets(plan, feedback, { currentSourceRequirements }), { valid: true });
  for (const change of [target => { target.semantic_keys = ['invented_requirement']; }, target => { target.source_spans[0].start_line = 999; }, target => { target.affected_semantic_fields = ['activities.instructions']; }]) {
    const bad = structuredClone(feedback); change(bad.findings[0]);
    assert.equal(validateRepairTargets(plan, bad, { currentSourceRequirements }).valid, false);
  }
});

test('exact historical planner selection materializes its bound ledger instead of the latest invalid artifact', async t => {
  const f=await authoringFixture(t),empty={source_dispositions:[],requirement_assignments:[],runtime_dependencies:[],records:[],lists:[],enums:[],activities:[],approvals:[],sequences:[],parallels:[],choices:[]};
  const earlierOutput={proposal:{contract:SEMANTIC_REPAIR_CONTRACT,purpose:'',upsert:empty,remove:empty}};
  const started=await retainPlanner(f,earlierOutput,'historical-retained');
  const before=await f.service.runtime.runs.read(started.run_id),earlier=before.state.nodes.expand.attempts[0];
  const defective=structuredClone(f.plan);defective.records=null;
  const completion={status:'succeeded',summary:'Later invalid fixture planner',structured_output:{proposal:defective},artifacts:[],changed_paths:[],outside_paths:[],evidence:[{kind:'fixture_retained_planner'}]};
  const latestId='later-succeeded-attempt',durable=await f.service.runtime.runs.saveExecutorResult(started.run_id,latestId,completion);
  await f.service.runtime.transition(started.run_id,'generation_repair',state=>{
    state.nodes.expand.attempts.push({id:latestId,status:'succeeded',completion,result_proposal:durable,completion_hash:durable.sha256});
    state.nodes.expand.attempts.push({id:'failed-attempt',status:'failed',result_proposal:earlier.result_proposal});
    state.nodes.expand.active_attempt_id=latestId;state.nodes.expand.output=completion.structured_output;
    state.generation_repair={plan_ledger:[{attempt_id:earlier.id,output_hash:digest(canonicalJSON(earlierOutput)),proposal:structuredClone(f.plan)}]};
  },{expected_sequence:before.sequence});
  for(const [source_attempt_id,code] of [[undefined,'GENERATION_PROPOSAL_CONTRACT'],['absent-attempt','GENERATION_RECHECK_SOURCE'],['failed-attempt','GENERATION_RECHECK_SOURCE'],['','GENERATION_RECHECK_SOURCE']]){
    await assert.rejects(f.service.call('recheck_authoring',{source_run_id:started.run_id,source_attempt_id,run_id:'must-not-start'},{human:true}),{code});
    await assert.rejects(access(f.service.runtime.runs.directory('must-not-start')),{code:'ENOENT'});
  }
  assert.equal(f.requests.length,0);
  const selected=await f.service.call('recheck_authoring',{source_run_id:started.run_id,source_attempt_id:earlier.id,run_id:'historical-recheck'},{human:true});
  assert.equal(selected.recheck.source_attempt_id,earlier.id);
  assert.equal(selected.recheck.result_sha256,earlier.result_proposal.sha256);
  await settle(f.service,selected.run_id);
  const replayed=await f.service.runtime.runs.read(selected.run_id);
  assert.deepEqual(replayed.state.generation_projection.authoring_plan,f.plan);
  assert.deepEqual(f.requests.map(request=>request.node_id),['final']);
  assert.equal((await f.service.runtime.runs.read(started.run_id)).sequence,before.sequence+1,'Historical selection never changes the source journal');
  // The exact selected artifact is verified before ledger materialization.
  await writeFile(join(f.service.runtime.runs.directory(started.run_id),earlier.result_proposal.artifact),canonicalJSON({...earlier.completion,summary:'Corrupted retained bytes'}));
  await assert.rejects(f.service.call('recheck_authoring',{source_run_id:started.run_id,source_attempt_id:earlier.id,run_id:'corrupt-must-not-start'},{human:true}),{code:'EXECUTOR_RESULT_CORRUPT'});
  await assert.rejects(access(f.service.runtime.runs.directory('corrupt-must-not-start')),{code:'ENOENT'});
  assert.deepEqual(f.requests.map(request=>request.node_id),['final']);
});

test('review-only recheck materializes the completed semantic delta into a self-contained full plan', async t => {
  const empty = { source_dispositions: [], requirement_assignments: [], runtime_dependencies: [], records: [], lists: [], enums: [],
    activities: [], approvals: [], sequences: [], parallels: [], choices: [] };
  const repairedInstructions = 'Read the supplied task, ground the answer in supported evidence and return a concise answer.';
  const f = await authoringFixture(t, {
    plannerResult: (plan, index) => index === 1 ? { proposal: plan } : { proposal: { contract: SEMANTIC_REPAIR_CONTRACT, purpose: '',
      upsert: { ...empty, activities: [{ ...plan.activities[0], instructions: repairedInstructions }] }, remove: empty } },
    reviewResult: (review, index) => {
      if (index === 1) review.checks[reviewIds().indexOf('hard_rules')] = { status: 'fail',
        evidence: 'The activity omits explicit responsibility to ground the answer in supported evidence.' };
      return review;
    },
  });
  const { started } = await reviewed(f, 'authoring-repaired');
  const prior = await f.service.runtime.runs.read(started.run_id);
  assert.equal(prior.state.nodes.expand.attempts.length, 2);
  const raw = await f.service.runtime.runs.readExecutorResult(started.run_id, prior.state.nodes.expand.attempts.at(-1).id,
    prior.state.nodes.expand.attempts.at(-1).result_proposal.sha256);
  assert.equal(raw.structured_output.proposal.contract, SEMANTIC_REPAIR_CONTRACT);
  const rechecked = await f.service.call('recheck_authoring', { source_run_id: started.run_id, run_id: 'authoring-repaired-recheck' }, { human: true });
  await settle(f.service, rechecked.run_id);
  assert.equal((await f.service.call('advance_authoring', { run_id: rechecked.run_id })).phase, 'review_required');
  const record = await f.service.runtime.runs.read(rechecked.run_id);
  assert.equal(record.state.generation_repair, undefined);
  assert.equal(record.state.generation_projection.authoring_plan.contract, SEMANTIC_BLUEPRINT_CONTRACT);
  assert.equal(record.state.generation_projection.authoring_plan.activities[0].instructions, repairedInstructions);
  assert.equal(f.requests.filter(request => request.node_id === 'expand').length, 2);
  assert.equal(f.requests.filter(request => request.node_id === 'final').length, 3);
});

test('source revision conflict is rejected before authoring final acceptance changes the Run', async t => {
  const f = await authoringFixture(t), { started, progress } = await reviewed(f);
  const before = await f.service.runtime.runs.read(started.run_id);
  await f.service.store.rename(f.pack.workflow.id, 'Edited while under review', f.pack.revision_hash);
  await assert.rejects(f.service.call('accept_authoring', { run_id: started.run_id, accepted: true,
    proposal_sha256: progress.proposal_sha256 }, { human: true }), { code: 'REVISION_CONFLICT' });
  const after = await f.service.runtime.runs.read(started.run_id);
  assert.equal(after.sequence, before.sequence);
  assert.equal(after.state.nodes.final.status, 'running');
  assert.equal(after.state.nodes.final.attempts.at(-1).human_acceptance, undefined);
});

test('a saved reviewer artifact rejected by an older Host checklist can be revalidated and accepted without either model', async t => {
  const f = await authoringFixture(t), { started, progress } = await reviewed(f, 'authoring-saved-review');
  const record = await f.service.runtime.runs.read(started.run_id);
  const attempt = record.state.nodes.final.attempts.at(-1);
  // A historical Host rejected this exact durable artifact. Its review and Pi
  // closure receipt remain intact; rechecking never fabricates a new result.
  await f.service.runtime.transition(started.run_id, 'generation_repair', state => {
    const rejected = state.nodes.final.attempts.find(item => item.id === attempt.id);
    rejected.status = 'failed'; rejected.finished_at = new Date().toISOString();
    rejected.error = { code: 'GENERATION_REVIEW_REJECTED', message: 'Historical Host checklist rejected the retained artifact' };
    state.nodes.final.status = 'ready'; state.nodes.final.active_attempt_id = null;
    state.generation_repair = { feedback: { code: 'GENERATION_CHECKLIST_INVALID', message: 'Historical Host review validator rejected retained evidence' }, awaiting_user_input: true };
  }, { expected_sequence: record.sequence });
  const before = await f.service.runtime.runs.read(started.run_id);
  await assert.rejects(f.service.workbench.authoring.acceptRecheckedReview({ run_id: started.run_id,
    accepted: true, proposal_sha256: '0'.repeat(64) }), { code: 'PI_FINAL_CHANGED' });
  assert.equal((await f.service.runtime.runs.read(started.run_id)).sequence, before.sequence);
  const deployed = await f.service.call('accept_rechecked_authoring_review', { run_id: started.run_id, accepted: true,
    proposal_sha256: progress.proposal_sha256, expected_revision: f.pack.revision_hash }, { human: true });
  assert.equal(deployed.provenance.kind, 'workflow_conversion');
  assert.equal(deployed.authoring_cleanup.private_authoring_artifacts_purged, true);
  assert.deepEqual(f.requests.map(request => request.node_id), ['expand', 'final']);
});

test('accepted authoring cleanup retains caller-owned workspace contents', async t => {
  const f = await authoringFixture(t), sentinel = join(f.workspace, 'user-data.txt');
  await writeFile(sentinel, 'Caller-owned data must survive');
  const { started, progress } = await reviewed(f, 'authoring-external', { workspace: f.workspace });
  const deployed = await f.service.call('accept_authoring', { run_id: started.run_id, accepted: true,
    proposal_sha256: progress.proposal_sha256 }, { human: true });
  assert.equal(await readFile(sentinel, 'utf8'), 'Caller-owned data must survive');
  assert.equal(deployed.authoring_cleanup.retained_user_workspace, f.workspace);
});


test('live authoring submission returns shared compiler errors in the same attempt and admits valid negative review data',async t=>{
  let validations=0;
  const f=await authoringFixture(t,{plannerResult:async (plan)=>{
    const request=f.requests.at(-1);assert.equal(typeof request.validateResult,'function');
    const invalid=structuredClone(plan);invalid.activities[0].inputs[0].from='missing.answer';
    await assert.rejects(request.validateResult({proposal:invalid}),error=>error.code==='AUTHORING_SEMANTIC'&&error.findings.length>0&&error.message.includes('Host findings:'));
    for(const key of ['records','lists','enums','approvals','sequences','parallels','choices'])delete plan[key];
    delete plan.activities[0].tool;delete plan.activities[0].outputs[0].type_ref;delete plan.activities[0].outputs[0].values;
    const receipt=await request.validateResult({proposal:plan});
    assert.equal(receipt.valid,true);assert.equal(receipt.normalizations.filter(item=>item.kind==='host_empty_semantic_field').length,10);
    validations++;return {proposal:plan};
  },reviewResult:async review=>{
    const request=f.requests.at(-1);assert.equal(typeof request.validateResult,'function');
    await assert.rejects(request.validateResult({checks:[]}),{code:'GENERATION_CHECKLIST_INVALID'});
    const negative=structuredClone(review);negative.checks[0]={status:'fail',evidence:'The semantic activity needs to cover an additional source responsibility.'};
    assert.equal((await request.validateResult(negative)).approved,false);
    assert.equal((await request.validateResult(review)).approved,true);validations++;return review;
  }});
  const started=await f.service.workbench.authoring.start({workflow_id:f.pack.workflow.id,revision_hash:f.pack.revision_hash,run_id:'live-preflight'});
  const observed=await settle(f.service,started.run_id);
  assert.equal(observed.state.status,'running',JSON.stringify(Object.fromEntries(Object.entries(observed.state.nodes).map(([key,node])=>[key,node.error]))));
  assert.equal(observed.state.nodes.expand.status,'succeeded');assert.equal(observed.state.nodes.expand.attempts.length,1);
  assert.equal(observed.state.nodes.final.attempts.length,1);assert.equal(validations,2);
  assert.equal((await f.service.workbench.authoring.observe({run_id:started.run_id})).phase,'review_required');
});


test('Pi startup upgrades historical authoring templates and preserves selected Providers, prompt suffixes and deleted templates',async t=>{
  const f=await authoringFixture(t),store=f.service.store,before=await store.snapshot('system.build-workflow');
  const workflow=structuredClone(before.workflow);workflow.authoring.contract='pi-caw-authoring-workflow/v29';
  workflow.name='My authoring template';workflow.tags.push('human-customization');
  workflow.nodes.find(n=>n.id==='expand').prompt_template=AUTHORING_PLANNER_PROMPT_V27+' Preserve my planning preference.';
  workflow.nodes.find(n=>n.id==='final').prompt_template=AUTHORING_REVIEW_PROMPT_V24+' Preserve my review preference.';
  await store.save(workflow.id,workflow,{expected_revision:before.revision_hash,provenance:{...before.provenance,builtin_prompt_bases:{planner:{sha256:digest(AUTHORING_PLANNER_PROMPT_V27),length:AUTHORING_PLANNER_PROMPT_V27.length},reviewer:{sha256:digest(AUTHORING_REVIEW_PROMPT_V24),length:AUTHORING_REVIEW_PROMPT_V24.length}}}});
  const deleted=await store.snapshot('system.skill2workflow');
  await store.delete(deleted.workflow.id,deleted.revision_hash);
  const settings=await f.service.settings.read();
  await f.service.settings.save({...settings.settings,defaults_version:2,defaults_installed:{provider_ids:settings.settings.providers.map(p=>p.id),role_ids:settings.settings.roles.map(r=>r.id),workflow_ids:['system.build-workflow','system.skill2workflow']}},settings.revision);
  const settingsBefore=await f.service.settings.read();await f.service.close();
  const restarted=await new PiCawService({directory:f.service.directory,host:f.host}).initialize();t.after(()=>restarted.close());
  const upgraded=await restarted.store.snapshot(workflow.id);
  assert.equal(upgraded.workflow.authoring.contract,'pi-caw-authoring-workflow/v31');
  assert.equal(upgraded.workflow.name,workflow.name);assert.deepEqual(upgraded.workflow.tags,workflow.tags);
  assert.equal(upgraded.workflow.authoring.planner_provider_id,workflow.authoring.planner_provider_id);
  assert.equal(upgraded.workflow.authoring.review_provider_id,workflow.authoring.review_provider_id);
  assert.equal(upgraded.workflow.nodes.find(n=>n.id==='expand').prompt_template,AUTHORING_PLANNER_PROMPT_V28+' Preserve my planning preference.');
  assert.equal(upgraded.workflow.nodes.find(n=>n.id==='final').prompt_template,AUTHORING_REVIEW_PROMPT_V25+' Preserve my review preference.');
  assert.deepEqual(await restarted.settings.read(),settingsBefore);
  await assert.rejects(restarted.store.snapshot(deleted.workflow.id),{code:'ENOENT'});
});
