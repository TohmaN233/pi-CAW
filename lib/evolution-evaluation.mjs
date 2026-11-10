import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { PiCawService } from './service.mjs';
import { WorkflowRunStore } from '../core/workflow-run-store.mjs';
import { resolveWorkflowPins } from '../core/workflow-pins.mjs';
import { canonicalJSON, digest, prepareResources, revisionHash } from '../core/workflow-revisions.mjs';
import { requireValue, noSymlinks } from '../core/workflow-paths.mjs';
import { requireWorkflowSnapshotIntegrity } from '../core/workflow-ready-validation.mjs';
import { certificateForPublishedWorkflow } from '../core/skill-import/conversion-certificate.mjs';
import { workflowProviderIds } from './workflow-bindings.mjs';
import { resolveBinding } from './models.mjs';
import { mergeHostTools } from './external-host-tools.mjs';

const hash = value => digest(canonicalJSON(value));
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const same = (a, b) => canonicalJSON(a) === canonicalJSON(b);
const fail = (condition, message) => requireValue(condition, 'EVOLUTION_QUALIFICATION', message);
const encode = resources => Object.fromEntries(Object.entries(resources).map(([path, bytes]) => [path, Buffer.from(bytes).toString('base64')]));
const decode = resources => Object.fromEntries(Object.entries(resources).map(([path, bytes]) => [path, Buffer.from(bytes, 'base64')]));

function mainBinding(host) {
  const ctx = host.getContext?.();
  const model = ctx?.model;
  fail(model?.provider && model.id && typeof ctx.thinkingLevel === 'string', 'The Host must expose the actual inherited Main model and thinking level');
  return resolveBinding({ provider: model.provider, model_id: model.id, thinking: ctx.thinkingLevel }, host.catalog());
}

// Explicit SDK/adapter identities cover native code and closure state that cannot
// be established from Function.toString. Actual registered function bytes and the
// local Host implementation files are recorded as additional evidence.
async function implementation(service, identity) {
  const manifest = {};
  for (const category of ['sdk_files', 'host_files']) {
    fail(Array.isArray(identity?.[category]) && identity[category].length >= 1 && identity[category].length <= 128, 'Explicit SDK and Host adapter implementation file manifests are required');
    manifest[category] = [];
    for (const path of identity[category]) {
      fail(typeof path === 'string' && resolve(path) === path, 'Implementation files must have exact absolute paths');
      await noSymlinks(path); manifest[category].push({ path, sha256: digest(await readFile(path)) });
    }
  }
  const files = {};
  for (const name of ['evolution-evaluation.mjs', 'service.mjs', 'pi-sdk-host.mjs', 'task-broker.mjs', 'task-prompt.mjs', 'native-mcp.mjs',
    '../core/workflow-runtime.mjs', '../core/workflow-run-store.mjs', '../core/workflow-state.mjs', '../core/workflow-loops.mjs',
    '../core/workflow-events.mjs', '../core/workflow-execution-envelope.mjs', '../core/execution/program-broker.mjs',
    '../core/execution/host-tool-runner.mjs', '../core/execution/host-main-automation.mjs'])
    files[name] = digest(await readFile(new URL(name, import.meta.url)));
  const tools = Object.fromEntries(Object.entries(mergeHostTools(service.builtinHostTools, service.getHostTools())).sort(([a], [b]) => a.localeCompare(b)).map(([id, tool]) => [id, {
    identity: tool.identity ?? null, execute_sha256: digest(String(tool.execute)), cancel_sha256: digest(String(tool.cancel)),
  }]));
  return { ...manifest, files, tools };
}

