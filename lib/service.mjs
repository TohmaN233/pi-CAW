import { readFile, mkdir, appendFile, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WorkflowStore } from '../core/workflow-store.mjs';
import { WorkflowRuntime, resolvedSubagentPlan } from '../core/workflow-runtime.mjs';
import { createDraft } from '../core/workflow-schema.mjs';
import { validateWorkflowGraph } from '../core/workflow-validator.mjs';
import { canonicalJSON, digest, prepareResources } from '../core/workflow-revisions.mjs';
import { writeDurableJSON } from '../core/workflow-events.mjs';
import { validateData } from '../core/workflow-data-schema.mjs';
import { requireValue, noSymlinks } from '../core/workflow-paths.mjs';
import { exportWorkflowPackage, installWorkflowPackage, validateWorkflowPackage } from '../core/workflow-package.mjs';
import { assignedFanoutIndices, assignedFanoutWritePaths, projectFanoutInputs } from '../core/execution/fanout-input-projection.mjs';
import { leaseToken, runPermissions, nodePermissions } from '../core/workflow-execution-envelope.mjs';
import { resolveWorkflowPins } from '../core/workflow-pins.mjs';
import { SettingsStore } from './settings.mjs';
import { coreProvider, resolveBinding } from './models.mjs';
import { mainContextChoice } from './main-context.mjs';
import { checkedMainMode, mainExecutionMode, mainContextForMode } from '../core/main-execution-mode.mjs';
import { renderTemplate } from '../core/templates.mjs';
import { effectiveSkillPolicy } from '../core/workflow-reference-schema.mjs';
import { preflightSemanticOutput } from '../core/execution/completion-preflight.mjs';
import { semanticResultSchema } from '../core/execution/host-main-automation.mjs';
import { seedDefaults } from './defaults.mjs';
import { WorkbenchApi, WORKBENCH_OPERATIONS } from './workbench-api.mjs';
import { authoringHostToolRegistry, AUTHORING_HOST_TOOL_IDS } from '../core/execution/authoring-host-tools.mjs';
import { HostToolRunner, hostToolContracts, hostToolContractsCompatible, requireHostToolBindings } from '../core/execution/host-tool-runner.mjs';
import { isAuthoringRunProvenance, ensureStoredAuthoringWorkflows } from '../core/authoring/authoring-workflows.mjs';
import { authoringAttemptOutputSchema } from '../core/skill-import/expansion-run.mjs';
import { discoverRuntimeEnvironment } from '../core/runtime-environment.mjs';
import { ParallelWorktreeManager } from '../core/parallel/worktree-manager.mjs';
import { workflowResourceProgramRegistry } from '../core/execution/workflow-resource-program.mjs';
import { runtimeEnvironmentForState } from '../core/runtime-environment-state.mjs';
import { aggregateUsage } from './usage.mjs';
import { qualifiedExecutionBinding } from '../core/execution/program-broker.mjs';
import { DetachedOwnerRegistry } from './detached-owner.mjs';
import { validateWorkflowScope, requireWorkflowInScope } from './workflow-scope.mjs';
import { templateKind } from '../core/template-kind.mjs';
import { createParentMainBridge } from './parent-main-bridge.mjs';
import { interruptActiveNodes } from '../core/workflow-state.mjs';
import { mergeHostTools, externalHostToolDescriptors, executeExternalHostTool } from './external-host-tools.mjs';
import { RunRetention } from './run-retention.mjs';
import { RoleRetention } from './role-retention.mjs';
import { runFeedback } from './run-feedback.mjs';
import { inspectRun } from './run-inspector.mjs';

function diagnostic(error) {
  const causes = error instanceof AggregateError ? error.errors.slice(0, 8).map(item => diagnostic(item).message).join('; ') : '';
  return { code: error.code ?? 'PI_CAW_EXECUTION', message: `${error.message}${causes ? ': ' + causes : ''}`.slice(0, 2000) };
}

