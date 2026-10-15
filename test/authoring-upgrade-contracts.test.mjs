import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, binding, settle } from './fixtures.mjs';
import { DEFAULT_PROVIDER_SLOTS, BUILTIN_ROLE_DEFAULTS, DEFAULT_ROUTING } from '../lib/defaults.mjs';
import { compileWorkflowBrief } from '../core/skill-import/workflow-authoring.mjs';
import { compileCoarseSkill } from '../core/skill-import/coarse-compiler.mjs';
import { SEMANTIC_BLUEPRINT_CONTRACT, SEMANTIC_REPAIR_CONTRACT } from '../core/authoring/blueprint-contract.mjs';
import { AUTHORING_PLANNER_PROMPT_V28, AUTHORING_PLANNER_PROMPT_CURRENT, ensureStoredAuthoringWorkflows } from '../core/authoring/authoring-workflows.mjs';
import { sourceSectionInventory } from '../core/skill-import/source-dispositions.mjs';
import { callableSourceRequirements, observedSourceRequirements } from '../core/skill-import/source-requirements.mjs';
import { validateGenerationProposal } from '../core/skill-import/proposal-validation.mjs';
import { reviewIds } from '../core/skill-import/review-checklist.mjs';
import { generationReviewRepairOwner } from '../core/skill-import/generation-retry-policy.mjs';
import { canonicalJSON, digest, prepareResources, revisionHash } from '../core/workflow-revisions.mjs';
import { CONVERSION_CONTRACT } from '../core/skill-import/conversion-contract.mjs';

function planFor(resources, instructions = 'Read the supplied task and return a concise supported answer.') {
  const sections = sourceSectionInventory(resources).map(section => section.section_id);
  return { contract: SEMANTIC_BLUEPRINT_CONTRACT, purpose: 'Preserve the exact source operation and newly authored conclusion.',
    source_dispositions: sections.map(section_id => ({ section_id, disposition: 'workflow', activity_keys: ['answer'], note: 'This activity preserves the source duty.' })),
    requirement_assignments: [...observedSourceRequirements(resources, { source_resource_policy: true }), ...callableSourceRequirements(resources)]
      .map(item => ({ requirement_id: item.requirement_id, activity_keys: ['answer'] })),
    runtime_dependencies: [], activities: [{ key: 'answer', instructions, profile: 'main_read', source_sections: sections,
      inputs: [{ name: 'task', from: 'input:task' }], outputs: [{ name: 'answer', kind: 'text' }] }], loops: [] };
}

test('Skill2Workflow and Build Workflow share pinned callable admission and runtime interface projection', () => {
  const source = '# Process\n\nCall `tools.render({"kind":"small"})` and return a newly written concise conclusion.';
  const brief = compileWorkflowBrief({ workflow_id: 'callable-brief', name: 'Callable brief', brief: source });
  const skill = compileCoarseSkill({ metadata: { name: 'Callable skill', description: 'Fixture source' },
    source_path: '/fixture/callable/SKILL.md', source_hash: digest(source), root: '/fixture/callable',
    instructions_start_line: 1, files: { 'source/SKILL.md': Buffer.from(source) }, inventory: [], problems: [], metadata_files: [] }, { id: 'callable-skill' });
  for (const compiled of [brief, skill]) {
    const snapshot = { workflow: compiled.workflow, resources: prepareResources(compiled.resources).manifest, provenance: compiled.provenance, import_report: compiled.import_report };
    const pack = { ...snapshot, revision_hash: revisionHash(snapshot) }, resources = compiled.resources;
    const plan = planFor(resources, 'Perform the source-defined original operation, then write a concise new conclusion.');
    const provenance = { source_revision: pack.revision_hash, authoring_contract: 'pi-caw-authoring-workflow/v32',
      callable_inventory_policy: 'workflow-callable-inventory/v1', review_contract_version: CONVERSION_CONTRACT.version, routing_rules: structuredClone(DEFAULT_ROUTING) };
    const context = { providers: DEFAULT_PROVIDER_SLOTS.map(provider => ({ id: provider.id, kind: 'native_agent', enabled: true, capabilities: { read: true, write: true }, config: {} })) };
    const admitted = validateGenerationProposal({ proposal: plan }, { pack, resources, provenance, context });
    const call = admitted.proposal.source_requirements.find(item => item.details?.callable_id);
    assert.equal(call.details.interface.tool, 'tools.render');
    assert.deepEqual(call.details.interface.arguments, { kind: 'small' });
    assert.equal(admitted.compiled.workflow.import_status.requirement_coverage.find(item => item.requirement_id === call.requirement_id).status, 'agent_assisted');
    assert.match(admitted.compiled.workflow.nodes.find(node => node.origin?.semantic_key === 'answer').prompt_template, /Original operation interfaces/);
    assert.equal(admitted.compiled.workflow.nodes.find(node => node.origin?.semantic_key === 'answer').executor.kind, 'main');
    // Exact Host projection survives decode/hash replay; planner conveniences cannot rewrite it.
    const output = { proposal: admitted.proposal, host_pipeline: { contract: admitted.pipeline_trace.contract,
      proposal_hash: admitted.pipeline_trace.proposal_hash, results: admitted.pipeline_trace.results } };
    assert.equal(validateGenerationProposal(output, { pack, resources, provenance, context }).compiled.proposal_hash, admitted.compiled.proposal_hash);
    const missing = structuredClone(plan); missing.requirement_assignments = missing.requirement_assignments.filter(item => item.requirement_id !== call.requirement_id);
    assert.throws(() => validateGenerationProposal({ proposal: missing }, { pack, resources, provenance, context }), error => error.code === 'GENERATION_DETERMINISTIC_AUDIT');
  }
});