function suiteContract(suite) {
  fail(suite && typeof suite.id === 'string' && suite.id.length > 0 && suite.id.length <= 128, 'A named local suite is required');
  fail(Number.isSafeInteger(suite.repetitions) && suite.repetitions >= 1 && suite.repetitions <= 5, 'Suite repetitions must be 1..5');
  fail(Array.isArray(suite.samples) && suite.samples.length >= 1 && suite.samples.length <= 32, 'Suite samples must be 1..32');
  const ids = new Set();
  for (const sample of suite.samples) {
    fail(typeof sample.id === 'string' && sample.id.length > 0 && !ids.has(sample.id), 'Suite sample IDs must be unique'); ids.add(sample.id);
    fail(sample.inputs && typeof sample.inputs === 'object' && !Array.isArray(sample.inputs), 'Each sample requires explicit JSON inputs');
    fail(Array.isArray(sample.assertions) && sample.assertions.length >= 1 && sample.assertions.length <= 128, 'Every sample requires objective assertions');
    for (const assertion of sample.assertions) fail(typeof assertion.pointer === 'string'
      && (assertion.pointer === '' || /^\/(?:[^~]|~[01])*$/.test(assertion.pointer)) && Object.hasOwn(assertion, 'equals')
      && Object.keys(assertion).every(key => ['pointer', 'equals'].includes(key)), 'Assertions are exact JSON Pointer/equals pairs');
    fail(sample.files === undefined || sample.files && typeof sample.files === 'object' && !Array.isArray(sample.files), 'Sample files must map relative paths to UTF-8 text');
    prepareResources(sample.files ?? {});
  }
  fail(suite.trial_timeout_ms === undefined || Number.isSafeInteger(suite.trial_timeout_ms) && suite.trial_timeout_ms >= 1000 && suite.trial_timeout_ms <= 3600000, 'Trial deadline must be 1 second through 1 hour');
  fail(Object.keys(suite).every(key => ['id', 'repetitions', 'samples', 'trial_timeout_ms'].includes(key)), 'Unknown suite field');
  return { ...structuredClone(suite), trial_timeout_ms: suite.trial_timeout_ms ?? 120000 };
}

function score(output, assertions) {
  return assertions.map(assertion => {
    let value = output, present = true;
    for (const token of assertion.pointer === '' ? [] : assertion.pointer.slice(1).split('/').map(token => token.replace(/~1/g, '/').replace(/~0/g, '~'))) {
      if (value === null || typeof value !== 'object' || !Object.hasOwn(value, token)) { present = false; break; }
      value = value[token];
    }
    return { pointer: assertion.pointer, passed: present && same(value, assertion.equals) };
  });
}

function privateSnapshot(candidate, variant) {
  if (variant === 'baseline') return structuredClone(candidate.packs[0].snapshot);
  fail(variant === 'candidate', 'Unknown trial variant');
  const snapshot = { ...candidate.candidate, workflow: { ...candidate.candidate.workflow, status: 'ready' } };
  snapshot.import_report = certificateForPublishedWorkflow(snapshot);
  snapshot.revision_hash = revisionHash(snapshot);
  return snapshot;
}

function verifyTrialPins(candidate, trial, record) {
  fail(same(record.pins.root, privateSnapshot(candidate, trial.variant)), 'Trial Run pins do not match the captured baseline/candidate');
  fail(record.state.permissions.workspace === trial.workspace && record.state.main_actor === trial.parent_session, 'Trial Run workspace or parent session differs from its receipt');
  const sample = candidate.suite.samples.find(item => item.id === trial.sample_id);
  const inputs = { ...sample?.inputs };
  if (!Object.hasOwn(inputs, 'project_root') && record.pins.root.workflow.inputs_schema?.properties?.project_root?.type === 'string') inputs.project_root = trial.workspace;
  fail(sample && same(record.state.inputs, inputs), 'Trial Run inputs differ from its paired suite sample');
  for (const retained of candidate.packs) {
    const id = retained.snapshot.workflow.id, providers = record.pins.workflow_providers[id];
    fail(Array.isArray(providers) && same(providers.map(provider => provider.id).sort(), Object.keys(retained.bindings).sort()), 'Trial Provider slots differ from the frozen local bindings');
    for (const provider of providers) {
      const binding = retained.bindings[provider.id];
      fail(provider.config.provider === binding.provider && provider.config.model === binding.model_id && provider.config.thinking === binding.thinking, 'Trial Provider model differs from the frozen local binding');
    }
    fail(record.pins.workflow_binding_revisions[id]?.local === true, 'Trial used ambient Provider fallback');
  }
}

