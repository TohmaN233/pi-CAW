import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WorkflowStore } from '../core/workflow-store.mjs';
import { WorkflowRuntime } from '../core/workflow-runtime.mjs';
import { canonicalJSON, digest } from '../core/workflow-revisions.mjs';
import { writeDurableJSON } from '../core/workflow-events.mjs';
import { insideRoot, noSymlinks, requireValue, workflowId } from '../core/workflow-paths.mjs';
import { authoringRunPack, authoringAttemptOutputSchema, decodeGeneratedEnvelope } from '../core/skill-import/expansion-run.mjs';
import { prepareAuthoringReview } from '../core/skill-import/generation.mjs';
import { continueGenerationRepair, repairGeneration, validateRepairTargets } from '../core/skill-import/generation-repair.mjs';
import { semanticGenerationRepair } from '../core/skill-import/generation-retry-policy.mjs';
import { validateGenerationProposal } from '../core/skill-import/proposal-validation.mjs';
import { applyExpansion } from '../core/skill-import/semantic-expander.mjs';
import { evaluateReview } from '../core/skill-import/review-checklist.mjs';
import { leaseToken } from '../core/workflow-execution-envelope.mjs';
import { CONVERSION_CONTRACT } from '../core/skill-import/conversion-contract.mjs';
import { requireDeployableConvertedSnapshot } from '../core/skill-import/conversion-deployment.mjs';
import { AUTHORING_REPAIR_RESOURCE, AUTHORING_REVIEW_RESOURCE, AUTHORING_REVIEW_INPUTS_RESOURCE,
  authoringWorkflowForPack, storedAuthoringBindings, authoringReviewIdentity, isAuthoringRunProvenance, authoringDependencyAssessmentRequired } from '../core/authoring/authoring-workflows.mjs';
import { coreProvider, resolveBinding } from './models.mjs';
import { applySemanticRepair, canonicalizeSemanticRepair, validateSemanticBlueprintContract, SEMANTIC_BLUEPRINT_CONTRACT, SEMANTIC_REPAIR_CONTRACT, SEMANTIC_REPAIR_SCHEMA } from '../core/authoring/blueprint-contract.mjs';
import { validateData } from '../core/workflow-data-schema.mjs';
import { validateHostToolContract } from '../core/execution/host-tool-runner.mjs';
import { observedSourceRequirements } from '../core/skill-import/source-requirements.mjs';
import {selectRetainedAuthoringAttempt,retainedAuthoringReplaySource} from '../core/skill-import/retained-authoring-plan.mjs';
import {refreshRetainedRepairTargets} from '../core/skill-import/repair-target-refresh.mjs';
import {authoringReviewFacts} from '../core/authoring/review-facts.mjs';

const dataObject=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const workerStatuses=new Set(['running','blocked','succeeded','failed','cancelled','paused','interrupted','attention','awaiting_acceptance','awaiting_child','user_input_required']);
async function authoringJournal(path) {
  let before;
  try {
    await noSymlinks(path);
    before=await lstat(path);
  } catch(error) { if(error.code==='ENOENT')return null;throw error; }
  requireValue(before.isFile()&&before.nlink===1&&before.size>0&&before.size<=128*1024,'AUTHORING_OWNER_JOURNAL','Authoring owner journal must be one bounded physical file');
  const bytes=await readFile(path),after=await lstat(path);
  requireValue(bytes.length===before.size&&after.size===before.size&&after.ino===before.ino&&after.mtimeMs===before.mtimeMs&&!after.isSymbolicLink(),
    'AUTHORING_OWNER_JOURNAL_CHANGED','Authoring owner journal changed while being observed; inspect the exact owner again');
  return {value:JSON.parse(bytes.toString('utf8')),sha256:digest(bytes)};
}
async function settledAuthoringOwnerFailure(service,record) {
  const runId=record.state.run_id,worker=await authoringJournal(join(service.runtime.runs.directory(runId),'pi-worker.json'));
  if(!worker)return null; // A prepared, never-launched authoring Run has no execution owner.
  const value=worker.value;
  requireValue(dataObject(value)&&value.run_id===runId&&value.session_id===record.state.main_actor
    &&Number.isSafeInteger(value.process_id)&&value.process_id>0&&workerStatuses.has(value.status)
    &&Number.isFinite(Date.parse(value.started_at)),'AUTHORING_OWNER_IDENTITY','Worker journal does not belong to this exact authoring Run and chat');
  if(value.settled_at===undefined)return null;
  requireValue(Number.isFinite(Date.parse(value.settled_at))&&Date.parse(value.settled_at)>=Date.parse(value.started_at),
    'AUTHORING_OWNER_IDENTITY','Settled authoring owner has invalid lifecycle evidence');
  if(value.status!=='attention'&&value.error===undefined)return null;
  requireValue(dataObject(value.error)&&typeof value.error.code==='string'&&value.error.code.length>0&&value.error.code.length<=128
    &&typeof value.error.message==='string'&&value.error.message.length>0&&value.error.message.length<=16000,
    'AUTHORING_OWNER_ERROR','Settled authoring owner needs its concrete bounded error');
  const detached=service.detachedOwners?.paths?await authoringJournal(service.detachedOwners.paths(runId).status):null;
  if(detached){
    const owner=detached.value;
    requireValue(dataObject(owner)&&owner.schema_version===1&&['starting','running','stopped','failed','succeeded','cancelled'].includes(owner.phase)
      &&owner.run_id===runId&&owner.main_actor===record.state.main_actor
      &&owner.controller_hash===record.state.control_hash&&/^[a-f0-9]{64}$/.test(owner.controller_hash)
      &&typeof owner.owner_id==='string'&&/^[a-f0-9-]{36}$/.test(owner.owner_id)&&Number.isSafeInteger(owner.revision)&&owner.revision>=1
      &&Number.isSafeInteger(owner.generation)&&owner.generation>=1&&owner.pid===value.process_id
      &&Number.isFinite(Date.parse(owner.started_at))&&Date.parse(owner.started_at)<=Date.parse(value.started_at),
      'AUTHORING_OWNER_IDENTITY','Detached owner signature or generation differs from the settled authoring worker');
  }
  return {error:structuredClone(value.error),worker:{status:value.status,process_id:value.process_id,session_id:value.session_id,
    settled_at:value.settled_at,journal_sha256:worker.sha256,...(detached?{owner_id:detached.value.owner_id,owner_revision:detached.value.revision,owner_journal_sha256:detached.sha256}:{})}};
}
function additiveOptionalOutputSchema(previous,next,path='$'){
  if(canonicalJSON(previous)===canonicalJSON(next))return;
  requireValue(dataObject(previous)&&dataObject(next),'GENERATION_RECHECK_CONTRACT',`Output schema changed at ${path}`);
  const rest=value=>Object.fromEntries(Object.entries(value).filter(([key])=>!['properties','items'].includes(key)));
  requireValue(canonicalJSON(rest(previous))===canonicalJSON(rest(next)),'GENERATION_RECHECK_CONTRACT',`Existing output constraints or required fields changed at ${path}`);
  if(previous.items!==undefined||next.items!==undefined){
    requireValue(previous.items!==undefined&&next.items!==undefined,'GENERATION_RECHECK_CONTRACT',`Output item contract changed at ${path}`);
    additiveOptionalOutputSchema(previous.items,next.items,`${path}/items`);
  }
  const prior=previous.properties??{},current=next.properties??{};
  for(const [name,schema] of Object.entries(prior)){
    requireValue(Object.hasOwn(current,name),'GENERATION_RECHECK_CONTRACT',`Existing output property removed at ${path}/${name}`);
    additiveOptionalOutputSchema(schema,current[name],`${path}/${name}`);
  }
  for(const name of Object.keys(current).filter(name=>!Object.hasOwn(prior,name)))requireValue(!(next.required??[]).includes(name),'GENERATION_RECHECK_CONTRACT',`New output property must be optional at ${path}/${name}`);
}