async function completedAuthoring(t, { mixed = false, repairCallable = false } = {}) {
  let plan, plannerCalls = 0;
  const f = await fixture(t, { resultFor: request => {
    if (request.node_id === 'expand') {
      plannerCalls++;
      if(repairCallable){
        const assignment=plan.requirement_assignments.find(item=>item.requirement_id.startsWith('callable_'));
        if(plannerCalls===1){const incomplete=structuredClone(plan);incomplete.requirement_assignments=incomplete.requirement_assignments.filter(item=>item.requirement_id!==assignment.requirement_id);return {proposal:incomplete};}
        return {proposal:{contract:SEMANTIC_REPAIR_CONTRACT,purpose:'',upsert:{requirement_assignments:[assignment]},remove:{}}};
      }
      return { proposal: structuredClone(plan) };
    }
    const checks = reviewIds().map(id => ({ status: mixed && ['method_fidelity', 'host_canonicalization'].includes(id) ? 'fail' : 'pass',
      evidence: id === 'host_canonicalization' && mixed ? 'Host projection defect: completion gate contradicts the source.' : id === 'method_fidelity' && mixed ? 'The activity omits the required semantic method.' : 'The activity preserves the source duty and supported handoff.' }));
    return { checks };
  } });
  const current = await f.service.call('settings');
  await f.service.call('save_settings', { expected_revision: current.revision, settings: { schema_version: 1,
    providers: DEFAULT_PROVIDER_SLOTS.map(provider => ({ ...provider, binding: { ...binding } })),
    roles: structuredClone(BUILTIN_ROLE_DEFAULTS), routing: structuredClone(DEFAULT_ROUTING) } }, { human: true });
  const pack = await f.service.call('build_workflow', { workflow_id: 'preview-source', name: 'Preview source',
    brief: repairCallable ? '# Process\n\nCall `tools.render({"kind":"small"})` and return a newly written concise conclusion.' : '# Process\n\nRead the supplied task and return a concise supported answer.', provider_id: 'pi-worker' }, { human: true });
  const resources = await f.service.store.resources(pack.workflow.id, pack.revision_hash);
  plan = planFor(resources); plan.activities[0].profile = 'worker_read';
  const started = await f.service.call('start_authoring', { workflow_id: pack.workflow.id, revision_hash: pack.revision_hash, run_id: 'retained-preview' }, { human: true });
  await settle(f.service, started.run_id);
  return { ...f, pack, started };
}

test('retained preview and exact source discovery read saved results without adoption, transitions or model calls', async t => {
  const f = await completedAuthoring(t), authoring = f.service.workbench.authoring;
  const directory = f.service.runtime.runs.directory(f.started.run_id), paths = ['events.jsonl', 'pi-controller.json', 'pi-worker.json'];
  const before = await Promise.all(paths.map(path => readFile(join(directory, path)))), record = await f.service.runtime.runs.read(f.started.run_id);
  const calls = f.requests.length, mainCalls = f.mainRequests.length;
  const preview = await authoring.retainedPreview({ run_id: f.started.run_id });
  assert.equal(preview.read_only, true); assert.equal(preview.phase, 'review_required');
  assert.equal(preview.preview_identity.review_result_sha256, preview.proposal_sha256);
  assert.equal(preview.workflow.import_status.source_independent, true);
  assert.equal(preview.workflow.skill_policy.implicit, 'deny');
  const discovered = await authoring.discover({ workflow_id: f.pack.workflow.id, revision_hash: f.pack.revision_hash });
  assert.equal(discovered.candidates.length, 1); assert.equal(discovered.preview.preview_identity.proposal_hash, preview.preview_identity.proposal_hash);
  assert.deepEqual(await Promise.all(paths.map(path => readFile(join(directory, path)))), before);
  assert.equal((await f.service.runtime.runs.read(f.started.run_id)).sequence, record.sequence);
  assert.equal(f.requests.length, calls); assert.equal(f.mainRequests.length, mainCalls);
  await assert.rejects(authoring.accept({ run_id: f.started.run_id, accepted: true, proposal_sha256: preview.proposal_sha256,
    preview_identity: { ...preview.preview_identity, proposal_hash: digest('changed') } }), { code: 'AUTHORING_PREVIEW_CHANGED' });
  assert.equal((await f.service.runtime.runs.read(f.started.run_id)).sequence, record.sequence);
});