async function finalResult(runs, record) {
  const finalId = record.pins.root.workflow.finalization.node_id;
  const final = record.state.nodes[finalId];
  const attempt = final?.attempts.at(-1);
  const definition = record.pins.root.workflow.nodes.find(node => node.id === finalId);
  const terminal = record.state.status === 'succeeded';
  fail(attempt, 'Trial has no exact final result proposal');
  fail(terminal || definition.type === 'agent' && record.state.status === 'running' && attempt.result_proposal && final.status === 'running', 'Trial did not reach a final result proposal');
  for (const node of record.pins.root.workflow.nodes) {
    if (node.id === finalId || node.type === 'end') continue;
    fail(['succeeded', 'skipped'].includes(record.state.nodes[node.id].status), `Trial stopped at incomplete node ${node.id}`);
  }
  if (definition.type === 'tool') {
    const receipt = attempt.host_tool?.receipt;
    fail(terminal && final.status === 'succeeded' && receipt?.status === 'succeeded' && receipt.output_ref?.sha256
      && attempt.completion?.status === 'succeeded' && hash(attempt.completion) === attempt.completion_hash, 'Deterministic finalizer lacks exact successful completion evidence');
    const stored = await runs.readExecutorResult(record.state.run_id, attempt.id, receipt.output_ref.sha256);
    fail(stored.kind === 'host_tool_output' && hash(stored.output) === receipt.output_sha256
      && same(stored.output, attempt.completion.structured_output) && same(stored.output, final.output), 'Deterministic finalizer output differs from its exact Host receipt');
    return { output: stored.output, final_attempt_id: attempt.id, result_sha256: receipt.output_ref.sha256, result_kind: 'host_tool_output', settlement: 'succeeded' };
  }
  fail(attempt.result_proposal?.sha256, 'Trial has no exact final result proposal');
  const completion = await runs.readExecutorResult(record.state.run_id, attempt.id, attempt.result_proposal.sha256);
  fail(completion.status === 'succeeded', 'Final proposal failed');
  return { output: completion.structured_output, final_attempt_id: attempt.id, result_sha256: attempt.result_proposal.sha256,
    result_kind: 'agent_proposal', settlement: terminal ? 'succeeded' : 'awaiting_human_acceptance' };
}

function dispatchSessions(record, frozenMain) {
  const sessions = [];
  for (const node of Object.values(record.state.nodes)) for (const item of node.attempts) {
    const receipt = item.dispatch?.receipt;
    if (!receipt) continue;
    fail(receipt.executor !== 'pi-current-chat-main', 'Evaluation requires isolated Main execution');
    if (receipt.executor === 'pi-isolated-main') fail(receipt.observed_model && same(receipt.observed_model, frozenMain), 'Observed Main model differs from the frozen inherited model');
    for (const session of receipt.sessions ?? (receipt.thread_id ? [receipt] : [])) sessions.push({ thread_id: session.thread_id, session_file: session.session_file });
  }
  return sessions;
}

async function finalEvidence(service, runId, frozenMain) {
  const record = await service.runtime.runs.observe(runId);
  fail(await service.runQuiescent(record), 'Trial ownership or effects have not settled');
  const { output, ...result } = await finalResult(service.runtime.runs, record);
  return { record, output, evidence: {
    run_id: runId, record_sha256: hash(record), pins_sha256: hash(record.pins), sequence: record.sequence,
    ...result, sessions: dispatchSessions(record, frozenMain),
  } };
}