export class PiCawService {
  constructor({ directory, host, notify = () => {}, workerMode = false, beforeRunPurge, getHostTools = () => host.getHostTools?.() ?? {} }) {
    this.directory = directory; this.host = host;
    host.setExecutionDirectory?.(directory);
    this.notificationClassifications = new Map();
    this.notify = async event => {
      const enriched = await this.enrichNotification(event);
      if(enriched.feedback) await this.host.emit?.('pi-caw:run-feedback',enriched.feedback);
      if (enriched.run_id && ['succeeded', 'failed', 'cancelled', 'attention'].includes(enriched.status))
        await this.host.emit?.('pi-caw:run-lifecycle', enriched);
      return notify(enriched);
    };
    this.getHostTools = getHostTools;
    this.settings = new SettingsStore(directory); this.active = new Map(); this.roleTasks = new Map();
    this.workerMode = workerMode; this.parentBridges = new Map();
    this.beforeRunPurge = async event => beforeRunPurge?.(await this.enrichNotification(event));
    this.notificationFlush = null;
    this.detachedOwners = new DetachedOwnerRegistry({ directory: join(directory, 'owners') });
    this.workbench = new WorkbenchApi(this);
    this.builtinHostTools = { ...authoringHostToolRegistry(), ...workflowResourceProgramRegistry() };
    this.externalHostTools = this.getHostTools();
    this.hostTools = mergeHostTools(this.builtinHostTools, this.externalHostTools);
    this.toolRunner = new HostToolRunner({ registry: this.hostTools });
    this.parallel = new ParallelWorktreeManager(join(directory, 'worktrees'));
    this.retention = new RunRetention(this); this.roleRetention = new RoleRetention(this); this.progress = new Map();this.observedRuns=new Set(); this.maintenanceTimer=null; this.progressTimer=null;
  }
  async initialize() {
    await mkdir(this.directory, { recursive: true });
    this.store = await new WorkflowStore(join(this.directory, 'workflows')).initialize();
    const defaultsUpgrade = await seedDefaults({ settingsStore: this.settings, workflowStore: this.store });
    if (defaultsUpgrade.providers_removed?.length || defaultsUpgrade.roles_removed?.length || defaultsUpgrade.roles_unbound?.length) {
      console.info('[pi-CAW] retired GPT-only defaults', defaultsUpgrade);
    }
    this.runtime = await new WorkflowRuntime({ workflowStore: this.store, runRoot: join(this.directory, 'runs'),
      context: {}, strictCapability: () => this.host.capabilities.strict_resources,
      beforeStart: (closure, admission) => this.preflight(closure, admission),
      parallelManager: this.parallel, parallelWriteCapability: () => this.host.capabilities.scoped_file_writes,
      environmentResolver: (requirements, options = {}) => discoverRuntimeEnvironment(requirements, {
        ...options, registryPath: join(this.directory, 'host-runtime-registry.json') }),
    }).initialize();
    await this.refreshContext();
    if (!this.workerMode) {
      const upgraded=await ensureStoredAuthoringWorkflows(this.store,{providers:this.currentSettings.providers.map(coreProvider),routingRules:this.currentSettings.routing,createMissing:false});
      for(const pack of upgraded)if(pack.host_tool_identity_issue)console.error('[pi-CAW] authoring upgrade blocked', {workflow_id:pack.workflow.id,...pack.host_tool_identity_issue});
      await this.flushTerminalNotifications();
    }
    if (!this.workerMode && this.host.emit) {
      const report=error=>{this.maintenanceError=diagnostic(error);console.error('[pi-CAW] maintenance failed',this.maintenanceError);};
      this.progressTimer=setInterval(()=>void this.publishProgress().catch(report),3000);this.progressTimer.unref();
      const clean=()=>void this.retention.sweep().then(()=>{this.maintenanceError=null;},report);
      this.maintenanceTimer=setInterval(clean,60000);this.maintenanceTimer.unref();
      await this.publishProgress();clean();
    }
    return this;
  }
  async publishProgress() {
    if(this.progressPending)return this.progressPending;
    this.progressPending=this.observeProgress();try{return await this.progressPending;}finally{this.progressPending=null;}
  }
  async observeProgress() {
    const actor=this.host.mainIdentity().session_id;
    if(this.progressActor!==actor) {
      this.progressActor=actor;this.progressCandidates=new Set();
      for(const row of await this.runtime.runs.list()) {
        const record=await this.runtime.runs.observe(row.run_id);
        if(record.state.main_actor===actor && (!isAuthoringRunProvenance(record.pins.root.provenance)||this.observedRuns.has(row.run_id)))this.progressCandidates.add(row.run_id);
      }
    }
    const records=[];
    for(const id of this.progressCandidates) {
      if(await this.runtime.runs.retained(id)){this.progressCandidates.delete(id);continue;}
      const record=await this.runtime.runs.observe(id);if(record.state.main_actor===actor)records.push(record);
    }
    const latestTerminal=records.filter(r=>['succeeded','failed','cancelled'].includes(r.state.status)).sort((a,b)=>b.state.updated_at.localeCompare(a.state.updated_at))[0]?.state.run_id;
    for(const record of records) {
      const row=record.state;
      if(['succeeded','failed','cancelled'].includes(row.status) && row.run_id!==latestTerminal && !this.progress.has(row.run_id))continue;
      const feedback=runFeedback(record), key=canonicalJSON(feedback);
      if(this.progress.get(row.run_id)===key)continue;
      await this.host.emit?.('pi-caw:run-feedback',feedback);
      this.progress.set(row.run_id,key);
    }
  }
  async runQuiescent(record, seen = new Set()) {
    if (seen.has(record.state.run_id)) return true;
    seen.add(record.state.run_id);
    if (record.state.control_recovery?.errors?.length) return false;
    for (const node of Object.values(record.state.nodes)) for (const attempt of node.attempts) {
      if (attempt.child_run_id) {
        if (!await this.runQuiescent(await this.runtime.runs.read(attempt.child_run_id), seen)) return false;
      } else if (attempt.host_tool) {
        const receipt = attempt.host_tool.receipt;
        if (!receipt || !['succeeded', 'failed', 'cancelled', 'timed_out'].includes(receipt.status)
          || ['cancelled', 'timed_out'].includes(receipt.status) && receipt.reconciliation?.termination_confirmed !== true) return false;
      } else if (attempt.dispatch?.receipt?.executor === 'host-generation-replay') {
        // An immutable Host replay never creates a Pi session. Its exact
        // committed artifact is its completion evidence, not session shutdown.
        const completion = attempt.completion, receipt = attempt.dispatch.receipt;
        const replay = completion?.evidence?.find(event => event.kind === 'host_generation_recheck');
        if (!isAuthoringRunProvenance(record.pins.root.provenance) || attempt.status !== 'succeeded'
          || attempt.dispatch.phase !== 'acknowledged' || attempt.dispatch.cancellation_pending
          || completion?.status !== 'succeeded' || !attempt.result_proposal?.sha256
          || attempt.result_proposal.sha256 !== attempt.completion_hash || digest(canonicalJSON(completion)) !== attempt.completion_hash
          || !replay || replay.source_run_id !== receipt.task_id || replay.source_attempt_id !== receipt.invocation_id
          || replay.result_sha256 !== receipt.source_result_sha256 || replay.materialized_sha256 !== receipt.result_sha256
          || digest(canonicalJSON(completion.structured_output)) !== receipt.result_sha256
          || completion.changed_paths?.length !== 0 || completion.outside_paths?.length !== 0) return false;
      } else if (attempt.dispatch && !attempt.executor_events?.some(event => event.kind === 'session_state' && event.metadata.status === 'closed')) return false;
    }
    return true;
  }
  async enrichNotification(event) {
    if (!event.run_id) return structuredClone(event);
    let record, classification, quiescent;
    try { record = await this.runtime.runs.read(event.run_id); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      // Accepted authoring deliberately purges its private Run. Only its
      // retained trusted classification can describe a notification afterward.
      const retained = this.notificationClassifications.get(event.run_id);
      const context = retained?.classification ?? event.notification_context;
      const acceptedCleanup = event.status === 'succeeded' && (event.authoring_cleanup?.cleanup_transaction?.run_id === event.run_id
        || ['accepted_cleanup_pending', 'accepted_cleanup_incomplete'].includes(event.publication)
          && typeof event.deployed_workflow_id === 'string' && /^[a-f0-9]{64}$/.test(event.deployed_revision));
      requireValue(acceptedCleanup && context?.authoring === true
        && context.schema_version === 1 && context.run_id === event.run_id && typeof context.main_actor === 'string'
        && Array.isArray(context.host_tool_ids) && context.host_tool_ids.every(id => /^[a-z][a-z0-9_-]{0,127}$/.test(id)),
      'PI_NOTIFICATION_CONTEXT_MISSING',
      `Exact notification Run evidence is unavailable: ${error.message}`);
      classification = structuredClone(context); quiescent = retained?.quiescent ?? event.quiescent === true;
    }
    if (record) {
      classification = { schema_version: 1, run_id: event.run_id, main_actor: record.state.main_actor,
        host_tool_ids: [...new Set((record.pins.root.workflow.host_tools ?? []).map(tool => tool.id))],
        authoring: isAuthoringRunProvenance(record.pins.root.provenance) };
      if (event.notification_context) requireValue(canonicalJSON(event.notification_context) === canonicalJSON(classification),
        'PI_NOTIFICATION_CONTEXT_CHANGED', 'Notification classification differs from its exact immutable Run pins');
      quiescent = await this.runQuiescent(record);
      this.notificationClassifications.set(event.run_id, { classification, quiescent });
    }
    if (event.shutdown?.quiescent === true) {
      requireValue(event.shutdown.run_id === event.run_id && event.shutdown.main_actor === classification.main_actor
        && event.shutdown.source === 'pi-worker-stop', 'PI_NOTIFICATION_SHUTDOWN', 'Shutdown evidence belongs to another exact owner');
      quiescent = true;
    }
    const terminal = ['succeeded', 'failed', 'cancelled'].includes(event.status);
    return { ...structuredClone(event), ...(record?{feedback:runFeedback(record)}:{}),main_actor: classification.main_actor, host_tool_ids: classification.host_tool_ids,
      notification_context: classification, quiescent: quiescent === true, ownership_released: terminal && quiescent === true };
  }
  async refreshContext() {
    this.externalHostTools = this.getHostTools();
    this.hostTools = mergeHostTools(this.builtinHostTools, this.externalHostTools);
    this.toolRunner.registry = this.hostTools;
    const current = await this.settings.read();
    this.currentSettings = current.settings;
    const providers = current.settings.providers.map(coreProvider);
    const nativeMcp = typeof this.host.mcpCatalog === 'function' ? await this.host.mcpCatalog() : { servers: [] };
    const context = { providers, roles: current.settings.roles, tools: ['read', 'write', 'edit', 'grep', 'find', 'ls', 'caw_submit_result', 'caw_read_resource',
      'read_workflow_resource', 'read_workflow_resource_range', 'read_workflow_resource_chunk', 'run_task_program',
      'list_workspace', 'read_workspace', 'write_workspace', 'mkdir_workspace', 'materialize_workflow_resource',
      'list_input', 'read_input', ...Object.keys(this.hostTools), ...(this.host.getAllTools?.() ?? []).map(tool => tool.name)],
      host_tools: Object.keys(this.hostTools), host_tool_contracts: externalHostToolDescriptors(this.externalHostTools).flatMap(tool => tool.contract ? [tool.contract] : []), mcp_servers: nativeMcp.servers.filter(server => server.enabled
        && (server.exposure !== 'hidden' || Object.values(server.tool_exposure ?? {}).some(value => value !== 'hidden'))).map(server => server.name) };
    this.store.validationContext = context; this.runtime.context = context;
    return current;
  }
  preflight(closure, admission) {
    requireValue(this.currentSettings.global?.enabled !== false, 'PI_CAW_DISABLED', 'Workflow execution is disabled in the Workbench');
    const catalog = this.host.catalog();
    for (const id of closure.provider_ids) {
      const provider = this.currentSettings.providers.find(item => item.id === id);
      requireValue(provider?.enabled, 'PI_PROVIDER_DISABLED', `Provider is missing or disabled: ${id}`);
      resolveBinding(provider.binding, catalog);
    }
    if (closure.packs.some(pack => pack.workflow.nodes.some(node => node.executor?.kind === 'main'))) this.host.mainIdentity();
    for (const pack of closure.packs) {
      try { requireHostToolBindings(pack.workflow, this.hostTools); }
      catch (error) {
        if (admission?.run_id) error.details = { ...error.details, admission: { run_id: admission.run_id,
          phase: 'before_run_creation', execution_started: false } };
        throw error;
      }
      for (const node of pack.workflow.nodes) {
        if (node.executor?.kind === 'main' && !isAuthoringRunProvenance(pack.provenance)
          && effectiveSkillPolicy(pack.workflow.skill_policy, node.skill_policy).mode === 'strict')
          requireValue(this.host.capabilities.isolated_main === true,'PI_MAIN_ISOLATION_UNAVAILABLE','This Pi Host cannot execute isolated logical Main nodes');
        requireValue(node.subagent_count === undefined || node.executor?.kind !== 'main',
          'SUBAGENT_COUNT', 'Main Agent nodes cannot configure sub-Agent quantity');
        // Core resolves auto without a list fan-out to one exact child. Only
        // an explicit list assignment/join may resolve to multiple children.
        requireValue(node.subagent_count === undefined || node.fanout || node.subagent_count === 'auto' || node.subagent_count === 1,
          'PI_POOL_JOIN_REQUIRED', 'Multiple Pi children require an explicit fan-out assignment and result join');
      }
    }
  }
  async prepareValidation(workflow, resources) {
    if (workflow.status !== 'ready') return;
    const prepared = prepareResources(resources);
    const closure = await resolveWorkflowPins(this.store, { workflow, resources: prepared.manifest }, { rootResources: resources });
    this.store.validationContext = { ...this.store.validationContext, ...closure.context };
  }
  async assertReadableRunDirectory(runId) {
    const directory = this.runtime.runs.directory(runId); // Validates the exact portable ID.
    const checkStore = async () => {
      await noSymlinks(this.runtime.runs.root);
      requireValue((await lstat(this.runtime.runs.root)).isDirectory(), 'NOT_DIRECTORY', 'Run store must be an existing directory');
    };
    await checkStore();
    let entry;
    try { entry = await lstat(directory); }
    catch (cause) {
      if (cause.code !== 'ENOENT' || cause.syscall !== 'lstat' || resolve(cause.path ?? '') !== resolve(directory)) throw cause;
      // A missing/inaccessible parent store is not evidence about this Run.
      await checkStore();
      throw Object.assign(new Error(`Run directory is absent: ${runId}`), { code: 'RUN_NOT_FOUND',
        details: { run_id: runId, observation: 'run_directory_absent' } });
    }
    await noSymlinks(directory);
    requireValue(entry.isDirectory(), 'NOT_DIRECTORY', 'Run path must be a directory');
  }
  async call(operation, args = {}, { human = false, signal } = {}) {
    if (operation === 'inspect_run') return inspectRun(this, args);
    if (!this.workerMode) await this.flushTerminalNotifications();
    if (operation === 'get' || operation === 'run_snapshot') await this.assertReadableRunDirectory(args.run_id);
    if(args.run_id && operation !== 'run') {
      const retained=await this.runtime.runs.retained(args.run_id);
      if(retained) {
        const state={...retained.state,process_cleaned:true,cleaned_at:retained.cleaned_at};
        if(operation==='get')return state;
        if(operation==='run_snapshot')return {state,sequence:retained.sequence,events:[],host_worker:null};
        requireValue(false,'RUN_RETIRED','Run process data was cleaned; its saved result remains available and cannot be replayed');
      }
    }
    const remote = !['run','launch_role','run_main','start'].includes(operation) && !this.workerMode && args.run_id ? await this.detachedOwnerFor(args.run_id) : null;
    if (remote && !['adopt_run', 'recover_control'].includes(operation)) {
      if (['stale', 'orphaned', 'failed'].includes(remote.phase) && remote.termination?.confirmed !== true) {
        requireValue(operation === 'run_snapshot', 'PI_OWNER_STOP_UNCONFIRMED',
          'The prior detached owner has no confirmed shutdown. Inspect its retained owner and exact Pi attempt; no new execution is released.');
        const snapshot = await this.runtime.snapshot(args.run_id, { ...await this.authority(args.run_id), after_sequence: args.after_sequence ?? 0 });
        return { ...snapshot, host_worker: this.ownerEvidence(remote) };
      }
      await this.attachOwnerBridge(remote);
      const result = await this.detachedOwners.call(remote.run_id, 'service_call', { operation, args, options: { human } }, { signal, timeoutMs: 0 });
      return operation === 'run_snapshot' ? { ...result, host_worker: { ...result.host_worker, ...this.ownerEvidence(await this.detachedOwners.read(remote.run_id)) } } : result;
    }
    await this.refreshContext();
    switch (operation) {
      case 'capabilities': return { plugin: 'pi-CAW', version: '0.2.30', host: { ...this.host.capabilities, parallel_worktrees: true, host_tools: Object.keys(this.hostTools) },
        strict: { available: this.host.capabilities.strict_resources, boundary: 'Pi application tools and pinned resources; no OS sandbox' },
        tools: this.runtime.context.tools, mcp_servers: this.runtime.context.mcp_servers, default_model: null };
      case 'models': return { models: this.host.catalog(), source: 'active-pi-session', default_model: null };
      case 'roles': return this.workbench.roles();
      case 'settings': {
        const current = await this.settings.read();
        return { ...current, settings: { ...current.settings, providers: current.settings.providers.map(provider => ({
          description: '', requires_user_approval: false, capabilities: { read: true, write: true, background: true }, ...provider })) } };
      }
      case 'save_settings': {
        requireValue(human, 'HUMAN_CONFIGURATION_REQUIRED', 'Model bindings and Roles are configured in the Workbench');
        // Empty bindings remain editable; every nonempty binding must be real.
        for (const provider of args.settings.providers ?? []) if (provider.binding) provider.binding = resolveBinding(provider.binding, this.host.catalog());
        return this.settings.save(args.settings, args.expected_revision);
      }
      case 'list': return this.workbench.list();
      case 'get_workflow': return this.store.snapshot(args.workflow_id, args.revision_hash);
      case 'create_workflow': {
        const workflow = args.workflow ?? createDraft(args.workflow_id, args.name), resources = args.resources ?? {};
        await this.prepareValidation(workflow, resources); return this.store.create(workflow, { resources });
      }
      case 'save_workflow': {
        const resources = args.resources ?? await this.store.resources(args.workflow_id);
        await this.prepareValidation(args.workflow, resources);
        return this.store.save(args.workflow_id, args.workflow, { expected_revision: args.expected_revision, resources });
      }
      case 'validate': {
        const workflow = args.workflow ?? (await this.store.snapshot(args.workflow_id)).workflow;
        const resources = args.resources ?? (args.workflow_id ? await this.store.resources(args.workflow_id) : {});
        await this.prepareValidation(workflow, resources); return validateWorkflowGraph(workflow, this.store.validationContext);
      }
      case 'export': {
        const pack = await this.store.snapshot(args.workflow_id);
        return pack;
      }
      case 'install': {
        const checked = validateWorkflowPackage(args.package);
        await this.prepareValidation(checked.snapshot.workflow, checked.resources);
        return installWorkflowPackage(this.store, args.package);
      }
      case 'launch_role': return this.launchRole(args, { human });
      case 'run': return this.start(args);
      case 'runs': return this.runtime.runs.list();
      case 'run_snapshot': {
        if (args.control_token) await this.runtime.authorizeController(args.run_id, args);
        const snapshot = await this.runtime.snapshot(args.run_id, { ...await this.authority(args.run_id), after_sequence: args.after_sequence ?? 0 });
        let worker;
        try { worker = JSON.parse(await readFile(join(this.runtime.runs.directory(args.run_id), 'pi-worker.json'), 'utf8')); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        const detached = await this.detachedOwners.read(args.run_id);
        return { ...snapshot, host_worker: detached ? { ...worker, ...this.ownerEvidence(detached) } : worker ?? null };
      }
      case 'final_proposal': {
        const record = await this.runtime.runs.read(args.run_id);
        const node_id = record.pins.root.workflow.finalization.node_id;
        const attempt = record.state.nodes[node_id]?.attempts.at(-1);
        if (!attempt?.result_proposal) return null;
        return { proposal_sha256: attempt.result_proposal.sha256,
          completion: await this.runtime.runs.readExecutorResult(args.run_id, attempt.id, attempt.result_proposal.sha256) };
      }
      case 'continue': {
        await this.assertDriverRelease(args.run_id);
        const authority = await this.authority(args.run_id);
        const record = await this.runtime.runs.read(args.run_id);
        const recovered = Object.entries(record.state.nodes).filter(([,node]) => node.status === 'claimed' && node.attempts.at(-1)?.reconciliation?.kind === 'unsubmitted_claim' && !node.attempts.at(-1)?.dispatch).map(([id]) => id);
        requireValue(!Object.entries(record.state.nodes).some(([id,node]) => ['claimed', 'running', 'interrupted'].includes(node.status) && !recovered.includes(id)),
          'PI_DISPATCH_UNRESOLVED', 'An existing Pi attempt is unresolved. Inspect its exact session; it cannot be replayed automatically.');
        if (['paused', 'interrupted', 'blocked'].includes(record.state.status)) await this.runtime.resume(args.run_id, authority);
        return this.launchDriver(args.run_id, { recoveredNodes: recovered });
      }
      case 'collect_host_tool': {
        requireValue(human && !this.active.has(args.run_id), 'HUMAN_RECOVERY_REQUIRED', 'Exact Host receipt collection requires a human and a settled owner');
        await this.assertDriverRelease(args.run_id);
        const record = await this.runtime.runs.read(args.run_id), authority = await this.authority(args.run_id);
        requireValue(await this.runQuiescent(record), 'PI_RECOVERY_OWNER', 'Previous exact attempt owners must be quiescent before collection');
        const attempt = record.state.nodes[args.node_id]?.attempts.find(item => item.id === args.attempt_id), receipt = attempt?.host_tool?.receipt;
        requireValue(receipt?.status === 'succeeded', 'HOST_TOOL_COLLECTION', 'Select a durable successful Host receipt');
        const contract = hostToolContracts(record.pins.root.workflow).get(receipt.tool), registry = mergeHostTools(this.builtinHostTools, this.getHostTools());
        requireHostToolBindings({ host_tools: [contract] }, registry);
        const descriptor = externalHostToolDescriptors({ [contract.id]: registry[contract.id] })[0], a = descriptor.attestation;
        requireValue(this.host.mainIdentity().session_id === record.state.main_actor && (!descriptor.contract || hostToolContractsCompatible(contract, descriptor.contract)),
          'PI_EXTERNAL_HOST_PIN', 'Collection retains the exact parent actor and pinned Host contract');
        const authorization = { kind: 'trusted_host_storage', receipt_sha256: args.receipt_sha256, tool_identity: descriptor.identity,
          broker_id: a.broker_id, evidence_sha256: a.evidence_sha256, storage_capabilities: a.storage_capabilities };
        const result = await this.runtime.collectHostTool(args.run_id, { ...authority, node_id: args.node_id, attempt_id: args.attempt_id,
          receipt_sha256: args.receipt_sha256, authorization });
        return { ...result, collected_attempt_id: args.attempt_id, implementation_invoked: false, model_calls: 0 };
      }
      case 'recover': {
        requireValue(human && !this.active.has(args.run_id), 'HUMAN_RECOVERY_REQUIRED', 'Only a human can recover a Run after verifying its previous owner stopped');
        return this.runtime.resume(args.run_id, { ...await this.authority(args.run_id), after_restart: true });
      }
      case 'retry': {
        requireValue(human && !this.active.has(args.run_id), 'HUMAN_RETRY_REQUIRED', 'Retry requires human reconciliation of the exact previous attempt and its effects');
        await this.assertDriverRelease(args.run_id);
        await this.runtime.retryNode(args.run_id, { ...await this.authority(args.run_id), node_id: args.node_id, reconciliation: args.reconciliation });
        return this.launchDriver(args.run_id);
      }
      case 'pause': {
        const owner = this.active.get(args.run_id);
        if (owner) { owner.pauseRequested = args.reason ?? 'Paused by the current Pi chat'; return { run_id: args.run_id, status: 'pause_requested', after_current_nodes: true }; }
        return this.runtime.pause(args.run_id, { ...await this.authority(args.run_id), reason: args.reason });
      }
      case 'cancel': {
        const ids = await this.descendants(args.run_id), owners = ids.map(id => this.active.get(id)).filter(Boolean);
        for (const owner of owners) owner.controller.abort();
        const completion = Promise.all(owners.map(owner => owner.completion))
          .then(async () => {
            for (const id of ids) requireValue(await this.runQuiescent(await this.runtime.runs.read(id)),
              'PI_CANCEL_SHUTDOWN_UNCONFIRMED', 'Cancellation cannot release ownership until every exact task producer has shutdown evidence');
            const result = await this.runtime.cancelTree(args.run_id, await this.authority(args.run_id));
            await this.notify({ run_id: args.run_id, status: 'cancelled', result }); return result;
          });
        if (human) return completion;
        // A caw tool inside Main must return before Pi can emit agent_end and
        // settle cancellation. Waiting here would deadlock the current chat.
        completion.catch(error => this.notify({ run_id: args.run_id, status: 'attention', error: { code: error.code ?? 'PI_CANCEL_FAILED', message: error.message } }));
        return { run_id: args.run_id, status: 'cancellation_requested' };
      }
      case 'approve': {
        requireValue(human, 'HUMAN_APPROVAL_REQUIRED', 'Workflow approvals require a human decision');
        await this.runtime.approve(args.run_id, { ...await this.authority(args.run_id), approval_id: args.approval_id, decision: args.decision });
        return this.launchDriver(args.run_id);
      }
      case 'accept_final': {
        requireValue(human && args.accepted === true, 'FINAL_ACCEPTANCE_REQUIRED', 'Final acceptance requires an explicit human decision');
        const authority = await this.authority(args.run_id);
        const record = await this.runtime.runs.read(args.run_id);
        const node_id = record.pins.root.workflow.finalization.node_id;
        const attempt = record.state.nodes[node_id].attempts.at(-1);
        requireValue(attempt && attempt.result_proposal, 'PI_FINAL_NOT_READY', 'No verified final proposal is available');
        requireValue(args.proposal_sha256 === attempt.result_proposal.sha256, 'PI_FINAL_CHANGED', 'Final acceptance must identify the exact proposal the human reviewed');
        if (isAuthoringRunProvenance(record.pins.root.provenance)) return this.workbench.authoring.accept(args);
        if (record.state.status === 'paused') await this.runtime.resume(args.run_id, authority);
        await this.runtime.completeHostMainResult(args.run_id, { ...authority, node_id, attempt_id: attempt.id,
          lease_token: leaseToken(authority.control_token, args.run_id, node_id, attempt.id, attempt.lease_generation ?? 0) }, { accepted: true });
        return this.launchDriver(args.run_id);
      }
      default: if (WORKBENCH_OPERATIONS.has(operation)) return this.workbench.call(operation, args, { human, signal });
        throw Object.assign(new Error(`Unknown pi-CAW operation: ${operation}`), { code: 'PI_CAW_OPERATION' });
    }
  }
  async authority(runId) {
    const path = join(this.runtime.runs.directory(runId), 'pi-controller.json');
    const value = JSON.parse(await readFile(path, 'utf8'));
    await this.runtime.authorizeController(runId, value);
    return value;
  }
  async flushTerminalNotifications() {
    if (this.notificationFlush) return this.notificationFlush;
    const flush = (async () => {
      const owners = (await this.detachedOwners.list()).filter(owner => owner.termination?.confirmed === true && owner.outcome?.parent_notification?.events?.length);
      if (!owners.length) return;
      const actor = this.host.mainIdentity().session_id;
      for (const owner of owners) {
        if (owner.main_actor !== actor) continue;
        for (const pending of await this.detachedOwners.pendingNotifications(owner.run_id)) {
          await this.notify({ ...pending.event, delivery_id: pending.hash });
          await this.detachedOwners.ackNotifications(owner.run_id, { owner_id: pending.owner_id, hash: pending.hash });
        }
      }
    })();
    this.notificationFlush = flush;
    try { await flush; } finally { if (this.notificationFlush === flush) this.notificationFlush = null; }
  }
  async interruptUnconfirmedShutdown(runId, args, cause) {
    await this.runtime.runs.mutate(runId, 'execution_drain', state => {
      requireValue(state.control_hash === digest(args.control_token), 'RUN_AUTHORITY', 'The prior owner cannot mutate a recovered Run');
      for (const node of Object.values(state.nodes)) if (['claimed', 'running'].includes(node.status)) {
        const attempt = node.attempts.find(item => item.id === node.active_attempt_id);
        if (attempt?.dispatch) attempt.dispatch.cancellation_pending = true;
      }
      interruptActiveNodes(state, 'Pi executor shutdown is unconfirmed; exact attempt reconciliation is required');
      state.status = 'interrupted'; state.pi_owner_error = diagnostic(cause); state.updated_at = new Date().toISOString();
    });
    this.active.get(runId)?.controller.abort();
  }
  async detachedOwnerFor(runId) {
    const seen = new Set();
    while (runId && !seen.has(runId)) {
      seen.add(runId);
      const owner = await this.detachedOwners.read(runId);
      if (owner && (!['stopped', 'failed', 'succeeded', 'cancelled'].includes(owner.phase) || owner.termination?.confirmed !== true)) return { ...owner, run_id: runId };
      let record;
      try { record = await this.runtime.runs.read(runId); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
      runId = record.state.parent?.run_id;
    }
    return null;
  }
  ownerEvidence(owner) {
    return { ...owner, execution_owner: 'pi_detached_owner', process_id: owner.pid, session_id: owner.main_actor };
  }
  async stopOwnerForRecovery(runId) {
    const owner = await this.detachedOwnerFor(runId);
    if (!owner) return;
    const stopped = await this.detachedOwners.stop(owner.run_id, 'controller_recovery');
    requireValue(stopped.termination?.confirmed === true, 'PI_OWNER_STOP_UNCONFIRMED', 'Controller recovery requires the exact prior owner to confirm quiescence');
    const bridge = this.parentBridges.get(owner.run_id);
    if (bridge) { await bridge.close(); this.parentBridges.delete(owner.run_id); }
  }
  async attachOwnerBridge(owner) {
    if (this.host.mainIdentity().session_id !== owner.main_actor) return;
    const existing = this.parentBridges.get(owner.run_id);
    if (existing && owner.status !== 'waiting_parent') return;
    const record = await this.runtime.runs.read(owner.run_id);
    await this.host.emit?.('pi-caw:run-lifecycle', { run_id: owner.run_id, status: 'started', main_actor: owner.main_actor,
      host_tool_ids: (record.pins.root.workflow.host_tools ?? []).map(tool => tool.id) });
    if (existing) {
      await this.detachedOwners.reattach(owner.run_id, { parent_bridge: existing.descriptor, main_actor: owner.main_actor, controller_hash: record.state.control_hash });
      return;
    }
    const bridge = await createParentMainBridge({ host: this.host, run_id: owner.run_id, main_actor: owner.main_actor, notify: this.notify, getHostTools: this.getHostTools });
    try {
      await this.detachedOwners.reattach(owner.run_id, { parent_bridge: bridge.descriptor, main_actor: owner.main_actor, controller_hash: record.state.control_hash });
      this.parentBridges.set(owner.run_id, bridge);
    } catch (error) { await bridge.close(); throw error; }
  }
  async launchDetachedDriver(runId, record, options = {}) {
    const existing = await this.detachedOwnerFor(runId);
    if (existing) { await this.attachOwnerBridge(existing); return { run_id: runId, status: 'running', execution_owner: 'pi_detached_owner' }; }
    requireValue(record.state.main_actor === this.host.mainIdentity().session_id, 'PI_MAIN_SESSION_CHANGED', 'A new detached owner must attach to the exact original Pi chat');
    const providerIds = [...new Set([...record.pins.providers, ...(record.pins.authoring_reviewer ? [record.pins.authoring_reviewer] : [])]
      .map(provider => provider.config.provider).filter(Boolean))];
    const boot = { ...await this.host.detachedBootstrap(providerIds), directory: this.directory, driver_options: options,
      external_host_tools: externalHostToolDescriptors(this.externalHostTools) };
    const bridge = await createParentMainBridge({ host: this.host, run_id: runId, main_actor: record.state.main_actor, notify: this.notify, getHostTools: this.getHostTools });
    try {
      const owner = await this.detachedOwners.launch({ run_id: runId, controller_hash: record.state.control_hash,
        main_actor: record.state.main_actor, controller_journal: join(this.runtime.runs.directory(runId), 'events.jsonl'),
        runtime_entry: new URL('./pi-worker.mjs', import.meta.url).href, boot, parent_bridge: bridge.descriptor });
      this.parentBridges.set(runId, bridge);
      return { run_id: runId, status: 'running', execution_owner: 'pi_detached_owner', host_worker: owner };
    } catch (error) {
      await bridge.close();
      await this.runtime.runs.mutate(runId, 'host_main_worker_start_failed', state => { interruptActiveNodes(state, 'Detached Pi owner startup did not complete'); state.status = 'interrupted'; state.updated_at = new Date().toISOString(); state.pi_owner_error = diagnostic(error); });
      throw error;
    }
  }
  async workflowCatalog() {
    return (await this.store.list()).map(pack=>({id:pack.workflow.id,name:pack.workflow.name,kind:templateKind(pack),
      system_managed:pack.provenance?.kind==='bundled_authoring_workflow',status:pack.workflow.status,
      enabled:pack.workflow.enabled,revision_hash:pack.revision_hash}));
  }
  async workflowScope(catalog) {
    const identity=this.host.mainIdentity();
    if(typeof this.host.workflowScope!=='function')return null;
    const actualCatalog=catalog??await this.workflowCatalog();
    requireValue(this.host.mainIdentity().session_id===identity.session_id,'PI_MAIN_SESSION_CHANGED','Current Pi session changed while reading Workflow scope');
    const scope=validateWorkflowScope(await this.host.workflowScope(identity.session_id,structuredClone(actualCatalog)));
    requireValue(this.host.mainIdentity().session_id===identity.session_id,'PI_MAIN_SESSION_CHANGED','Current Pi session changed while resolving Workflow scope');
    if(!scope)return null;
    // Mode metadata supplies defaults/preferences, never partitions the installed library.
    const workflow_ids=actualCatalog.filter(row=>row.kind==='workflow'&&!row.system_managed).map(row=>row.id);
    return {...scope,workflow_ids,enabled_workflow_ids:scope.enabled_workflow_ids.filter(id=>workflow_ids.includes(id))};
  }
  async authorizeExecution(operation, args, details = {}) {
    const identity = this.host.mainIdentity();
    const required = this.host.executionAdmissionRequired?.(identity.session_id) === true
      || this.host.capabilities.execution_admission_required === true;
    if (typeof this.host.authorizeExecution !== 'function') {
      requireValue(!required, 'PI_EXECUTION_ADMISSION_REQUIRED', 'This session requires a registered private execution admission adapter');
      return null;
    }
    const request = { session_id: identity.session_id, operation, args: structuredClone(args), required, ...structuredClone(details) };
    const admission = await this.host.authorizeExecution(request);
    requireValue(admission?.authorized === true, 'PI_EXECUTION_ADMISSION_DENIED', 'The private Host execution admission adapter did not authorize this new execution');
    requireValue(admission.session_id === identity.session_id && admission.operation === operation,
      'PI_EXECUTION_ADMISSION_SCOPE', 'Execution admission belongs to another session or operation');
    requireValue(this.host.mainIdentity().session_id === identity.session_id, 'PI_MAIN_SESSION_CHANGED', 'The current Pi session changed during execution admission');
    console.info('[pi-CAW] execution admission', { session_id:identity.session_id, operation, required,
      workflow_id:args.workflow_id, role_id:args.role_id, scope:admission.scope ?? null });
    return admission;
  }
  async start(args) {
    args = structuredClone(args);
    const catalog = this.host.catalog();
    const settings = this.currentSettings;
    const constraints = { ...(args.constraints ?? {}) };
    const mainContext = args.main_context === undefined ? undefined : mainContextChoice(args.main_context);
    // Caller constraints cannot forge a frozen execution selection.
    delete constraints.pi_caw_main_modes; delete constraints.pi_caw_main_context;
    if (Object.hasOwn(constraints, 'execution_binding')) {
      constraints.execution_binding = qualifiedExecutionBinding(constraints.execution_binding);
      requireValue(constraints.execution_binding, 'PI_EXECUTION_BINDING', 'An explicitly supplied execution binding must be complete');
    }
    // Resolve before creating a Run, and freeze the same model contracts in its pins.
    const pack = await this.store.snapshot(args.workflow_id, args.revision_hash);
    const closure = await resolveWorkflowPins(this.store, pack);
    const requestedModes = args.main_modes ?? {};
    requireValue(requestedModes && typeof requestedModes === 'object' && !Array.isArray(requestedModes), 'MAIN_EXECUTION_MODE', 'main_modes is a map from root Main node IDs to worker/orchestration');
    for (const [id, mode] of Object.entries(requestedModes)) {
      checkedMainMode(mode);
      requireValue(pack.workflow.nodes.some(node => node.id === id && node.executor?.kind === 'main'), 'MAIN_EXECUTION_NODE', `No root Main node matches ${id}`);
    }
    constraints.pi_caw_main_modes = {};
    for (const item of closure.packs) {
      const modes = constraints.pi_caw_main_modes[item.workflow.id] = {};
      for (const node of item.workflow.nodes) if (node.executor?.kind === 'main' && !isAuthoringRunProvenance(item.provenance)) {
        const policy = effectiveSkillPolicy(item.workflow.skill_policy, node.skill_policy);
        const legacyChoice = mainContext !== undefined && node.executor.mode === undefined ? {pi_caw_main_context: mainContext} : {};
        const override = item.workflow.id === pack.workflow.id ? requestedModes[node.id] : undefined;
        modes[node.id] = mainExecutionMode(override ? {...node, executor:{kind:'main', mode:override}} : node, policy, legacyChoice, item.workflow.id);
        if (modes[node.id] === 'worker') requireValue(this.host.capabilities.isolated_main === true, 'PI_MAIN_ISOLATION_UNAVAILABLE', 'This Pi Host cannot execute isolated Main workers');
      }
    }
    const mainIdentity = this.host.mainIdentity();
    if (Object.values(constraints.pi_caw_main_modes).some(modes => Object.values(modes).includes('orchestration'))) {
      const cwd = this.host.getContext?.().cwd;
      requireValue(typeof cwd === 'string' && resolve(args.workspace) === resolve(cwd), 'PI_MAIN_WORKSPACE', 'An orchestration node must use the initiating Pi chat workspace');
    }
    requireWorkflowInScope(await this.workflowScope(),pack.workflow.id);
    await this.authorizeExecution('run', args, { workflow_id:pack.workflow.id, revision_hash:pack.revision_hash,
      workflow:pack.workflow, host_tool_contracts:closure.packs.flatMap(item => item.workflow.host_tools ?? []) });
    requireValue(this.host.mainIdentity().session_id === mainIdentity.session_id, 'PI_MAIN_SESSION_CHANGED', 'The current Pi session changed before Run creation');
    requireWorkflowInScope(await this.workflowScope(),pack.workflow.id);
    requireValue(this.host.mainIdentity().session_id === mainIdentity.session_id, 'PI_MAIN_SESSION_CHANGED', 'The current Pi session changed while rechecking Workflow scope before Run creation');
    this.runtime.context.providers = settings.providers.map(provider => coreProvider({ ...provider,
      binding: closure.provider_ids.includes(provider.id) ? resolveBinding(provider.binding, catalog) : provider.binding }));
    const detached = !this.workerMode && args.detached_host !== false && typeof this.host.detachedBootstrap === 'function';
    if (detached) await this.host.detachedBootstrap([...new Set(closure.provider_ids.map(id => settings.providers.find(provider => provider.id === id)?.binding?.provider).filter(Boolean))]);
    requireValue(this.host.mainIdentity().session_id === mainIdentity.session_id, 'PI_MAIN_SESSION_CHANGED', 'The current Pi session changed during SDK preflight before Run creation');
    const run = await this.runtime.start({ ...args, main_actor: mainIdentity.session_id,
      constraints: { ...constraints, pi_caw_detached_owner: detached, require_main_session_identity: true, pi_caw_main_session: mainIdentity } });
    await writeDurableJSON(join(this.runtime.runs.directory(run.run_id), 'pi-controller.json'), { control_token: run.control_token });
    this.observedRuns.add(run.run_id);
    this.progressCandidates?.add(run.run_id);
    await this.host.emit?.('pi-caw:run-lifecycle', { run_id: run.run_id, status: 'started', main_actor: mainIdentity.session_id,
      host_tool_ids: [...new Set(closure.packs.flatMap(item => (item.workflow.host_tools ?? []).map(tool => tool.id)))] });
    await this.publishProgress();
    await this.launchDriver(run.run_id);
    const { control_token, ...view } = run;
    return view;
  }
  async launchDriver(runId, options = {}) {
    await this.assertDriverRelease(runId);
    if (!this.workerMode && typeof this.host.detachedBootstrap === 'function') {
      const record = await this.runtime.runs.read(runId);
      if (record.state.constraints.pi_caw_detached_owner !== false) return this.launchDetachedDriver(runId, record, options);
    }
    requireValue(!this.active.has(runId), 'PI_RUN_BUSY', 'This Run already has an execution owner');
    const owner = { controller: new AbortController(), completion: null };
    this.active.set(runId, owner);
    const journalPath = join(this.runtime.runs.directory(runId), 'pi-worker.json');
    const journal = { run_id: runId, process_id: process.pid, session_id: this.host.mainIdentity().session_id, started_at: new Date().toISOString() };
    owner.completion = writeDurableJSON(journalPath, { ...journal, status: 'running' }).then(() => this.drive(runId, owner.controller.signal, options)).then(async result => {
      await writeDurableJSON(journalPath, { ...journal, ...result, settled_at: new Date().toISOString() });
      if (result.status === 'succeeded') await this.collectParent(runId);
      await this.notify({ run_id: runId, ...result }); return result;
    }, async error => {
      const result = { status: 'attention', error: diagnostic(error) };
      await writeDurableJSON(journalPath, { ...journal, ...result, settled_at: new Date().toISOString() });
      await this.notify({ run_id: runId, ...result }); return result;
    }).finally(() => this.active.delete(runId));
    return { run_id: runId, status: 'running', background: true };
  }
  async assertDriverRelease(runId) {
    const record = await this.runtime.runs.read(runId);
    requireValue(!record.state.control_recovery?.errors?.length, 'CONTROL_RECOVERY_INCOMPLETE', 'Resolve exact owner cleanup errors before releasing new execution');
    if (this.workerMode || typeof this.host.detachedBootstrap !== 'function') return;
    const prior = await this.detachedOwners.read(runId);
    if (!prior?.termination?.confirmed) return;
    const sameControllerResume = prior.phase === 'stopped' && prior.termination.reason === 'authority_revoked';
    requireValue(prior.controller_hash !== record.state.control_hash || sameControllerResume,
      'PI_OWNER_RECOVERY_REQUIRED', 'The stopped owner is not eligible for resume; take control and reconcile its exact attempt before retrying.');
  }
  async drive(runId, signal, { recoveredNodes = [] } = {}) {
    const authority = await this.authority(runId);
    for (const nodeId of recoveredNodes) {
      const record = await this.runtime.runs.read(runId), attempt = record.state.nodes[nodeId].attempts.at(-1);
      requireValue(!attempt.dispatch && attempt.reconciliation?.kind === 'unsubmitted_claim', 'DISPATCH_UNCERTAIN', 'Recovered dispatch must still be unsubmitted');
      const lease = { ...authority, node_id: nodeId, attempt_id: attempt.id, lease_token: leaseToken(authority.control_token, runId, nodeId, attempt.id, attempt.lease_generation ?? 0) };
      const envelope = { ...await this.runtime.execution(runId, lease), attempt_id: attempt.id, lease_token: lease.lease_token };
      const outcome = await this.executeNode(runId, nodeId, authority, signal, envelope);
      if (outcome?.authoring_review) {
        const reviewed = await this.workbench.authoring.afterReview(runId, authority);
        if (reviewed.awaiting_acceptance) return { status: 'awaiting_acceptance' };
        if (reviewed.awaiting_user_input) return { status: 'user_input_required' };
      }
      if (outcome?.awaiting_acceptance) return { status: 'awaiting_acceptance' };
    }
    for (;;) {
      if (signal.aborted) return { status: 'cancelled' };
      const owner = this.active.get(runId);
      if (owner?.pauseRequested) {
        await this.runtime.pause(runId, { ...authority, reason: owner.pauseRequested }); return { status: 'paused' };
      }
      const next = await this.runtime.next(runId);
      if (next.status !== 'running' || !next.ready.length) return { status: next.status, approvals: next.approvals };
      // Graph regions can expose several read-only lanes. Core refuses parallel
      // writes until a qualified worktree/integration manager is supplied.
      const record = await this.runtime.runs.read(runId); let selectedMain = false;
      const ready = next.ready.filter(nodeId => {
        if (record.pins.root.workflow.nodes.find(node => node.id === nodeId).executor?.kind !== 'main') return true;
        if (selectedMain) return false; selectedMain = true; return true;
      });
      const outcomes = await Promise.allSettled(ready.map(nodeId => this.executeNode(runId, nodeId, authority, signal)));
      const failures = outcomes.filter(result => result.status === 'rejected').map(result => result.reason);
      if (failures.length) throw new AggregateError(failures, 'Pi node execution requires attention');
      for (const outcome of outcomes) if (outcome.value?.authoring_review) {
        const reviewed = await this.workbench.authoring.afterReview(runId, authority);
        if (reviewed.awaiting_acceptance) return { status: 'awaiting_acceptance' };
        if (reviewed.awaiting_user_input) return { status: 'user_input_required' };
      }
      if (owner?.pauseRequested) {
        await this.runtime.pause(runId, { ...authority, reason: owner.pauseRequested }); return { status: 'paused' };
      }
      if (outcomes.some(result => result.value?.awaiting_acceptance)) return { status: 'awaiting_acceptance' };
      if (outcomes.some(result => result.value?.awaiting_child)) return { status: 'awaiting_child' };
      if (outcomes.some(result => result.value?.awaiting_user_input)) return { status: 'user_input_required' };
    }
  }
  async descendants(runId) {
    const record = await this.runtime.runs.read(runId), ids = [runId];
    for (const node of Object.values(record.state.nodes)) for (const attempt of node.attempts)
      if (attempt.child_run_id) ids.push(...await this.descendants(attempt.child_run_id));
    return [...new Set(ids)];
  }
  async collectParent(childRunId) {
    const child = await this.runtime.runs.read(childRunId), parent = child.pins.parent;
    if (!parent) return;
    const authority = await this.authority(parent.run_id), record = await this.runtime.runs.read(parent.run_id);
    const attempt = record.state.nodes[parent.node_id]?.attempts.find(item => item.id === parent.attempt_id);
    requireValue(attempt && attempt.child_run_id === childRunId, 'PI_CHILD_LINEAGE', 'Child Run no longer belongs to the exact parent attempt');
    await this.runtime.collectSubworkflow(parent.run_id, { ...authority, node_id: parent.node_id, attempt_id: attempt.id,
      lease_token: leaseToken(authority.control_token, parent.run_id, parent.node_id, attempt.id, attempt.lease_generation ?? 0) });
    if (!this.active.has(parent.run_id)) await this.launchDriver(parent.run_id);
  }
  async resources(runId, envelope) {
    const record = await this.runtime.runs.read(runId);
    const resources = envelope.resources.map(path => {
      const pin = record.pins.root.resources.find(item => item.path === path);
      requireValue(pin, 'PI_RESOURCE_MISSING', 'Declared resource has no immutable Run pin');
      return { ...pin, object_path: join(this.runtime.runs.directory(runId), 'objects', pin.sha256) };
    });
    // Linked Skill closure bytes are carried by the same Run object store.
    for (const skill of envelope.allowed_skills ?? []) for (const pin of skill.resources ?? [])
      resources.push({ ...pin, path: `skills/${digest(skill.path).slice(0, 16)}/${pin.path}`, skill_name: skill.name,
        object_path: join(this.runtime.runs.directory(runId), 'objects', pin.sha256) });
    return resources;
  }
  prompt(envelope) {
    const template = renderTemplate(envelope.prompt_template, { ...envelope.inputs, provider_name: envelope.provider?.name });
    const prompt = `${template}\n\nDeclared inputs:\n${canonicalJSON(envelope.inputs)}\n\nAccess: ${envelope.access}\nAllowed write paths: ${canonicalJSON(envelope.effective_allowed_paths)}\nPinned resources: ${canonicalJSON(envelope.resources)}\nUse only the declared task inputs. Resource paths are logical names for the pinned-resource tool.`;
    requireValue(prompt.length <= (this.currentSettings.global?.max_prompt_chars ?? 80000), 'PI_PROMPT_LIMIT', 'Node prompt exceeds the configured limit; use pinned resources instead of copying file contents');
    return prompt;
  }
  async executeNode(runId, nodeId, authority, signal, recoveredEnvelope) {
    let record = await this.runtime.runs.read(runId);
    const executionBinding = qualifiedExecutionBinding(record.state.constraints?.execution_binding);
    const definition = record.pins.root.workflow.nodes.find(node => node.id === nodeId);
    const authoring = isAuthoringRunProvenance(record.pins.root.provenance);
    if (authoring) {
      try { await this.workbench.authoring.prepare(runId, nodeId, authority); }
      catch (error) { if (await this.workbench.authoring.repairFailure(runId, authority, error)) return { authoring_phase: 'repairing' }; throw error; }
      record = await this.runtime.runs.read(runId);
    }
    const main = definition.executor?.kind === 'main';
    let envelope = recoveredEnvelope ?? await (main ? this.runtime.claimHostMain(runId, { ...authority, node_id: nodeId, owner: record.state.main_actor, request_id: `claim-${nodeId}-${record.sequence}` })
      : this.runtime.claimNode(runId, { ...authority, node_id: nodeId, owner: 'pi-sdk-host', request_id: `claim-${nodeId}-${record.sequence}` }));
    const args = { ...authority, node_id: nodeId, attempt_id: envelope.attempt_id, lease_token: envelope.lease_token };
    await this.parallel.ensureNode(this.runtime, runId, args);
    envelope = { ...await this.runtime.execution(runId, args), attempt_id: envelope.attempt_id, lease_token: envelope.lease_token };
    const taskRoot = envelope.inputs.task_root ?? record.state.constraints?.task_workspace
      ?? (executionBinding ? record.state.permissions.workspace : undefined);
    if (definition.type === 'tool') {
      try {
        const contract = hostToolContracts(record.pins.root.workflow).get(definition.executor.tool);
        await this.runtime.recordHostToolIntent(runId, { ...args, contract, input: envelope.inputs });
        const pinned = await this.resources(runId, envelope);
        const resources = await Promise.all(pinned.map(async item => { const bytes = await readFile(item.object_path); requireValue(digest(bytes) === item.sha256, 'PI_RESOURCE_DRIFT', 'Host tool resource changed'); return { ...item, bytes }; }));
        const external = !Object.hasOwn(this.builtinHostTools, contract.id);
        const execute = external ? (contract, input, context, options) => {
          const registry = mergeHostTools(this.builtinHostTools, this.getHostTools());
          const descriptor = externalHostToolDescriptors({ [contract.id]: registry[contract.id] })[0];
          return executeExternalHostTool(registry, contract, input, context, { ...options, authorize: async () => {
            requireValue(!signal?.aborted, 'PI_TASK_ABORTED', 'Exact domain attempt was revoked');
            requireValue(this.host.mainIdentity().session_id === record.state.main_actor, 'PI_MAIN_SESSION_CHANGED', 'Domain tools retain the original Pi actor');
            const current = mergeHostTools(this.builtinHostTools, this.getHostTools());
            requireValue(canonicalJSON(externalHostToolDescriptors({ [contract.id]: current[contract.id] })[0]) === canonicalJSON(descriptor),
              'PI_EXTERNAL_HOST_PIN', 'Domain implementation identity or qualification changed during the exact attempt');
            await this.runtime.execution(runId, args);
          } });
        }
          : this.toolRunner.execute.bind(this.toolRunner);
        const result = await execute(contract, envelope.inputs, { run_id: runId, node_id: nodeId, attempt_id: envelope.attempt_id,
          workspace: envelope.workspace, permissions: { access: envelope.access, allowed_paths: envelope.effective_allowed_paths }, resources,
          runtime_environment: runtimeEnvironmentForState(record.state),
          prepareRuntimeEnvironment: async () => (await this.runtime.ensureRuntimeEnvironment(runId, authority)).environment,
          task_root: taskRoot ?? envelope.workspace,
          ...(executionBinding ? { execution_binding: executionBinding } : {}) }, { signal });
        if (result.receipt.status === 'succeeded') {
          const output = { kind: 'host_tool_output', output: result.output };
          result.receipt.output_ref = { ...await this.runtime.runs.saveExecutorResult(runId, envelope.attempt_id, output), bytes: Buffer.byteLength(canonicalJSON(output)) };
        }
        await this.runtime.recordHostToolReceipt(runId, { ...args, receipt: result.receipt });
        requireValue(result.receipt.status === 'succeeded', 'PI_HOST_TOOL_FAILED', result.receipt.diagnostics.message);
        return this.runtime.completeNode(runId, { ...args, completion: { status: 'succeeded', summary: result.receipt.diagnostics.message,
          structured_output: result.output, artifacts: [], evidence: [{ kind: 'host_tool', tool: contract.id, sha256: result.receipt.output_sha256 }],
          changed_paths: result.receipt.effects.changed_paths, outside_paths: result.receipt.effects.outside_paths } });
      } catch (error) { await this.runtime.failNode(runId, { ...args, error: diagnostic(error) }); throw error; }
    }
    if (definition.type === 'subworkflow') {
      const { child } = await this.runtime.startSubworkflow(runId, args);
      await writeDurableJSON(join(this.runtime.runs.directory(child.run_id), 'pi-controller.json'), { control_token: child.control_token });
      const outcome = await this.drive(child.run_id, signal);
      if (outcome.status !== 'succeeded') {
        await this.notify({ run_id: child.run_id, parent_run_id: runId, ...outcome });
        return { awaiting_child: child.run_id };
      }
      return this.runtime.collectSubworkflow(runId, args);
    }
    requireValue(['agent', 'skill_ref'].includes(definition.type), 'PI_HOST_TOOL_REQUIRED', 'This node requires a qualified Pi host-tool executor');
    if (main) requireValue(this.host.mainIdentity().session_id === record.state.main_actor, 'PI_MAIN_SESSION_CHANGED', 'This Run belongs to another current Pi chat');
    const independentReview = authoring && nodeId === record.pins.root.workflow.finalization.node_id;
    const mainMode = main && !independentReview ? mainExecutionMode(definition, envelope.skill_policy, record.state.constraints, record.state.workflow_id) : null;
    const mainContext = mainMode ? mainContextForMode(mainMode) : null;
    if (independentReview) {
      const provider = record.pins.authoring_reviewer ?? record.pins.generation?.reviewer;
      requireValue(provider?.id === definition.authoring_reviewer_provider_id || provider?.id === record.pins.root.workflow.authoring?.review_provider_id,
        'PI_AUTHORING_REVIEW_BINDING', 'Independent review requires its exact pinned Pi Provider');
      envelope = { ...envelope, provider };
    }
    const binding = main && !independentReview ? null : resolveBinding(envelope.provider.config, this.host.catalog());
    const requestId = `dispatch-${envelope.attempt_id}`;
    const dispatch = { ...args, request_id: requestId, envelope_hash: digest(canonicalJSON(envelope)) };
    await (main ? this.runtime.recordHostMainDispatchIntent(runId, dispatch) : this.runtime.recordDispatchIntent(runId, dispatch));
    const tasks = [];
    const releasedOwners = new Set();
    let ownersClosed = false, executionError;
    const closeOwners = async () => {
      if (ownersClosed) return;
      const settled = await Promise.allSettled(tasks.filter(item => !releasedOwners.has(item.task)).map(async item => {
        await this.host.releaseTask(item.task); releasedOwners.add(item.task);
      }));
      const failures = settled.filter(item => item.status === 'rejected').map(item => item.reason);
      if (failures.length) {
        const cause = new AggregateError([...(executionError ? [executionError] : []), ...failures], 'Pi executor cleanup is unconfirmed');
        await this.interruptUnconfirmedShutdown(runId, args, cause);
        throw cause;
      }
      if (executionError?.quiescent === false) {
        // A later fan-out startup may own a process without returning a task.
        // Closing the earlier children does not prove that extra owner stopped.
        await this.interruptUnconfirmedShutdown(runId, args, executionError);
        throw executionError;
      }
      ownersClosed = true;
      await this.runtime.recordExecutorEvent(runId, { ...args, event: { kind: 'session_state', metadata: { status: 'closed',
        diagnostic: main && !independentReview && mainContext === 'current' ? 'Main dispatch settled in the current Pi chat; no chat was disposed' : `${tasks.length} owned Pi execution session(s) aborted, settled and disposed` } } });
    };
    try {
      const fanout = definition.fanout;
      const plan = fanout ? resolvedSubagentPlan(definition, record.state) : { count: 1, items: null, assignments: [null] };
      const claimedRecord = await this.runtime.runs.read(runId);
      const inherited = new Set(claimedRecord.state.nodes[nodeId].attempts.at(-1)?.inherited_native_item_indices ?? []);
      const activeAssignments = plan.assignments.map((items, index) => ({ index, indices: fanout ? assignedFanoutIndices(plan, fanout, index).filter(itemIndex => !inherited.has(itemIndex)) : [], items }))
        .filter(item => !fanout || item.indices.length);
      const derived = authoring ? await this.workbench.authoring.resources(runId, nodeId, authority, envelope) : { resources: [], identity: null };
      const resources = [...await this.resources(runId, envelope), ...derived.resources];
      let source;
      if (envelope.thread?.lifecycle === 'continue') {
        const prior = record.state.nodes[definition.executor.source_node].attempts.find(attempt => attempt.completion_hash && attempt.dispatch?.receipt?.thread_id === envelope.thread.source.thread_id);
        requireValue(prior?.dispatch.receipt.session_file, 'PI_THREAD_FILE_REQUIRED', 'Source thread has no exact Pi session file');
        source = prior.dispatch.receipt;
      }
      for (const assignment of activeAssignments) {
        const assignedItems = fanout ? assignment.indices.map(index => plan.items[index]) : null;
        const schema = fanout ? { type: 'object', properties: { items: { type: 'array', items: fanout.result_mode === 'per_item' ? {} : definition.outputs_schema.properties[fanout.result_output].items } }, required: ['items'], additionalProperties: false }
          : authoring ? authoringAttemptOutputSchema(claimedRecord,nodeId) : semanticResultSchema(definition, { finalAcceptance: main && nodeId === record.pins.root.workflow.finalization.node_id });
        const task = await (main && !independentReview ? this.host.createMainTask.bind(this.host) : this.host.createTask.bind(this.host))({ run_id: runId, node_id: nodeId, name: definition.name ?? nodeId, signal,
          kind: main && !independentReview ? 'main' : envelope.thread ? 'thread' : 'subagent', binding, workspace: envelope.workspace,
          ...(mainContext ? {context_mode:mainContext, main_mode:mainMode, audit_excluded_roots:[this.directory]} : {}),
          access: envelope.access, allowed_paths: fanout ? assignedFanoutWritePaths({ workspace: envelope.workspace, nodeAllowedPaths: envelope.effective_allowed_paths, assignedItems, fanout }) : envelope.effective_allowed_paths,
          schema, resources, ...(!fanout ? {validateResult: async result => {
            const live = await this.runtime.runs.read(runId);
            await this.runtime.execution(runId, args);
            if(authoring)return this.workbench.authoring.preflightResult(runId,nodeId,result);
            await preflightSemanticOutput(definition,result,envelope.workspace,{state:live.state,pins:live.pins,
              finalAcceptance:main && nodeId===live.pins.root.workflow.finalization.node_id});
          }} : {}), strict: envelope.skill_policy.mode === 'strict',
          required_mcp_servers: record.pins.root.workflow.requirements?.mcp_servers ?? [],
          runtime_environment: runtimeEnvironmentForState(record.state),
          ...(executionBinding ? { execution_binding: executionBinding } : {}),
          ...(taskRoot ? { task_root: taskRoot } : {}),
          authorize: () => this.runtime.execution(runId, args),
          onOperation: metadata => this.runtime.recordExecutorEvent(runId, { ...args, event: { kind: 'tool_operation', metadata } }),
          ...(source ? { session_id: source.thread_id, session_file: source.session_file } : {}) });
        tasks.push({ task, assignment, assignedItems, schema });
      }
      const receipt = { executor: independentReview ? 'pi-sdk-authoring-review' : main ? mainContext === 'isolated' ? 'pi-isolated-main' : 'pi-current-chat-main' : 'pi-sdk-subagent', invocation_id: requestId,
        ...(tasks[0]?.task.session_storage ? {session_storage:tasks[0].task.session_storage} : {}),
        ...(mainContext ? {context_mode:mainContext, main_mode:mainMode} : {}),
        ...(mainContext === 'isolated' ? {observed_model:tasks[0].task.observed_model} : {}),
        ...(main && !independentReview ? { main_actor: record.state.main_actor, session_id: record.state.main_actor, call_chain_id: runId } : {}),
        ...(derived.identity ? { authoring_review_context: derived.identity } : {}),
        ...(tasks.length === 1 ? { thread_id: tasks[0].task.session_id, session_file: tasks[0].task.session_file } : {}),
        ...(fanout ? { subagent_dispatch_ids: tasks.map(item => item.task.session_id), subagent_plan: {
          resolved_count: tasks.length, input_sha256: digest(canonicalJSON(plan.items)), assignments: tasks.map(item => ({
            ...(fanout.result_mode === 'per_item' ? { assignment_index: item.assignment.index } : {}),
            dispatch_id: item.task.session_id, items_sha256: digest(canonicalJSON(item.assignedItems)) })) } } : {}),
        ...(mainContext === 'current' || tasks.length <= 1 ? {} : {sessions:tasks.map(item=>({thread_id:item.task.session_id,session_file:item.task.session_file}))}) };
      await (main ? this.runtime.recordHostMainDispatchReceipt(runId, { ...dispatch, receipt }) : this.runtime.recordDispatchReceipt(runId, { ...dispatch, receipt }));
      const outputs = new Array(tasks.length); let cursor = 0;
      const concurrency = fanout?.scheduling === 'serial' ? 1 : Math.min(fanout?.max_concurrency ?? 4, tasks.length);
      const workerResults = await Promise.allSettled(Array.from({ length: concurrency }, async () => {
        while (cursor < tasks.length) {
          const index = cursor++, item = tasks[index];
          const deliveries = fanout?.item_delivery === 'incremental' ? item.assignment.indices.map(value => [value]) : [item.assignment.indices];
          const turns = [];
          for (const indices of deliveries) {
            const selectedItems = fanout ? indices.map(value => plan.items[value]) : null;
            const childEnvelope = fanout ? { ...envelope, inputs: projectFanoutInputs(envelope.inputs, plan.items, selectedItems) } : envelope;
            if (main && !independentReview) await this.runtime.reserveHostMainTurn(runId, args);
            const instructions = fanout?.result_mode === 'per_item'
              ? '\nReturn items in exactly the supplied input order, each as {"outcome":"completed","result":<semantic result>}, or {"outcome":"blocked","block_reason":<specific reason>}. Result schema: ' + canonicalJSON(definition.outputs_schema.properties[fanout.result_output].items)
              : fanout ? '\nReturn exactly one semantic aggregate in the items array.' : '';
            const output = await item.task.run({ prompt: this.prompt(childEnvelope) + instructions
              + '\nPinned resource catalog: ' + canonicalJSON(resources.map(({ path, sha256, skill_name }) => ({ path, sha256, ...(skill_name ? { skill_name } : {}) }))), schema: item.schema, signal });
            if (fanout?.result_mode === 'per_item') {
              const admission = await this.runtime.recordNativeItemResults(runId, { ...args, index: item.assignment.index,
                agent_id: item.task.session_id, turn_id: output.turn_id, target_indices: indices, result: output.result });
              requireValue(!admission.issues?.length, 'PI_ITEM_RESULT_INVALID', 'One or more item results were rejected by the Host');
            }
            turns.push(output);
          }
          outputs[index] = { ...turns.at(-1), changed_paths: [...new Set(turns.flatMap(output => output.changed_paths))],
            usage: aggregateUsage(turns.map(turn => turn.usage)),
            summary: turns.map(output => output.summary).join('\n') };
        }
      }));
      const workerFailures = workerResults.filter(result => result.status === 'rejected').map(result => result.reason);
      if (workerFailures.length === 1) throw workerFailures[0];
      if (workerFailures.length) throw new AggregateError(workerFailures, 'One or more Pi children failed');
      await (main ? this.runtime.recordHostMainUsage(runId, { ...args, request_id: requestId, usage: aggregateUsage(outputs.map(output => output.usage)) })
        : this.runtime.recordUsage(runId, { ...args, request_id: requestId, usage: aggregateUsage(outputs.map(output => output.usage)) }));
      let structuredOutput = outputs[0]?.result ?? {};
      if(authoring)validateData(structuredOutput,tasks[0].schema);
      const evidence = outputs.map(output => ({ ...output.evidence, ...(envelope.thread ? { dispatch_request_id: requestId } : {}) }));
      if (fanout) {
        const resultSchema = definition.outputs_schema.properties[fanout.result_output].items;
        let joined;
        if (fanout.result_mode === 'per_item') {
          const latest = await this.runtime.runs.read(runId), attempt = latest.state.nodes[nodeId].attempts.at(-1);
          joined = plan.items.map((_item, index) => attempt.native_item_results[index].result);
        } else joined = outputs.map(output => {
          requireValue(Array.isArray(output.result.items) && output.result.items.length === 1, 'PI_POOL_RESULT', 'Each child must return exactly one joined result');
          validateData(output.result.items[0], resultSchema); return output.result.items[0];
        });
        const receipts = outputs.map((output, index) => ({ dispatch_id: tasks[index].task.session_id, result_index: index,
          result_sha256: digest(canonicalJSON(fanout.result_mode === 'per_item' ? assignedFanoutIndices(plan, fanout, tasks[index].assignment.index).map(itemIndex => joined[itemIndex]) : joined[index])),
          thread_id: output.session_id, turn_id: output.turn_id }));
        await this.runtime.recordManagedNativeResults(runId, { ...args, results: receipts });
        evidence.push({ kind: 'subagent_pool', resolved_count: tasks.length, dispatch_ids: receipt.subagent_dispatch_ids },
          ...receipts.map(result => ({ kind: 'managed_native_result', ...result })));
        structuredOutput = { [fanout.result_output]: joined };
      }
      const completion = { status: 'succeeded', summary: outputs.map(output => output.summary).join('\n').slice(0, 20000),
        structured_output: structuredOutput, artifacts: [], evidence,
        changed_paths: [...new Set(outputs.flatMap(output => output.changed_paths))], outside_paths: [] };
      if (definition.decision) {
        completion.structured_output.decision_id = definition.decision.id;
        completion.structured_output.references = [...definition.decision.required_references];
      }
      {
        const durable = await this.runtime.runs.saveExecutorResult(runId, envelope.attempt_id, completion);
        await this.runtime.recordExecutorEvent(runId, { ...args, event: { kind: 'result_proposed', metadata: { ...durable,
          ...(derived.identity ?? {}), final_acceptance_required: nodeId === record.pins.root.workflow.finalization.node_id } } });
        await closeOwners();
        if (independentReview) return { authoring_review: true };
        if (main && nodeId === record.pins.root.workflow.finalization.node_id) return { awaiting_acceptance: true };
        if (main) return this.runtime.completeHostMainResult(runId, args);
      }
      return this.runtime.completeNode(runId, { ...args, completion });
    } catch (error) {
      executionError = error;
      // Stop all launched sessions before failing the attempt. Do not silently
      // retry a dispatch whose shutdown or external effect is unconfirmed.
      const aborted = await Promise.allSettled(tasks.map(item => item.task.abort()));
      const abortFailures = aborted.filter(item => item.status === 'rejected').map(item => item.reason);
      if (abortFailures.length) {
        const cause = new AggregateError([error, ...abortFailures], 'Pi executor abort is unconfirmed');
        await this.interruptUnconfirmedShutdown(runId, args, cause);
        throw cause;
      }
      await closeOwners();
      const failed = await this.runtime.runs.read(runId), call = failed.state.cost_ledger.calls.find(item => item.call_id === requestId);
      if (call && !call.usage) await (main ? this.runtime.recordHostMainUsage(runId, { ...args, request_id: requestId, usage: { unknown: true } })
        : this.runtime.recordUsage(runId, { ...args, request_id: requestId, usage: { unknown: true } }));
      await this.runtime.failNode(runId, { ...args, error: diagnostic(error) });
      throw error;
    } finally {
      await closeOwners();
    }
  }
  async resumeRecoveredAttempt(runId, args, attached) {
    const record = await this.runtime.runs.read(runId), definition = record.pins.root.workflow.nodes.find(node => node.id === args.node_id);
    const attempt = record.state.nodes[args.node_id].attempts.find(item => item.id === args.attempt_id);
    requireValue(!this.active.has(runId) && attempt?.reconciliation, 'PI_RECOVERY_OWNER', 'Recovery requires one settled owner and an exact reconciled attempt');
    if (attempt.reconciliation.kind === 'strict_durable_result') {
      if (args.node_id === record.pins.root.workflow.finalization.node_id) {
        if (!isAuthoringRunProvenance(record.pins.root.provenance))
          return { ...attached, status: 'awaiting_acceptance', recovered_result: true, model_calls: 0 };
        const reviewed = await this.workbench.authoring.afterReview(runId, args);
        if (reviewed.awaiting_acceptance)
          return { ...attached, status: 'awaiting_acceptance', recovered_result: true, model_calls: 0 };
        if (reviewed.awaiting_user_input)
          return { ...attached, status: 'user_input_required', recovered_result: true, model_calls: 0 };
        requireValue(reviewed.authoring_phase === 'repairing', 'PI_RECOVERY_REVIEW_OUTCOME', 'Recovered review returned no acceptance, guidance or semantic repair outcome');
      } else {
        const completion = await this.runtime.runs.readExecutorResult(runId, args.attempt_id, attempt.result_proposal.sha256);
        if (definition.executor?.kind === 'main') await this.runtime.completeHostMainResult(runId, args);
        else await this.runtime.completeNode(runId, { ...args, completion });
      }
    } else if (attempt.reconciliation.kind === 'subworkflow_exact_identity') {
      const child = await this.runtime.runs.read(attempt.child_run_id);
      if (child.state.status !== 'succeeded') return { ...attached, status: 'awaiting_child' };
      await this.runtime.collectSubworkflow(runId, args);
    }
    const latest = await this.runtime.runs.read(runId);
    if (Object.values(latest.state.nodes).some(node => node.status === 'interrupted')) return { ...attached, status: 'reconciliation_required' };
    const recoveredNodes = Object.entries(latest.state.nodes).filter(([,node]) => node.status === 'claimed' && !node.attempts.at(-1)?.dispatch && node.attempts.at(-1)?.reconciliation?.kind === 'unsubmitted_claim').map(([id]) => id);
    if (['paused', 'interrupted', 'blocked'].includes(latest.state.status)) await this.runtime.resume(runId, args);
    if ((await this.runtime.runs.read(runId)).state.status === 'running') return { ...attached, ...await this.launchDriver(runId, { recoveredNodes }) };
    return attached;
  }
  async launchRole(args, { human = false } = {}) {
    args = structuredClone(args);
    await this.authorizeExecution('role_launch', args);
    requireValue(this.currentSettings.global?.enabled !== false, 'PI_CAW_DISABLED', 'Role execution is disabled in the Workbench');
    requireValue(typeof args.task === 'string' && args.task.trim() && args.task.length <= 30000, 'ROLE_TASK', 'Role task must be nonempty and bounded');
    const role = await this.workbench.roleProfile(args);
    requireValue(role.status === 'ready' && role.enabled && role.provider_available, 'PI_ROLE_UNBOUND', 'Role must be published, enabled and explicitly bound to a Pi Provider');
    requireValue(!role.requires_user_approval || human, 'ROLE_APPROVAL_REQUIRED', 'This Role requires a human launch from the Workbench');
    const grant = runPermissions({ workspace: args.workspace ?? this.host.getContext().cwd, access: role.access, allowed_paths: args.allowed_paths ?? [] });
    const scoped = nodePermissions({ access: role.access, path_scope: role.path_scope }, { permissions: grant });
    const permissions = { ...grant, ...scoped };
    const coordinator = this.host.main?.pending;
    if (coordinator?.active && coordinator.request.main_mode === 'orchestration') {
      const parent = coordinator.request;
      requireValue(resolve(permissions.workspace) === resolve(parent.workspace), 'PI_ORCHESTRATION_SCOPE', 'A helper must use its coordinating node workspace');
      const within = (path, boundary) => { const norm = value => process.platform === 'win32' ? value.toLowerCase() : value; path=norm(path); boundary=norm(boundary); return boundary==='.' || path===boundary || path.startsWith(boundary+'/'); };
      requireValue(permissions.access === 'read_only' || parent.access === 'bounded_write' && permissions.allowed_paths.every(path => parent.allowed_paths.some(boundary => within(path, boundary))), 'PI_ORCHESTRATION_SCOPE', 'A helper cannot widen the coordinating node write grant');
    }
    const resources = []; let requiredMcpServers;
    if (role.source_workflow_id) {
      const pack = await this.store.snapshot(role.source_workflow_id, role.revision_hash), node = pack.workflow.nodes.find(item => item.role !== 'finalizer' && item.type === 'agent');
      requiredMcpServers = pack.workflow.requirements?.mcp_servers ?? [];
      for (const path of node.resources ?? []) { const resource = pack.resources.find(item => item.path === path); requireValue(resource, 'PI_RESOURCE_MISSING', 'Role resource is absent from its exact Pack revision');
        resources.push({ ...resource, object_path: join(this.store.root, `wf-${pack.workflow.id}.pack`, 'objects', resource.sha256) }); }
    }
    const id = `role-${randomUUID()}`, schema = args.outputs_schema ?? { type: 'object', properties: { result: { type: 'string' } }, required: ['result'], additionalProperties: false };
    const directory = join(this.directory, 'role-runs'); await mkdir(directory, { recursive: true });
    const journalPath = join(directory, `${id}.json`), journal = { id, role_id: role.id, revision_hash: role.revision_hash,
      prompt_sha256: digest(role.instructions), binding: role.binding, permissions, human_approval: role.requires_user_approval ? human : null,
      status: 'launching', created_at: new Date().toISOString() };
    await writeDurableJSON(journalPath, journal);
    let task;
    try { task = await this.host.createTask({ run_id: id, node_id: role.id, name: role.name,
      kind: 'subagent', binding: role.binding, workspace: permissions.workspace, access: role.access,
      ...(coordinator?.active && coordinator.request.main_mode === 'orchestration' ? {
        signal:coordinator.request.signal,
        authorize:async()=>{
          requireValue(!coordinator.cancelled && !coordinator.closed && !coordinator.finished, 'PI_TASK_ABORTED', 'The coordinating Main task no longer owns this helper');
          await coordinator.request.authorize?.();
        },
      } : {}),
      allowed_paths: permissions.allowed_paths, schema, resources, strict: role.skill_policy?.mode === 'strict',
      ...(requiredMcpServers ? { required_mcp_servers: requiredMcpServers } : {}),
      runtime_environment: args.executables?.length ? await discoverRuntimeEnvironment({ executables: args.executables }, { registryPath: join(this.directory, 'host-runtime-registry.json') }) : null,
      onOperation: metadata => appendFile(join(directory, `${id}.operations.jsonl`), canonicalJSON({ role_run_id: id, at: new Date().toISOString(), ...metadata }) + '\n') }); }
    catch (error) { await writeDurableJSON(journalPath, { ...journal, status: 'failed', error: diagnostic(error) }); throw error; }
    const sessionReceipt={session_id:task.session_id,session_file:task.session_file,...(task.session_storage?{session_storage:task.session_storage}:{})};
    await writeDurableJSON(journalPath, { ...journal, status: 'running', ...sessionReceipt });
    const completion = (async () => {
      let result, error, closed = false;
      try { result = await task.run({ prompt: role.instructions, schema, ...(coordinator?.active && coordinator.request.main_mode === 'orchestration' ? {signal:coordinator.request.signal} : {}) }); } catch (cause) { error = cause; }
      try { await this.host.releaseTask(task); closed = true; }
      catch (cause) { error = error ? new AggregateError([error, cause], 'Role execution and cleanup failed') : cause; }
      const status = error ? 'failed' : 'completed';
      await writeDurableJSON(journalPath, { ...journal, status, ...sessionReceipt,
        closed, finished_at: new Date().toISOString(), ...(error ? { error: diagnostic(error) } : { result }) });
      await this.notify({ role_run_id: id, role_id: role.id, session_id: task.session_id, status,
        ...(error ? { error: diagnostic(error) } : { result: result.result }) });
      if(!error)await this.roleRetention.sweep();
      if (closed) this.roleTasks.delete(task.session_id);
      if (error) throw error;
      return result;
    })();
    this.roleTasks.set(task.session_id, completion);
    if (coordinator?.active && coordinator.request.main_mode === 'orchestration') {
      (coordinator.helperCompletions ??= []).push(completion);
    }
    completion.catch(error => {
      this.lastRoleError = { role_run_id:id, session_id:task.session_id, ...diagnostic(error) };
      console.error('[pi-CAW] Role completion failed',this.lastRoleError);
    });
    return { role_run_id: id, role_id: role.id, revision_hash: role.revision_hash, session_id: task.session_id, session_file: task.session_file, status: 'running', background: true };
  }
  async close() {
    clearInterval(this.maintenanceTimer);clearInterval(this.progressTimer);
    if(this.retention.pending)await this.retention.pending;
    const bridges = await Promise.allSettled([...this.parentBridges.values()].map(bridge => bridge.close()));
    this.parentBridges.clear();
    for (const owner of this.active.values()) owner.controller.abort();
    await this.host.close();
    await Promise.all([...this.active.values()].map(owner => owner.completion));
    await Promise.allSettled(this.roleTasks.values());
    if(this.roleRetention.pending)await this.roleRetention.pending;
    const failures = bridges.filter(result => result.status === 'rejected').map(result => result.reason);
    if (failures.length) throw new AggregateError(failures, 'Parent Main bridge shutdown is unconfirmed');
  }
}