// Reusing planner meaning across source revisions is restricted to an explicit
// mechanical Host implementation refresh. No source/task change is inferred.
export function validateAuthoringSourceRefresh(previous,next,previousResources,nextResources){
  const seed=workflow=>{const copy=structuredClone(workflow);delete copy.revision;delete copy.host_tools;return copy;};
  requireValue(previous.workflow.id===next.workflow.id&&canonicalJSON(seed(previous.workflow))===canonicalJSON(seed(next.workflow)),
    'GENERATION_RECHECK_SOURCE_CHANGED','The source Workflow seed changed beyond revision and host_tools');
  requireValue(canonicalJSON(previous.provenance??{})===canonicalJSON(next.provenance??{})&&canonicalJSON(previous.import_report??{})===canonicalJSON(next.import_report??{}),
    'GENERATION_RECHECK_SOURCE_CHANGED','Source provenance or import evidence changed');
  requireValue(canonicalJSON(previous.resources)===canonicalJSON(next.resources)&&canonicalJSON(Object.keys(previousResources).sort())===canonicalJSON(Object.keys(nextResources).sort())
    &&Object.entries(previousResources).every(([path,bytes])=>Buffer.from(bytes).equals(Buffer.from(nextResources[path]))),
    'GENERATION_RECHECK_SOURCE_CHANGED','Source resource paths or bytes changed');
  const oldTools=(previous.workflow.host_tools??[]).map(validateHostToolContract),newTools=(next.workflow.host_tools??[]).map(validateHostToolContract);
  const oldById=new Map(oldTools.map(tool=>[tool.id,tool])),newById=new Map(newTools.map(tool=>[tool.id,tool]));
  const oldDeclarations=new Map((previous.workflow.host_tools??[]).map(tool=>[tool.id,tool])),newDeclarations=new Map((next.workflow.host_tools??[]).map(tool=>[tool.id,tool]));
  requireValue(oldById.size===oldTools.length&&newById.size===newTools.length&&canonicalJSON([...oldById.keys()].sort())===canonicalJSON([...newById.keys()].sort()),
    'GENERATION_RECHECK_CONTRACT','Host-tool IDs changed or are duplicated');
  const toolSeed=tool=>Object.fromEntries(Object.entries(tool).filter(([key])=>!['identity','output_schema'].includes(key)));
  const identities=[];
  for(const [id,oldTool] of oldById){
    const newTool=newById.get(id);
    requireValue(canonicalJSON(toolSeed(oldDeclarations.get(id)))===canonicalJSON(toolSeed(newDeclarations.get(id))),'GENERATION_RECHECK_CONTRACT',`Host-tool ${id} inputs, invocation, permissions or execution policy changed`);
    additiveOptionalOutputSchema(oldTool.output_schema,newTool.output_schema,`host_tools/${id}/output_schema`);
    identities.push({id,previous_identity:structuredClone(oldTool.identity),selected_identity:structuredClone(newTool.identity),
      previous_output_schema_sha256:digest(canonicalJSON(oldTool.output_schema)),selected_output_schema_sha256:digest(canonicalJSON(newTool.output_schema))});
  }
  return {previous_source_revision:previous.revision_hash,selected_source_revision:next.revision_hash,host_tools:identities};
}