test('mixed Host and semantic review failures keep all findings and consume zero planner repairs', async t => {
  assert.equal(generationReviewRepairOwner({ host_findings: ['mechanical'], semantic_findings: ['semantic'] }), 'host');
  const f = await completedAuthoring(t, { mixed: true }), record = await f.service.runtime.runs.read(f.started.run_id);
  assert.equal(record.state.nodes.expand.attempts.length, 1);
  assert.equal(f.requests.filter(request => request.node_id === 'expand').length, 1);
  assert.equal(record.state.generation_repair, undefined);
  const preview = await f.service.workbench.authoring.retainedPreview({ run_id: f.started.run_id });
  assert.equal(preview.review.structured_output.approved, false);
  assert.equal(preview.review.structured_output.host_findings.length, 1);
  assert.equal(preview.review.structured_output.semantic_findings.length, 1);
});

test('new callable omissions receive exact pinned stable-key repair admission instead of an unlocalized retry', async t => {
  const f=await completedAuthoring(t,{repairCallable:true}),record=await f.service.runtime.runs.read(f.started.run_id);
  assert.equal(record.state.nodes.expand.attempts.length,2);
  assert.equal(f.requests.filter(request=>request.node_id==='expand').length,2);
  assert.equal(record.state.nodes.deterministic_validation.status,'succeeded',JSON.stringify(Object.fromEntries(Object.entries(record.state.nodes).map(([id,node])=>[id,{status:node.status,error:node.error}]))));
  assert.ok(record.state.generation_repair.feedback.findings.some(item=>item.requirement_id?.startsWith('callable_')));
  assert.equal((await f.service.workbench.authoring.retainedPreview({run_id:f.started.run_id})).review.structured_output.approved,true);
});

test('v31 template upgrade preserves custom prompt bytes, suffixes, choices, deleted templates and existing Run pins', async t => {
  const f=await completedAuthoring(t),store=f.service.store,before=await store.snapshot('system.build-workflow');
  const runBefore=await f.service.runtime.runs.read(f.started.run_id),workflow=structuredClone(before.workflow);
  workflow.authoring.contract='pi-caw-authoring-workflow/v31';workflow.name='My retained authoring';workflow.tags.push('custom');
  workflow.nodes.find(node=>node.id==='expand').prompt_template=AUTHORING_PLANNER_PROMPT_V28+' Preserve my custom constraint.';
  workflow.nodes.find(node=>node.id==='final').prompt_template='My complete independent reviewer instructions.';
  await store.save(workflow.id,workflow,{expected_revision:before.revision_hash,provenance:{...before.provenance,builtin_prompt_bases:{
    planner:{sha256:digest(AUTHORING_PLANNER_PROMPT_V28),length:AUTHORING_PLANNER_PROMPT_V28.length},reviewer:before.provenance.builtin_prompt_bases.reviewer}}});
  const removed=await store.snapshot('system.skill2workflow');await store.delete(removed.workflow.id,removed.revision_hash);
  await ensureStoredAuthoringWorkflows(store,{providers:f.service.runtime.context.providers,routingRules:f.service.currentSettings.routing,createMissing:false});
  const after=await store.snapshot(workflow.id),runAfter=await f.service.runtime.runs.read(f.started.run_id);
  assert.equal(after.workflow.authoring.contract,'pi-caw-authoring-workflow/v32');
  assert.equal(after.workflow.nodes.find(node=>node.id==='expand').prompt_template,AUTHORING_PLANNER_PROMPT_CURRENT+' Preserve my custom constraint.');
  assert.equal(after.workflow.nodes.find(node=>node.id==='final').prompt_template,'My complete independent reviewer instructions.');
  assert.equal(after.workflow.authoring.planner_provider_id,workflow.authoring.planner_provider_id);
  assert.equal(after.workflow.authoring.review_provider_id,workflow.authoring.review_provider_id);
  assert.equal(after.workflow.name,workflow.name);assert.deepEqual(after.workflow.tags,workflow.tags);
  assert.deepEqual(runAfter.pins,runBefore.pins);assert.equal(runAfter.sequence,runBefore.sequence);
  await assert.rejects(store.snapshot(removed.workflow.id),{code:'ENOENT'});
});