export class WorkflowEvolution {
  constructor({ sourceService, directory, createHost, implementationIdentity }) {
    fail(sourceService instanceof PiCawService, 'Evolution requires an initialized source PiCawService');
    this.source = sourceService; this.directory = resolve(directory); this.createHost = createHost;
    this.implementationIdentity = implementationIdentity; this.hosts = new Set(); this.sessions = new Set();
    const source = resolve(sourceService.directory);
    fail(this.directory !== source && !this.directory.startsWith(source + sep) && !source.startsWith(this.directory + sep), 'Evaluation storage must be separate from source Host storage');
  }
  async put(kind, value) {
    fail(['candidates', 'evaluations', 'failures'].includes(kind), 'Unknown evolution record kind');
    const id = hash(value), path = join(this.directory, kind, id + '.json');
    await mkdir(join(this.directory, kind), { recursive: true }); await noSymlinks(join(this.directory, kind));
    let file;
    try { file = await open(path, 'wx', 0o600); }
    catch (error) { if (error.code !== 'EEXIST') throw error; fail(same(await this.get(kind, id), value), 'Immutable evolution record collision'); return id; }
    try { await file.writeFile(canonicalJSON(value)); await file.sync(); } finally { await file.close(); }
    return id;
  }
  async get(kind, id) {
    fail(['candidates', 'evaluations', 'failures'].includes(kind), 'Unknown evolution record kind');
    fail(sha(id), 'Evolution record ID must be a SHA-256 digest');
    const path = join(this.directory, kind, id + '.json'); await noSymlinks(path);
    const value = JSON.parse(await readFile(path, 'utf8')); fail(hash(value) === id, 'Evolution record content changed'); return value;
  }
  async capture({ workflow_id, expected_revision, workflow, resources, suite, cause, evidence_refs }) {
    const root = await this.source.store.snapshotWithResources(workflow_id, expected_revision);
    fail(root.snapshot.revision_hash === expected_revision && root.snapshot.workflow.status === 'ready', 'Candidate baseline must be an exact Ready revision');
    fail(workflow?.id === workflow_id, 'Candidate must preserve Workflow identity');
    suite = suiteContract(suite);
    fail(typeof cause === 'string' && cause.trim().length > 0 && cause.length <= 2048, 'Candidate requires a bounded causal explanation');
    fail(Array.isArray(evidence_refs) && evidence_refs.length >= 1 && evidence_refs.length <= 32, 'Candidate requires exact bounded source evidence');
    for (const reference of evidence_refs) {
      if (reference.kind === 'human_instruction') {
        fail(typeof reference.text === 'string' && reference.text.trim().length > 0 && reference.text.length <= 4096
          && digest(reference.text) === reference.sha256 && Object.keys(reference).every(key => ['kind', 'text', 'sha256'].includes(key)), 'Human instruction evidence hash must match its exact bounded text');
      } else {
        fail(typeof reference.source_ref === 'string' && reference.source_ref.length > 0 && reference.source_ref.length <= 2048 && sha(reference.sha256)
          && Object.keys(reference).every(key => ['source_ref', 'sha256'].includes(key)), 'Proposal evidence requires a bounded exact source reference and SHA-256 identity');
      }
    }
    const candidateWorkflow = { ...structuredClone(workflow), status: 'draft', revision: root.snapshot.workflow.revision + 1 };
    this.source.store.validate(candidateWorkflow);
    const candidateResources = resources ?? root.resources, prepared = prepareResources(candidateResources);
    const candidate = { ...root.snapshot, workflow: candidateWorkflow, resources: prepared.manifest }; delete candidate.revision_hash;
    requireWorkflowSnapshotIntegrity(candidate, { previous: root.snapshot });
    const closure = await resolveWorkflowPins(this.source.store, root.snapshot, { rootResources: root.resources });
    const ids = new Set(), packs = [];
    for (const pack of closure.packs) {
      fail((pack.workflow.loops ?? []).every(loop => Number.isSafeInteger(loop.max_rounds) && loop.max_rounds > 0), 'Evaluation requires finite Workflow loop bounds');
      fail(!ids.has(pack.workflow.id), 'Evaluation currently requires one exact revision per Workflow identity in the closure'); ids.add(pack.workflow.id);
      const local = await this.source.workflowBindings.read(pack);
      fail(!workflowProviderIds(pack.workflow).length || local.local && !local.stale, `Explicit Workflow-local Provider bindings are required for ${pack.workflow.id}`);
      fail(Object.values(local.bindings.providers).every(Boolean), 'Every local Provider slot must be bound');
      packs.push({ snapshot: pack, resources: encode(await this.source.store.resources(pack.workflow.id, pack.revision_hash)), bindings: local.bindings.providers });
    }
    fail(same(workflowProviderIds(candidateWorkflow), workflowProviderIds(root.snapshot.workflow)), 'Candidate Provider slots must preserve the qualified baseline slots');
    fail((candidateWorkflow.loops ?? []).every(loop => Number.isSafeInteger(loop.max_rounds) && loop.max_rounds > 0), 'Evaluation requires finite candidate loop bounds');
    const main = mainBinding(this.source.host);
    return this.put('candidates', { schema_version: 1, baseline_revision: expected_revision, workflow_id,
      candidate, resources: encode(candidateResources), packs, suite, main, cause, evidence_refs: structuredClone(evidence_refs), evidence_status: 'supplied_proposal_provenance',
      implementation: await implementation(this.source, this.implementationIdentity),
      settings: structuredClone(this.source.currentSettings), linked_skills: closure.skills });
  }
  async trial(candidateId, candidate, sample, repetition, variant, evaluationDirectory) {
    const directory = join(evaluationDirectory, `${sample.id.replace(/[^a-zA-Z0-9_-]/g, '_')}-${repetition}-${variant}-${randomUUID()}`);
    const workspace = join(directory, 'workspace'); await mkdir(workspace, { recursive: true });
    for (const [path, text] of Object.entries(sample.files ?? {})) {
      fail(typeof text === 'string', 'Suite workspace files must be UTF-8 text');
      const destination = resolve(workspace, path); fail(destination.startsWith(workspace + sep), 'Suite file escaped trial workspace');
      await mkdir(join(destination, '..'), { recursive: true }); await writeFile(destination, text, { flag: 'wx' });
    }
    const host = await this.createHost({ directory: join(directory, 'host'), workspace, main: structuredClone(candidate.main) });
    fail(host && !this.hosts.has(host) && host !== this.source.host, 'Each trial requires a distinct private Host'); this.hosts.add(host);
    let actor, service, failure, evidence, failed = false;
    try {
    for (const name of ['createMainTask', 'createTask']) if (typeof host[name] === 'function') {
      const original = host[name].bind(host);
      host[name] = async request => {
        fail(same(mainBinding(host), candidate.main), 'Inherited Main model drifted before dispatch');
        const task = await original(request);
        if (name === 'createMainTask') {
          try { fail(same(task.observed_model, candidate.main), 'Actual Main dispatch did not inherit the frozen model'); }
          catch (error) {
            try { await host.releaseTask(task); }
            catch (cleanup) { throw new AggregateError([error, cleanup], 'Main model drift and exact task cleanup both failed'); }
            throw error;
          }
        }
        return task;
      };
    }
    const registry = host.getHostTools?.() ?? {};
    const privateTools = Object.freeze(Object.fromEntries((registry instanceof Map ? [...registry] : Object.entries(registry)).map(([id, tool]) => [id,
      Object.freeze({ ...structuredClone(Object.fromEntries(Object.entries(tool).filter(([, value]) => typeof value !== 'function'))), execute: tool.execute, cancel: tool.cancel })])));
    service = new PiCawService({ directory: join(directory, 'state'), host, workerMode: true, getHostTools: () => privateTools });
      fail(same(mainBinding(host), candidate.main), 'Private Host inherited Main model differs from capture');
      actor = host.mainIdentity().session_id;
      fail(!this.sessions.has(actor) && actor !== this.source.host.mainIdentity().session_id, 'Trial parent sessions must be disjoint'); this.sessions.add(actor);
      await service.initialize();
      fail(same(await implementation(service, this.implementationIdentity), candidate.implementation), 'Actual Host/tool implementation drifted');
      const settings = await service.settings.read();
      await service.call('save_settings', { settings: candidate.settings, expected_revision: settings.revision }, { human: true });
      await service.refreshContext();
      for (const retained of candidate.packs) {
        let snapshot = structuredClone(retained.snapshot), resources = decode(retained.resources);
        if (snapshot.workflow.id === candidate.workflow_id && variant === 'candidate') {
          snapshot = privateSnapshot(candidate, variant);
          resources = decode(candidate.resources);
        }
        await service.store.install(snapshot, { resources, installation: { source: 'private-evolution:' + candidateId,
          package_version: 'evaluation', package_sha256: hash(snapshot), installed_at: new Date().toISOString() } });
        const local = await service.workflowBindings.read(snapshot);
        await service.workflowBindings.save(snapshot, retained.bindings, local.revision, host.catalog());
      }
      await service.refreshContext();
      const root = await service.store.snapshot(candidate.workflow_id), closure = await resolveWorkflowPins(service.store, root);
      fail(same(closure.skills, candidate.linked_skills), 'Linked Skill bytes changed since candidate capture');
      const run = await service.start({ workflow_id: root.workflow.id, revision_hash: root.revision_hash, workspace,
        access: 'bounded_write', allowed_paths: ['.'], inputs: sample.inputs, detached_host: false,
        main_modes: Object.fromEntries(root.workflow.nodes.filter(node => node.executor?.kind === 'main').map(node => [node.id, 'worker'])) });
      const owner = service.active.get(run.run_id); fail(owner, 'Real service Run driver was not created');
      let timer;
      try { await Promise.race([owner.completion, new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('Evaluation trial exceeded its frozen deadline'), { code: 'EVOLUTION_TRIAL_DEADLINE' })), candidate.suite.trial_timeout_ms); })]); }
      finally { clearTimeout(timer); }
      const settled = await finalEvidence(service, run.run_id, candidate.main);
      fail(same(await implementation(service, this.implementationIdentity), candidate.implementation), 'Actual Host/tool implementation changed during trial');
      for (const session of settled.evidence.sessions) {
        fail(!this.sessions.has(session.thread_id), 'Trial worker session was reused'); this.sessions.add(session.thread_id);
      }
      evidence = { sample_id: sample.id, repetition, variant, directory, workspace, parent_session: actor,
        ...settled.evidence, assertions: score(settled.output, sample.assertions) };
      verifyTrialPins(candidate, evidence, settled.record);
    } catch (error) { failed = true; failure = error; }
    try { if (service) await service.close(); else await host.close(); }
    catch (error) { failure = failed ? new AggregateError([failure, error], 'Trial and private Host shutdown failed') : error; failed = true; }
    if (!failed) {
      try {
        // Closing a service must not change its final proposal or journal.
        const final = await service.runtime.runs.observe(evidence.run_id);
        fail(hash(final) === evidence.record_sha256 && await service.runQuiescent(final), 'Trial shutdown changed settlement evidence');
      } catch (error) { failure = error; failed = true; }
    }
    if (failed) {
      let failure_id;
      try { failure_id = await this.put('failures', { candidate_id: candidateId, sample_id: sample.id, repetition, variant, directory, workspace,
        code: failure?.code ?? 'EVOLUTION_TRIAL_FAILED', message: String(failure?.message ?? failure) }); }
      catch (storage) { throw new AggregateError([failure, storage], 'Trial failure and diagnostic persistence both failed'); }
      const error = failure instanceof Error ? failure : new AggregateError([failure], 'Trial threw a non-Error value');
      error.details = { ...error.details, evolution_failure_id: failure_id, trial_directory: directory };
      console.error('[pi-CAW] workflow evolution trial failed', { failure_id, code: error.code ?? 'EVOLUTION_TRIAL_FAILED', directory });
      throw error;
    }
    return evidence;
  }
  async evaluate(candidateId) {
    fail(typeof this.createHost === 'function', 'A trusted private Host factory is required');
    const candidate = await this.get('candidates', candidateId);
    await this.verifySourceConfiguration(candidate);
    fail(same(await implementation(this.source, this.implementationIdentity), candidate.implementation), 'Source implementation drifted since capture');
    const directory = join(this.directory, 'trials', randomUUID()), trials = [];
    for (let repetition = 0; repetition < candidate.suite.repetitions; repetition++) for (const sample of candidate.suite.samples)
      for (const variant of ['baseline', 'candidate']) trials.push(await this.trial(candidateId, candidate, sample, repetition, variant, directory));
    const qualification = qualify(candidate, trials);
    const receipt = { schema_version: 1, candidate_id: candidateId, suite_sha256: hash(candidate.suite), trials, qualification };
    const evaluation_id = await this.put('evaluations', receipt);
    console.info('[pi-CAW] workflow evolution evaluated', { candidate_id: candidateId, evaluation_id, ...qualification });
    return { evaluation_id, ...receipt };
  }
  async adopt({ evaluation_id }, authority = {}) {
    fail(authority.human === true, 'Draft adoption requires explicit human authorization');
    const receipt = await this.get('evaluations', evaluation_id), candidate = await this.get('candidates', receipt.candidate_id);
    await this.verifySourceConfiguration(candidate);
    fail(receipt.suite_sha256 === hash(candidate.suite), 'Evaluation suite identity changed');
    fail(same(await implementation(this.source, this.implementationIdentity), candidate.implementation), 'Implementation drifted after evaluation');
    for (const trial of receipt.trials) {
      const expectedRoot = resolve(this.directory, 'trials') + sep;
      fail(resolve(trial.directory).startsWith(expectedRoot) && resolve(trial.workspace) === join(resolve(trial.directory), 'workspace'), 'Trial receipt escaped private evaluation storage');
      const runs = new WorkflowRunStore(join(trial.directory, 'state', 'runs'));
      const record = await runs.observe(trial.run_id);
      const observer = { runtime: { runs }, runQuiescent: PiCawService.prototype.runQuiescent };
      fail(hash(record) === trial.record_sha256 && await observer.runQuiescent(record), 'Authoritative Run evidence changed or has unsettled ownership');
      verifyTrialPins(candidate, trial, record);
      const final = await finalResult(runs, record);
      fail(['final_attempt_id', 'result_sha256', 'result_kind', 'settlement'].every(key => trial[key] === final[key])
        && same(trial.sessions, dispatchSessions(record, candidate.main)), 'Evaluation receipt differs from the actual final result/dispatch identity');
      const sample = candidate.suite.samples.find(item => item.id === trial.sample_id);
      fail(sample && same(score(final.output, sample.assertions), trial.assertions), 'Trial score differs from authoritative final bytes');
    }
    const qualification = qualify(candidate, receipt.trials);
    fail(same(qualification, receipt.qualification) && qualification.qualified, 'Candidate is unscored, worse, or below suite qualification');
    const baseline = candidate.packs[0].snapshot;
    // Store.save retains revisions/resources and performs the authoritative head
    // CAS. Adoption creates only a Draft; publication remains a separate action.
    const saved = await this.source.store.save(candidate.workflow_id, candidate.candidate.workflow, {
      expected_revision: candidate.baseline_revision, resources: decode(candidate.resources),
      provenance: { ...baseline.provenance, evolution: { candidate_id: receipt.candidate_id, evaluation_id, suite_sha256: receipt.suite_sha256 } },
      import_report: candidate.candidate.import_report,
    });
    console.info('[pi-CAW] human workflow evolution adopted as Draft', { workflow_id: saved.workflow.id, revision_hash: saved.revision_hash, evaluation_id });
    return saved;
  }
  async verifySourceConfiguration(candidate) {
    fail(same(mainBinding(this.source.host), candidate.main), 'Source inherited Main model drifted since capture');
    fail(same((await this.source.settings.read()).settings, candidate.settings), 'Source settings changed since capture');
    for (const retained of candidate.packs) {
      const current = await this.source.workflowBindings.read(retained.snapshot);
      fail(same(current.bindings.providers, retained.bindings) && !current.stale, 'Source Workflow-local bindings changed since capture');
    }
  }
}