// Preserve the upstream semantic planner → deterministic Host compiler →
// independent reviewer → explicit human publication pipeline. Pi supplies the
// native child sessions; compiler semantics and acceptance gates are shared.
export class PiAuthoring {
  constructor(service) { this.service = service; }
  async job(args, id, { bind = false } = {}) {
    const service = this.service, pack = await service.store.snapshot(args.workflow_id, args.revision_hash);
    const definition = authoringWorkflowForPack(pack);
    requireValue(!args.authoring_workflow_id || args.authoring_workflow_id === definition.id, 'AUTHORING_WORKFLOW_SOURCE', 'Selected authoring template accepts a different source kind');
    const template = await service.store.snapshot(definition.id, args.authoring_workflow_revision);
    const providers = service.currentSettings.providers.map(provider => coreProvider({ ...provider,
      binding: bind && provider.binding ? resolveBinding(provider.binding, service.host.catalog()) : provider.binding }));
    const bindings = storedAuthoringBindings(template.workflow, providers);
    if (bind) for (const provider of [bindings.planner, bindings.reviewer]) resolveBinding(provider.config, service.host.catalog());
    const rules = structuredClone(args.routing_rules ?? service.currentSettings.routing);
    rules.generation = { ...rules.generation, planner_provider_id: bindings.planner.id, review_provider_id: bindings.reviewer.id, max_rounds: bindings.maxRounds };
    const job = authoringRunPack(pack, await service.store.resources(pack.workflow.id, pack.revision_hash), bindings.planner, id,
      rules, true, bindings.reviewer, providers, template);
    return { pack, template, definition, bindings, providers, job };
  }
  async preview(args) {
    const { pack, template, job } = await this.job(args, 'authoring-preview');
    return { invoked: false, source_revision: pack.revision_hash, authoring_pipeline: template.workflow.authoring.pipeline,
      generator: job.workflow.nodes.find(node => node.id === 'expand').prompt_template,
      reviewer: job.workflow.nodes.find(node => node.id === 'final').prompt_template,
      model_resource_paths: job.workflow.nodes.filter(node => node.type === 'agent').map(node => ({ node_id: node.id, paths: node.resources })),
      shared_request: job.resources['analysis/request.txt'].toString(), review_request: job.resources['analysis/review-request.txt'].toString(),
      output_schemas: Object.fromEntries(job.workflow.nodes.filter(node => node.outputs_schema).map(node => [node.id,
        authoringAttemptOutputSchema({pins:{root:{workflow:job.workflow,provenance:job.provenance}},state:{}},node.id)])),
      runtime_context: 'Pi native planner and reviewer have isolated resource packets. The Host owns graph IDs, schemas, bindings, compiler checks and evidence. Publishing requires explicit human acceptance.' };
  }
  async start(args, { launch = true } = {}) {
    const service = this.service, id = args.run_id ?? `authoring-${randomUUID()}`;
    const { pack, bindings, providers, job } = await this.job(args, id, { bind: true });
    const workspace = args.workspace || join(service.directory, 'authoring-workspaces', id);
    await mkdir(workspace, { recursive: true });
    const jobs = await new WorkflowStore(join(service.directory, 'authoring-jobs'), { validationContext: { ...service.runtime.context, providers } }).initialize();
    const planning = await new WorkflowRuntime({ workflowStore: jobs, runRoot: service.runtime.runs.root,
      generationPolicy: { settings: job.provenance.generation, reviewer: bindings.reviewer }, authoringReviewer: bindings.reviewer,
      context: { ...service.runtime.context, providers }, beforeStart: closure => service.preflight(closure),
      strictCapability: () => service.host.capabilities.strict_resources,
      environmentResolver: service.runtime.environmentResolver, environmentVerifier: service.runtime.environmentVerifier }).initialize();
    const run = await service.store.withWriter(async () => {
      requireValue((await service.store.snapshot(pack.workflow.id)).revision_hash === pack.revision_hash, 'REVISION_CONFLICT', 'Source changed before authoring was registered');
      const saved = await jobs.create(job.workflow, job);
      return planning.start({ workflow_id: saved.workflow.id, revision_hash: saved.revision_hash, run_id: id, workspace,
        main_actor: service.host.mainIdentity().session_id, access: 'read_only', inputs: { task: 'Compile the pinned source into an editable Workflow draft' },
        constraints: { pi_caw_authoring_controller: service.host.mainIdentity().session_id } });
    });
    await writeDurableJSON(join(service.runtime.runs.directory(id), 'pi-controller.json'), { control_token: run.control_token });
    if (launch) await service.launchDriver(id);
    // This token is restricted to the authenticated human Workbench. Model
    // tools never receive controller authority.
    return run;
  }
  async prepare(runId, nodeId, authority) {
    const service = this.service;
    if (!['graph_assembly', 'final'].includes(nodeId)) return;
    await prepareAuthoringReview(service.runtime, { run_id: runId, node_id: nodeId, ...authority }, { store: service.store, context: service.runtime.context });
  }
  // Same gate as compile/apply, but before the model session closes. Invalid
  // submissions stay in this turn; valid negative reviews remain repair data.
  async preflightResult(runId,nodeId,result) {
    const service=this.service,record=await service.runtime.runs.read(runId),provenance=record.pins.root.provenance;
    requireValue(isAuthoringRunProvenance(provenance),'GENERATION_RUN','Authoring preflight requires a pinned authoring Run');
    const resources=await service.store.resources(provenance.source_workflow_id,provenance.source_revision);
    if(nodeId==='expand'){
      const pack=await service.store.snapshot(provenance.source_workflow_id,provenance.source_revision);
      try {
        const validated=validateGenerationProposal(result,{pack,resources,provenance,context:service.runtime.context,
          previousPlan:record.state.generation_repair?.previous_proposal,repairFeedback:record.state.generation_repair?.feedback});
        return {valid:true,proposal_hash:validated.pipeline_trace.proposal_hash,normalizations:validated.repairs};
      } catch(error) {
        // Pi renders thrown tool messages, not arbitrary Error properties. Keep
        // the concrete semantic locations visible in that same correction turn.
        if(error.findings?.length)error.message+='\nHost findings: '+JSON.stringify(error.findings.map(({code,path,message,semantic_keys,affected_semantic_fields,minimal_change})=>({code,path,message,semantic_keys,affected_semantic_fields,minimal_change}))).slice(0,16000);
        throw error;
      }
    }
    requireValue(nodeId==='final','AUTHORING_PREFLIGHT_NODE','Unexpected model node in authoring preflight');
    const review=evaluateReview(result,record.state.nodes.expand.output.proposal,resources,{version:provenance.review_contract_version});
    return {valid:true,approved:review.approved};
  }
  async resources(runId, nodeId, authority, envelope) {
    const service = this.service, record = await service.runtime.runs.read(runId);
    if (!isAuthoringRunProvenance(record.pins.root.provenance)) return { resources: [], identity: null };
    const values = [], state = record.state;
    if (nodeId === 'expand' && state.generation_repair) values.push([AUTHORING_REPAIR_RESOURCE, {
      contract: 'workflow-semantic-repair-context/v1', round: state.generation_repair.round,
      semantic_repair_index: state.generation_repair.semantic_repair_index ?? null, feedback: state.generation_repair.feedback,
      user_guidance: state.generation_repair.user_guidance ?? null, previous_proposal: state.generation_repair.previous_proposal }]);
    let identity = null;
    if (nodeId === 'final') {
      requireValue(state.nodes.deterministic_validation.status === 'succeeded', 'AUTHORING_REVIEW_STATE', 'Independent review requires the completed Host compiler');
      identity = authoringReviewIdentity(record);
      values.push([AUTHORING_REVIEW_RESOURCE, state.nodes.expand.output.proposal], [AUTHORING_REVIEW_INPUTS_RESOURCE, state.generation_projection.review_inputs_schema]);
      values.push(['__authoring__/review-facts.json',authoringReviewFacts(state.nodes.expand.output.proposal)]);
    }
    const resources = [];
    for (const [path, value] of values) {
      const bytes = Buffer.from(canonicalJSON(value)), sha256 = digest(bytes), objectPath = join(service.runtime.runs.directory(runId), 'objects', sha256);
      try { await writeFile(objectPath, bytes, { flag: 'wx', mode: 0o600 }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; requireValue(digest(await readFile(objectPath)) === sha256, 'AUTHORING_RESOURCE_CORRUPT', 'Derived resource hash changed'); }
      resources.push({ path, sha256, bytes: bytes.length, object_path: objectPath });
      if (path === AUTHORING_REVIEW_RESOURCE || path === AUTHORING_REPAIR_RESOURCE) await service.runtime.recordExecutorEvent(runId, {
        ...authority, node_id: nodeId, attempt_id: envelope.attempt_id, lease_token: envelope.lease_token,
        event: { kind: identity ? 'review_context_prepared' : 'repair_context_prepared', metadata: { path, sha256, bytes: bytes.length, ...(identity ?? {}) } } });
    }
    return { resources, identity };
  }
  async observe(args) {
    const service = this.service, record = await service.runtime.runs.read(args.run_id), provenance = record.pins.root.provenance;
    requireValue(isAuthoringRunProvenance(provenance), 'GENERATION_RUN', 'Selected Run is not an authoring Run');
    if (args.control_token) await service.runtime.authorizeController(args.run_id, args);
    const source = { workflow_id: provenance.source_workflow_id, expected_revision: provenance.source_revision };
    if (record.state.status === 'succeeded') {
      const attempt = record.state.nodes.final.attempts.find(item => item.id === record.state.nodes.final.active_attempt_id);
      requireValue(attempt?.result_proposal?.sha256, 'AUTHORING_REVIEW_STATE', 'Accepted authoring Run has no exact durable reviewer artifact');
      return { phase: 'ready_to_apply', source, proposal_sha256: attempt.result_proposal.sha256,
        canonical_proposal_hash: authoringReviewIdentity(record).proposal_hash };
    }
    const ownerFailure=await settledAuthoringOwnerFailure(service,record);
    if(ownerFailure){
      console.warn('[pi-CAW authoring] settled owner requires attention',{run_id:args.run_id,run_status:record.state.status,...ownerFailure});
      return {phase:'attention',status:'attention',run_status:record.state.status,sequence:record.sequence,source,...ownerFailure};
    }
    if (record.state.generation_repair?.awaiting_user_input) return { phase: 'user_input_required', feedback: record.state.generation_repair.feedback, error: record.state.generation_repair.feedback };
    const next = await service.runtime.next(args.run_id);
    if (next.approvals.length) return { phase: 'approval', approvals: next.approvals };
    const attempt = record.state.nodes.final.attempts.find(item => item.id === record.state.nodes.final.active_attempt_id)
      ?? record.state.nodes.final.attempts.at(-1);
    if (attempt?.result_proposal) {
      const pack = await service.store.snapshot(source.workflow_id, source.expected_revision), resources = await service.store.resources(source.workflow_id, source.expected_revision);
      const validated = validateGenerationProposal(record.state.nodes.expand.output, { pack, resources, provenance, context: service.runtime.context });
      const completion = await service.runtime.runs.readExecutorResult(args.run_id, attempt.id, attempt.result_proposal.sha256);
      const review = evaluateReview(completion.structured_output, validated.proposal, resources, { version: provenance.review_contract_version });
      if (!review.approved || review.findings.length) return { phase: 'attention', status: 'review_findings', error: { code: 'GENERATION_REVIEW_BLOCKED', message: 'Review findings require repair', findings: review.findings } };
      return { phase: 'review_required', source, proposal_sha256: attempt.result_proposal.sha256,
        canonical_proposal_hash: authoringReviewIdentity(record).proposal_hash, proposal: validated.proposal, workflow: validated.compiled.workflow, validation: validated.compiled.validation,
        review: { ...completion, structured_output: review } };
    }
    if (!['running', 'blocked'].includes(record.state.status)) return { phase: 'attention', status: record.state.status,
      error: Object.values(record.state.nodes).find(node => node.error)?.error ?? record.state.error };
    const stage = ['expand', 'graph_assembly', 'execution_binding', 'deterministic_validation', 'final'].find(id => record.state.nodes[id].status !== 'succeeded');
    return { phase: stage === 'expand' ? 'generating' : stage === 'final' ? 'reviewing' : 'host_compiling', stage, status: record.state.status,
      sequence: record.sequence, progress: { nodes: Object.fromEntries(Object.entries(record.state.nodes).map(([id, node]) => [id, { status: node.status, attempts: node.attempts.length }])) } };
  }
  async afterReview(runId, authority) {
    const service = this.service, record = await service.runtime.runs.read(runId), provenance = record.pins.root.provenance;
    const attempt = record.state.nodes.final.attempts.at(-1), completion = await service.runtime.runs.readExecutorResult(runId, attempt.id, attempt.result_proposal.sha256);
    const resources = await service.store.resources(provenance.source_workflow_id, provenance.source_revision);
    const review = evaluateReview(completion.structured_output, record.state.nodes.expand.output.proposal, resources, { version: provenance.review_contract_version });
    if (review.approved && !review.findings.length) return { awaiting_acceptance: true };
    if (review.host_findings.length) throw Object.assign(new Error('Reviewer found Host-owned compiler or evidence errors; semantic retry cannot fix them'), { code: 'GENERATION_HOST_REVIEW_FINDINGS', findings: review.host_findings });
    if (!await this.automaticSemanticRepairAllowed(record)) throw Object.assign(new Error('Review-only recheck retained the findings; automatic semantic repair is disabled'), { code: 'GENERATION_RECHECK_REVIEW_FINDINGS', findings: review.findings });
    if (review.semantic_findings.length) {
      const repair = await repairGeneration(service.runtime, { run_id: runId, ...authority }, record, { code: 'GENERATION_REVIEW_FINDINGS', findings: review.semantic_repair_targets?.length ? review.semantic_repair_targets : review.semantic_findings });
      return { authoring_phase: repair.phase, ...(repair.phase === 'repairing' ? {} : { awaiting_user_input: true }) };
    }
    throw Object.assign(new Error('Reviewer found Host-owned compiler or evidence errors; semantic retry cannot fix them'), { code: 'GENERATION_HOST_REVIEW_FINDINGS', findings: review.host_findings });
  }
  async repairFailure(runId, authority, error) {
    const service = this.service, record = await service.runtime.runs.read(runId);
    if (!await this.automaticSemanticRepairAllowed(record)) throw error;
    const feedback = { code: error.code, message: error.message, findings: error.findings ?? [], validation: error.validation ?? null };
    if (!semanticGenerationRepair(feedback) || !feedback.findings.length) throw error;
    const result = await repairGeneration(service.runtime, { run_id: runId, ...authority }, record, feedback);
    if (result.phase !== 'repairing') await service.notify({ run_id: runId, status: result.phase, result });
    return result.phase === 'repairing';
  }
  async automaticSemanticRepairAllowed(record) {
    const replay = record.state.nodes.expand.attempts.find(attempt => attempt.dispatch?.receipt?.executor === 'host-generation-replay');
    if (!replay) return true;
    const completion = await this.service.runtime.runs.readExecutorResult(record.state.run_id, replay.id, replay.result_proposal.sha256);
    const identity = completion.evidence?.find(item => item.kind === 'host_generation_recheck');
    requireValue(typeof identity?.allow_semantic_repair === 'boolean', 'GENERATION_RECHECK_IDENTITY', 'Retained replay has no immutable semantic repair policy');
    return identity.allow_semantic_repair;
  }
  async continue(args) {
    const service = this.service; requireValue(!service.active.has(args.run_id), 'PI_RUN_BUSY', 'Authoring owner is still active');
    const result = await continueGenerationRepair(service.runtime, { ...args, ...await service.authority(args.run_id) }); await service.launchDriver(args.run_id); return result;
  }
  async accept(args) {
    const service = this.service; requireValue(args.accepted === true, 'GENERATION_ACCEPTANCE', 'Review and explicitly accept the exact proposal');
    requireValue(!service.active.has(args.run_id), 'PI_RUN_BUSY', 'Wait until the authoring owner settles');
    let record = await service.runtime.runs.read(args.run_id); const provenance = record.pins.root.provenance;
    requireValue(isAuthoringRunProvenance(provenance), 'GENERATION_RUN', 'Selected Run is not an authoring Run');
    requireValue(provenance.review_contract_version === CONVERSION_CONTRACT.version, 'CONVERSION_REVIEW_CONTRACT_STALE', 'Historical authoring Runs must be rechecked under the current conversion contract before publication');
    requireValue(!args.workflow_id || args.workflow_id === provenance.source_workflow_id, 'EXPANSION_RESULT_IDENTITY', 'Acceptance belongs to a different source Workflow');
    requireValue(!args.expected_revision || args.expected_revision === provenance.source_revision, 'EXPANSION_RESULT_IDENTITY', 'Acceptance belongs to a different source revision');
    const attempt = record.state.nodes.final.attempts.find(item => item.id === record.state.nodes.final.active_attempt_id);
    requireValue(attempt?.result_proposal?.sha256 && args.proposal_sha256 === attempt.result_proposal.sha256,
      'PI_FINAL_CHANGED', 'Acceptance must identify the exact reviewer artifact the human reviewed');
    const observation = await this.observe(args); requireValue(['review_required', 'ready_to_apply'].includes(observation.phase), 'GENERATION_REVIEW_BLOCKED', 'Review has not passed');
    const authority = await service.authority(args.run_id), identity = authoringReviewIdentity(record);
    let deployed = await service.store.snapshot(provenance.source_workflow_id);
    const matchesDeployment = pack => pack.provenance?.kind === 'workflow_conversion'
      && pack.provenance.conversion?.source_revision === provenance.source_revision
      && pack.provenance.conversion?.proposal_hash === identity.proposal_hash;
    requireValue(matchesDeployment(deployed) || deployed.revision_hash === provenance.source_revision,
      'REVISION_CONFLICT', 'Source changed before accepted conversion publication');
    if (record.state.status !== 'succeeded') {
      await service.runtime.acceptAuthoringFinal(args.run_id, { ...authority, node_id: 'final', attempt_id: attempt.id,
        lease_token: leaseToken(authority.control_token, args.run_id, 'final', attempt.id, attempt.lease_generation ?? 0) });
      record = await service.runtime.runs.read(args.run_id);
    }
    const accepted = record.state.nodes.final.attempts.find(item => item.id === record.state.nodes.final.active_attempt_id)?.human_acceptance;
    requireValue(accepted?.review_result_sha256 === args.proposal_sha256 && canonicalJSON({ proposal_hash: accepted.proposal_hash,
      source_revision: accepted.source_revision, expand_attempt_id: accepted.expand_attempt_id }) === canonicalJSON(identity),
    'GENERATION_REVIEW_BLOCKED', 'Publication requires the durable human receipt for this exact proposal and checklist review');
    if (!matchesDeployment(deployed)) {
      const resources = await service.store.resources(deployed.workflow.id, provenance.source_revision);
      const context = { ...service.runtime.context, routing_rules: provenance.routing_rules, routing_catalog: provenance.routing_catalog };
      const validated = validateGenerationProposal(record.state.nodes.expand.output, { pack: deployed, resources, provenance, context,
        previousPlan: record.state.generation_repair?.previous_proposal, repairFeedback: record.state.generation_repair?.feedback });
      requireValue(validated.compiled.workflow.import_status.conversion_level !== 'unsupported', 'CONVERSION_UNSUPPORTED', 'Unsupported semantics cannot be published');
      try {
        deployed = await applyExpansion(service.store, deployed.workflow.id, validated.proposal, { expected_revision: provenance.source_revision,
          context, inference_confirmation: 'Authenticated human acceptance is bound to this exact canonical proposal and independent checklist review.',
          conversion_review_contract_version: CONVERSION_CONTRACT.version });
      } catch (cause) {
        const committed = await service.store.snapshot(provenance.source_workflow_id);
        if (!matchesDeployment(committed)) throw cause;
        deployed = committed;
      }
    }
    const authoring_cleanup = await this.beginCleanup(record, deployed, authority.control_token);
    return { ...deployed, authoring_cleanup };
  }
  async recheck(args) {
    requireValue(typeof args.source_run_id === 'string' && args.source_run_id.length > 0, 'GENERATION_RECHECK_SOURCE', 'Recheck needs a source authoring Run');
    requireValue(args.allow_semantic_repair === undefined || typeof args.allow_semantic_repair === 'boolean', 'GENERATION_RECHECK_SOURCE', 'allow_semantic_repair must be an explicit boolean');
    requireValue(args.source_revision === undefined || /^[a-f0-9]{64}$/.test(args.source_revision), 'GENERATION_RECHECK_SOURCE', 'source_revision must identify an exact source revision');
    requireValue(args.source_attempt_id === undefined || typeof args.source_attempt_id === 'string' && args.source_attempt_id.length > 0,
      'GENERATION_RECHECK_SOURCE', 'source_attempt_id must identify an exact retained planner attempt');
    const service = this.service, prior = await service.runtime.runs.read(args.source_run_id);
    requireValue(isAuthoringRunProvenance(prior.pins.root.provenance), 'GENERATION_RECHECK_SOURCE', 'Source Run is not authoring');
    const attempt=selectRetainedAuthoringAttempt(prior,args.source_attempt_id);
    const completion = await service.runtime.runs.readExecutorResult(args.source_run_id, attempt.id, attempt.result_proposal.sha256);
    requireValue(completion?.status === 'succeeded' && completion.structured_output, 'GENERATION_RECHECK_SOURCE', 'The planner artifact must be a successful structured completion');
    const previousProvenance = prior.pins.root.provenance;
    requireValue(!args.workflow_id || args.workflow_id === previousProvenance.source_workflow_id, 'GENERATION_RECHECK_SOURCE', 'Recheck belongs to a different source Workflow');
    const selectedRevision = args.source_revision ?? previousProvenance.source_revision;
    const previousPack = await service.store.snapshot(previousProvenance.source_workflow_id, previousProvenance.source_revision);
    const previousResources = await service.store.resources(previousPack.workflow.id, previousPack.revision_hash);
    const pack = selectedRevision === previousPack.revision_hash ? previousPack : await service.store.snapshot(previousPack.workflow.id, selectedRevision);
    const resources = selectedRevision === previousPack.revision_hash ? previousResources : await service.store.resources(pack.workflow.id, selectedRevision);
    const refresh = validateAuthoringSourceRefresh(previousPack, pack, previousResources, resources);
    // Registry conflicts are mechanical even when an earlier semantic finding
    // would prevent the compiler from reaching Host-tool binding.
    const available = new Map();
    for (const raw of [...(pack.workflow.host_tools ?? []), ...(service.runtime.context.host_tool_contracts ?? [])]) {
      const contract = validateHostToolContract(raw), existing = available.get(contract.id);
      requireValue(!existing || canonicalJSON(existing) === canonicalJSON(contract), 'EXPANSION_HOST_TOOL_CONFLICT', 'A host-tool ID has conflicting pinned contracts');
      available.set(contract.id, contract);
    }
    const provenance = { ...previousProvenance, source_revision: selectedRevision };
    const retained=retainedAuthoringReplaySource(prior,attempt,completion);
    let sourceOutput=retained.sourceOutput;
    let plan = decodeGeneratedEnvelope(sourceOutput);
    const requireDependencyAssessment = authoringDependencyAssessmentRequired(provenance.authoring_contract);
    let repairTargetRefresh=null;
    if (plan.contract === SEMANTIC_REPAIR_CONTRACT) {
      const base=retained.previousPlan;
      requireValue(base?.contract === SEMANTIC_BLUEPRINT_CONTRACT, 'AUTHORING_REPAIR_STATE', 'Retained patch has no exact current cumulative blueprint base');
      const patch = canonicalizeSemanticRepair(plan);
      validateData(patch, SEMANTIC_REPAIR_SCHEMA);
      const refreshed=refreshRetainedRepairTargets(base,retained.repairFeedback,{currentSourceRequirements:observedSourceRequirements(resources),
        validate:proposal=>validateGenerationProposal({proposal},{pack,resources,provenance,context:service.runtime.context})});
      repairTargetRefresh=refreshed.receipt;
      plan = applySemanticRepair(base, patch, { targets: refreshed.targets });
      sourceOutput = { proposal: plan };
    }
    if (plan.contract === SEMANTIC_BLUEPRINT_CONTRACT) validateSemanticBlueprintContract(plan, { requireDependencyAssessment });
    let validated, semanticFeedback = null;
    try {
      validated = validateGenerationProposal(sourceOutput, { pack, resources, provenance, context: service.runtime.context });
    } catch (error) {
      if (args.allow_semantic_repair !== true || plan.contract !== SEMANTIC_BLUEPRINT_CONTRACT || !semanticGenerationRepair(error)) throw error;
      const feedback = { code: error.code, message: error.message, findings: error.findings };
      const targets = validateRepairTargets(plan, feedback, { currentSourceRequirements: observedSourceRequirements(resources) });
      requireValue(targets.valid, 'GENERATION_RECHECK_REPAIR_TARGET', targets.diagnostic, { cause_code: error.code, findings: error.findings });
      semanticFeedback = feedback;
    }
    const replayOutput = validated?.authoring_plan ? { proposal: validated.authoring_plan } : sourceOutput;
    // Start with the driver held until the immutable replay is committed. A
    // review-only Run can never race the normal planner dispatch path.
    const started = await this.start({ workflow_id: provenance.source_workflow_id, revision_hash: provenance.source_revision,
      run_id: args.run_id, routing_rules: provenance.routing_rules }, { launch: false });
    const control = { control_token: started.control_token }, state = await service.runtime.get(started.run_id);
    const lease = await service.runtime.claimNode(started.run_id, { ...control, node_id: 'expand', owner: state.main_actor,
      request_id: `generation-recheck-${digest(args.source_run_id).slice(0, 16)}` });
    const replayIdentity = { source_run_id: args.source_run_id, source_attempt_id: attempt.id, result_sha256: attempt.result_proposal.sha256,
      materialized_sha256: digest(canonicalJSON(replayOutput)), source_revision: provenance.source_revision,
      source_contract_refresh: refresh, initial_planner_invoked: false,semantic_source:retained.origin,
      allow_semantic_repair: args.allow_semantic_repair === true, semantic_feedback: semanticFeedback,
      ...(repairTargetRefresh?{repair_target_refresh:repairTargetRefresh}:{}) };
    const request_id = `replay-${digest(canonicalJSON(replayIdentity)).slice(0, 32)}`;
    const dispatch = { ...control, ...lease, request_id, envelope_hash: digest(canonicalJSON(replayIdentity)) };
    await service.runtime.recordDispatchIntent(started.run_id, dispatch);
    await service.runtime.recordDispatchReceipt(started.run_id, { ...dispatch, receipt: { task_id: args.source_run_id,
      invocation_id: attempt.id, executor: 'host-generation-replay', result_sha256: replayIdentity.materialized_sha256,
      source_result_sha256: attempt.result_proposal.sha256 } });
    const replayCompletion = { status: 'succeeded', summary: `Reused the completed planner proposal from ${args.source_run_id}; no planner model was invoked.`,
      structured_output: replayOutput, artifacts: [], changed_paths: [], outside_paths: [], evidence: [{ kind: 'host_generation_recheck', ...replayIdentity }] };
    const durable = await service.runtime.runs.saveExecutorResult(started.run_id, lease.attempt_id, replayCompletion);
    await service.runtime.recordExecutorEvent(started.run_id, { ...control, ...lease, event: { kind: 'result_proposed',
      metadata: { ...durable, final_acceptance_required: false } } });
    await service.runtime.completeNode(started.run_id, { ...lease, completion: replayCompletion });
    await service.launchDriver(started.run_id);
    return { ...started, recheck: { ...replayIdentity, planner_invoked: false,
      conversion_level: validated?.compiled.workflow.import_status.conversion_level ?? null } };
  }
  async acceptRecheckedReview(args) {
    const service = this.service;
    requireValue(args.accepted === true, 'GENERATION_ACCEPTANCE', 'Rechecked reviewer acceptance must be explicit');
    requireValue(!service.active.has(args.run_id), 'PI_RUN_BUSY', 'Wait for the authoring owner to settle before rechecking its review');
    const authority = await service.authority(args.run_id), record = await service.runtime.runs.read(args.run_id), provenance = record.pins.root.provenance;
    if (args.control_token) await service.runtime.authorizeController(args.run_id, args);
    requireValue(isAuthoringRunProvenance(provenance) && record.state.nodes.expand?.status === 'succeeded',
      'GENERATION_RECHECK_REVIEW', 'Review recheck needs a completed canonical proposal');
    requireValue(record.state.generation_repair?.feedback?.code === 'GENERATION_CHECKLIST_INVALID' && record.state.nodes.final?.status === 'ready',
      'GENERATION_RECHECK_REVIEW', 'Run is not waiting after a Host-checklist rejection');
    requireValue(provenance.review_contract_version === CONVERSION_CONTRACT.version, 'CONVERSION_REVIEW_CONTRACT_STALE', 'Rechecked publication requires the current conversion contract');
    requireValue(!args.workflow_id || args.workflow_id === provenance.source_workflow_id, 'EXPANSION_RESULT_IDENTITY', 'Rechecked acceptance belongs to a different source Workflow');
    requireValue(!args.expected_revision || args.expected_revision === provenance.source_revision, 'EXPANSION_RESULT_IDENTITY', 'Rechecked acceptance belongs to a different source revision');
    const attempt = [...record.state.nodes.final.attempts].reverse().find(item => item.status === 'failed'
      && item.result_proposal && item.error?.code === 'GENERATION_REVIEW_REJECTED');
    requireValue(attempt?.dispatch?.receipt && attempt.executor_events?.some(event => event.kind === 'session_state' && event.metadata.status === 'closed'),
      'GENERATION_RECHECK_REVIEW', 'No closed durable reviewer artifact is available');
    requireValue(attempt.result_proposal.sha256 === args.proposal_sha256, 'PI_FINAL_CHANGED', 'Rechecked acceptance must identify the exact reviewer artifact the human reviewed');
    const expected = authoringReviewIdentity(record);
    const artifactIdentity = value => ({ proposal_hash: value.proposal_hash, source_revision: value.source_revision, expand_attempt_id: value.expand_attempt_id });
    requireValue(canonicalJSON(artifactIdentity(attempt.result_proposal)) === canonicalJSON(expected)
      && canonicalJSON(attempt.dispatch.receipt.authoring_review_context) === canonicalJSON(expected),
    'AUTHORING_REVIEW_IDENTITY', 'Persisted review is not bound to the current canonical proposal');
    const pack = await service.store.snapshot(provenance.source_workflow_id, provenance.source_revision);
    requireValue((await service.store.snapshot(provenance.source_workflow_id)).revision_hash === pack.revision_hash,
      'REVISION_CONFLICT', 'Source changed before rechecked review acceptance');
    const resources = await service.store.resources(pack.workflow.id, pack.revision_hash);
    const validated = validateGenerationProposal(record.state.nodes.expand.output, { pack, resources, provenance,
      context: service.runtime.context, previousPlan: record.state.generation_repair?.previous_proposal,
      repairFeedback: record.state.generation_repair?.feedback });
    const completion = await service.runtime.runs.readExecutorResult(args.run_id, attempt.id, attempt.result_proposal.sha256);
    const review = evaluateReview(completion.structured_output, validated.proposal, resources, { version: provenance.review_contract_version });
    requireValue(review.approved === true && review.findings.length === 0, 'GENERATION_REVIEW_BLOCKED', 'The persisted reviewer artifact still has material findings');
    await service.runtime.transition(args.run_id, 'generation_review_recheck', (state, pins) => {
      requireValue(state.control_hash === digest(authority.control_token) && state.nodes.final.status === 'ready',
        'RUN_SEQUENCE_CONFLICT', 'Review state changed before rechecked acceptance');
      const current = state.nodes.final.attempts.find(item => item.id === attempt.id);
      requireValue(current?.status === 'failed' && current.result_proposal?.sha256 === args.proposal_sha256,
        'GENERATION_RECHECK_REVIEW', 'Reviewer artifact identity changed');
      requireValue(canonicalJSON(authoringReviewIdentity({ state, pins })) === canonicalJSON(expected)
        && canonicalJSON(artifactIdentity(current.result_proposal)) === canonicalJSON(expected)
        && canonicalJSON(current.dispatch?.receipt?.authoring_review_context) === canonicalJSON(expected),
      'AUTHORING_REVIEW_IDENTITY', 'Reviewer identity changed before rechecked acceptance');
      state.nodes.final.active_attempt_id = current.id; state.nodes.final.status = 'running'; state.nodes.final.error = null;
      current.status = 'running'; delete current.error; delete current.finished_at;
      current.reconciliation = { kind: 'host_review_recheck', result_sha256: current.result_proposal.sha256,
        previous_feedback: state.generation_repair.feedback, at: new Date().toISOString(), resubmitted: false };
      state.generation_repair.awaiting_user_input = false;
      state.status = 'running'; state.updated_at = new Date().toISOString();
    }, { expected_sequence: record.sequence });
    return this.accept({ ...args, workflow_id: provenance.source_workflow_id, expected_revision: provenance.source_revision });
  }
  async beginCleanup(record, deployed, controlToken) {
    requireDeployableConvertedSnapshot(deployed);
    const service = this.service, provenance = record.pins.root.provenance, runId = record.state.run_id;
    const final = record.state.nodes.final, attempt = final.attempts.find(item => item.id === final.active_attempt_id), acceptance = attempt?.human_acceptance;
    requireValue(record.state.status === 'succeeded' && attempt?.status === 'succeeded', 'RUN_PURGE_STATE', 'Cleanup requires a succeeded accepted authoring Run');
    requireValue(acceptance?.review_result_sha256 === attempt.result_proposal?.sha256
      && acceptance.proposal_hash === deployed.provenance.conversion?.proposal_hash
      && acceptance.source_revision === provenance.source_revision && deployed.workflow.id === provenance.source_workflow_id
      && deployed.provenance.conversion?.source_revision === provenance.source_revision,
    'AUTHORING_PURGE_DEPLOYMENT', 'Cleanup requires the exact accepted proposal, reviewer result and source-free publication');
    requireValue(record.state.control_hash === digest(controlToken), 'RUN_AUTHORITY', 'Cleanup authority differs from the accepted Run');
    const managedWorkspace = insideRoot(resolve(join(service.directory, 'authoring-workspaces')),
      resolve(join(service.directory, 'authoring-workspaces', workflowId(runId))));
    const prepared = { identity: { run_id: runId, control_hash: record.state.control_hash,
      source_workflow_id: provenance.source_workflow_id, source_revision: provenance.source_revision,
      proposal_hash: acceptance.proposal_hash, review_result_sha256: acceptance.review_result_sha256,
      deployed_revision: deployed.revision_hash, authoring_workflow_id: record.pins.root.workflow.id,
      authoring_revision: record.pins.root.revision_hash },
    targets: { workspace: record.state.permissions.workspace, managed_workspace: resolve(record.state.permissions.workspace) === managedWorkspace,
      job_workflow_id: record.pins.root.workflow.id, job_revision: record.pins.root.revision_hash } };
    const journal = await service.store.beginAuthoringCleanup(provenance.source_workflow_id, prepared);
    return this.cleanup(journal, deployed);
  }
  async purge(args) {
    const service = this.service;
    requireValue(typeof args.workflow_id === 'string', 'AUTHORING_CLEANUP_IDENTITY', 'Cleanup retry needs the published Workflow ID');
    const journal = await service.store.readAuthoringCleanup(args.workflow_id, args.run_id);
    const control = args.control_token ? { control_token: args.control_token } : await service.authority(args.run_id);
    requireValue(journal && journal.identity.control_hash === digest(control.control_token), 'RUN_AUTHORITY', 'Cleanup retry needs the exact retained transaction authority');
    requireValue(!service.active.has(args.run_id), 'PI_RUN_BUSY', 'Wait for the authoring owner to settle before cleanup');
    return this.cleanup(journal, await service.store.snapshot(args.workflow_id, journal.identity.deployed_revision));
  }
  async cleanup(journal, deployed) {
    const service = this.service, { identity, targets } = journal;
    requireDeployableConvertedSnapshot(deployed);
    requireValue(deployed.workflow.id === identity.source_workflow_id && deployed.revision_hash === identity.deployed_revision
      && deployed.provenance.conversion?.proposal_hash === identity.proposal_hash,
    'AUTHORING_CLEANUP_IDENTITY', 'Published Workflow changed after cleanup intent was recorded');
    requireValue(!service.active.has(identity.run_id), 'PI_RUN_BUSY', 'An execution owner still holds the accepted authoring Run');
    const jobs = await new WorkflowStore(join(service.directory, 'authoring-jobs'), { validationContext: service.runtime.context }).initialize();
    const mark = step => service.store.markAuthoringCleanup(identity.source_workflow_id, identity.run_id, identity, step);
    try {
      if (!journal.steps.library) {
        await service.store.resumeHistoryPurge(identity.source_workflow_id, identity.deployed_revision, { beforePurge: async () => {
          for (const item of await service.runtime.runs.list()) {
            if (item.run_id === identity.run_id || ['succeeded', 'failed', 'cancelled'].includes(item.status)) continue;
            const sibling = await service.runtime.runs.read(item.run_id), provenance = sibling.pins.root.provenance;
            requireValue(!(isAuthoringRunProvenance(provenance) && provenance.source_workflow_id === identity.source_workflow_id),
              'AUTHORING_CLEANUP_CONFLICT', 'Another unfinished authoring Run still owns the source history',
              { conflicting_run_id: item.run_id, conflicting_source_revision: provenance?.source_revision });
          }
        } });
        journal = await mark('library');
      }
      if (!journal.steps.workspace) {
        // Caller-provided workspaces belong to the user. Only the exact managed
        // authoring directory can be removed, even on a cleanup retry.
        if (targets.managed_workspace) {
          const root = resolve(join(service.directory, 'authoring-workspaces'));
          const expected = insideRoot(root, resolve(join(root, workflowId(identity.run_id))));
          requireValue(resolve(targets.workspace) === expected, 'AUTHORING_WORKSPACE_OWNERSHIP', 'Cleanup workspace differs from the exact Host-owned directory');
          try {
            await noSymlinks(expected); const info = await lstat(expected);
            requireValue(info.isDirectory() && !info.isSymbolicLink(), 'AUTHORING_WORKSPACE_OWNERSHIP', 'Managed workspace must be one exact directory');
            await rm(expected, { recursive: true, maxRetries: 3, retryDelay: 100 });
          } catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        journal = await mark('workspace');
      }
      if (!journal.steps.job) {
        await jobs.purge(targets.job_workflow_id, targets.job_revision, { expected_provenance_kind: 'authoring_workflow_run', allow_missing: true });
        journal = await mark('job');
      }
      if (!journal.steps.run) {
        // The independent owner must retain accepted terminal evidence before
        // this private journal disappears. Publication RPC remains in flight.
        await service.beforeRunPurge?.({ run_id: identity.run_id, status: 'succeeded',
          publication: 'accepted_cleanup_pending', deployed_workflow_id: deployed.workflow.id, deployed_revision: deployed.revision_hash });
        await service.runtime.runs.purge(identity.run_id, { expected_workflow_id: identity.authoring_workflow_id,
          expected_revision: identity.authoring_revision, expected_source_workflow_id: identity.source_workflow_id,
          expected_source_revision: identity.source_revision, allow_missing: true });
        journal = await mark('run');
      }
      return { private_authoring_artifacts_purged: journal.status === 'complete',
        cleanup_transaction: { run_id: identity.run_id, status: journal.status, steps: journal.steps },
        ...(targets.managed_workspace ? {} : { retained_user_workspace: targets.workspace }) };
    } catch (cause) {
      throw Object.assign(new Error(`Workflow ${deployed.workflow.id}@${deployed.revision_hash} was published, but exact private authoring cleanup did not finish: ${cause.message}`),
        { code: 'AUTHORING_PURGE_INCOMPLETE', deployed_workflow_id: deployed.workflow.id, deployed_revision: deployed.revision_hash,
          cause_code: cause.code ?? 'UNKNOWN', cause });
    }
  }
}