function qualify(candidate, trials) {
  const expected = candidate.suite.samples.length * candidate.suite.repetitions * 2;
  fail(trials.length === expected, 'Evaluation has missing paired trials');
  const seen = new Set(), owners = new Set(), workspaces = new Set(), sessions = new Set(), regressions = []; let baseline = 0, improved = false, candidatePassed = 0, total = 0;
  for (const sample of candidate.suite.samples) for (let repetition = 0; repetition < candidate.suite.repetitions; repetition++) {
    const pair = ['baseline', 'candidate'].map(variant => {
      const rows = trials.filter(trial => trial.sample_id === sample.id && trial.repetition === repetition && trial.variant === variant);
      fail(rows.length === 1, 'Evaluation pair is missing or duplicated'); const row = rows[0];
      fail(row.assertions.length === sample.assertions.length && row.assertions.every((assertion, index) => assertion.pointer === sample.assertions[index].pointer && typeof assertion.passed === 'boolean'), 'Trial is unscored');
      fail(!seen.has(row.run_id), 'Evaluation reused a Run'); seen.add(row.run_id); return row;
    });
    for (const row of pair) {
      fail(!owners.has(row.parent_session) && !sessions.has(row.parent_session) && !workspaces.has(row.workspace), 'Evaluation reused a parent session or workspace'); owners.add(row.parent_session); workspaces.add(row.workspace);
      for (const session of row.sessions) { fail(!sessions.has(session.thread_id) && !owners.has(session.thread_id), 'Evaluation reused a worker session'); sessions.add(session.thread_id); }
    }
    for (let index = 0; index < sample.assertions.length; index++) {
      const before = pair[0].assertions[index].passed, after = pair[1].assertions[index].passed;
      baseline += Number(before); candidatePassed += Number(after); total++;
      if (!before && after) improved = true;
      if (before && !after) regressions.push({ sample_id: sample.id, repetition, pointer: sample.assertions[index].pointer });
    }
  }
  return { qualified: candidatePassed === total && candidatePassed >= baseline && improved && !regressions.length, baseline_passed: baseline, candidate_passed: candidatePassed, total, improved, regressions };
}

// A local entrypoint, deliberately outside model tools. The adapter is trusted
// local code and returns an initialized sourceService plus private Host factory.
// It supplies actual SDK/Host implementation hashes, never fabricated Run data.
export async function evolutionCLI(argv = process.argv.slice(2)) {
  const [command, adapterPath, packetPath] = argv;
  fail(['capture', 'evaluate', 'adopt'].includes(command) && adapterPath && packetPath, 'Usage: node lib/evolution-evaluation.mjs capture|evaluate|adopt adapter.mjs packet.json [--human-authorized]');
  const adapter = await import(pathToFileURL(resolve(adapterPath)).href), options = await adapter.createEvolutionContext();
  const evolution = new WorkflowEvolution(options), packet = JSON.parse(await readFile(resolve(packetPath), 'utf8'));
  try {
    const result = command === 'capture' ? { candidate_id: await evolution.capture(packet) }
      : command === 'evaluate' ? await evolution.evaluate(packet.candidate_id)
        : await evolution.adopt(packet, { human: argv[3] === '--human-authorized' });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n'); return result;
  } finally { await options.sourceService.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await evolutionCLI();
