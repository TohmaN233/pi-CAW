import { join, resolve, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { requireValue } from '../core/workflow-paths.mjs';
import { canonicalJSON, digest } from '../core/workflow-revisions.mjs';
import { validateData } from '../core/workflow-data-schema.mjs';
import { acceptSemanticResult } from '../core/result-staging.mjs';
import { availableModels, modelFingerprint, resolveBinding } from './models.mjs';
import { scopedMutationTool, observedChanges } from './scope.mjs';
import { CurrentChatMain } from './current-chat-main.mjs';
import { readPinnedResource } from './resources.mjs';
import { scopedTaskBroker } from './task-broker.mjs';
import { probeRuntimeCandidate } from '../core/runtime-environment.mjs';
import { usageFromEntries } from './usage.mjs';
import { normalizeExecutableRequirements, runtimeRequirementKey } from '../core/runtime-requirements.mjs';
import { loadNativeMcpCatalog, childMcpFactories } from './native-mcp.mjs';
import { externalHostToolDescriptors } from './external-host-tools.mjs';
import { mainContextForMode } from '../core/main-execution-mode.mjs';

/** A trusted Extension-bus hook; none of its callbacks become model actions or worker bootstrap state. */
export async function requestPiExecutionAdmission(emit, selection, onRequired = () => {}) {
  const request = structuredClone(selection);
  emit('pi-caw:execution-admission', request);
  const required = selection.required === true || request.required === true;
  if (required) onRequired(selection.session_id);
  if (request.error) throw request.error;
  if (request.authorize !== undefined) {
    const admission = await request.authorize;
    if (request.error) throw request.error;
    return admission;
  }
  requireValue(request.authorized !== false, 'PI_EXECUTION_ADMISSION_DENIED', 'Private Host execution admission denied this execution');
  requireValue(!required || request.authorized === true, 'PI_EXECUTION_ADMISSION_REQUIRED', 'This session requires an available private execution admission adapter');
  return { authorized:true, session_id:selection.session_id, operation:selection.operation };
}

// The Pi SDK is injected by the extension's host-resolved peer imports. This
// keeps the graph engine portable and never resolves a second SDK installation.
export class PiSdkHost {
  constructor({ sdk, Type, supportedThinking, agentDir, getContext, getCommands = () => [], getMcpServers = () => [], getAllTools = () => [], getHostTools = () => ({}), workflowScope, setWorkflowEnabled, authorizeExecution, executionAdmissionRequired = () => false, detachedNativeProviderModules = [], sessionDirectory, deliverMain, emit = () => {} }) {
    this.sdk = sdk; this.Type = Type; this.supportedThinking = supportedThinking;
    this.agentDir = agentDir; this.getContext = getContext; this.emit = emit;
    this.getCommands = getCommands;
    this.getMcpServers = getMcpServers; this.getAllTools = getAllTools;
    this.getHostTools = getHostTools;
    this.authorizeExecution = authorizeExecution;
    this.executionAdmissionRequired = executionAdmissionRequired;
    this.workflowScope = workflowScope; this.setWorkflowEnabled = setWorkflowEnabled;
    this.detachedNativeProviderModules = detachedNativeProviderModules;
    this.sessionDirectory = sessionDirectory ?? join(agentDir,'sessions');
    this.main = new CurrentChatMain({ getContext, deliver: deliverMain });
    this.tasks = new Map(); this.modelRuntimes = new Map();
    this.capabilities = { native_sessions: true, exact_turns: true, scoped_file_writes: true,
      strict_resources: true, isolated_main: true, persistent_threads: true, cancellable: true,
      native_mcp: true, declared_wsl_execution: true,
      process_sandbox: false, detached_owner: true, parallel_worktrees: false, host_tools: [] };
  }
  catalog() { return availableModels(this.getContext(), this.supportedThinking); }
  runtimeMetadata() { return { sdk_version: this.sdk.VERSION ?? null, source: 'active-pi-sdk' }; }
  detachedBootstrap(providerIds) {
    const ctx = this.getContext(), registry = ctx.modelRegistry;
    const provider_configs = [];
    for (const provider of providerIds) {
      const config = registry.getRegisteredProviderConfig?.(provider);
      requireValue(!registry.getRegisteredNativeProvider?.(provider) || this.detachedNativeProviderModules.length,
        'PI_DETACHED_NATIVE_PROVIDER', 'A function-based Pi provider needs its Host-owned module in the detached runtime; select in-process execution or configure that module');
      if (config) provider_configs.push({ provider, config });
    }
    const boot = { sdkPackageDir: this.sdk.getPackageDir(), agentDir: this.agentDir, cwd: ctx.cwd,
      main_identity: this.mainIdentity(), catalog: this.catalog().filter(model => providerIds.includes(model.provider)),
      provider_configs, registered_mcp_servers: this.getMcpServers(), project_trusted: ctx.isProjectTrusted?.() === true,
      native_provider_modules: this.detachedNativeProviderModules, external_host_tools: externalHostToolDescriptors(this.getHostTools()) };
    // Functions cannot cross an owner process. Reject rather than quietly
    // dropping credentials/callbacks or replacing the bound provider.
    return JSON.parse(JSON.stringify(boot, (_key, value) => {
      requireValue(typeof value !== 'function' && typeof value !== 'bigint' && typeof value !== 'symbol',
        'PI_DETACHED_BOOT_CONTRACT', 'This Pi provider configuration cannot be transferred to an independent owner');
      return value;
    }));
  }
  async mcpCatalog() {
    const ctx = this.getContext();
    return loadNativeMcpCatalog({ sdk: this.sdk, agentDir: this.agentDir, cwd: ctx.cwd,
      projectTrusted: ctx.isProjectTrusted?.() === true, registeredServers: this.getMcpServers() });
  }
  async discoverSkills(workspace = this.getContext().cwd) {
    requireValue(resolve(workspace) === resolve(this.getContext().cwd), 'PI_SKILL_DISCOVERY_WORKSPACE', 'Host inventory describes this active Pi workspace; choose folder discovery for another directory');
    const seen = new Set(), skills = [];
    for (const command of this.getCommands().filter(item => item.source === 'skill')) {
      const path = command.sourceInfo?.path;
      requireValue(typeof path === 'string' && isAbsolute(path), 'PI_SKILL_SOURCE', 'Pi reported a Skill without a real source file');
      const key = process.platform === 'win32' ? path.toLowerCase() : path;
      if (!seen.has(key)) { seen.add(key); skills.push({ path, scope: command.sourceInfo.scope, enabled: true }); }
    }
    return { skills, errors: [], discovered_by: 'active-pi-skill-command-catalog', profile_scope: workspace, model_invocations: 0 };
  }
  mainIdentity() { return this.main.identity(); }
  async executionRequest(request) {
    if (request.strict || request.execution_binding) return request;
    const settings = this.sdk.SettingsManager.create(request.workspace, this.agentDir);
    const shell = this.sdk.getShellConfig(settings.getShellPath());
    const existing = request.runtime_environment?.tools ?? [];
    const programs = [{ name: 'node', path: process.execPath }, { name: 'shell', path: shell.shell }]
      .filter(program => !existing.some(item => item.name === program.name));
    const requirements = normalizeExecutableRequirements(programs.map(item => item.name));
    const tools = await Promise.all(programs.map(async program => {
      const requirement = requirements.find(item => item.name === program.name), evidence = await probeRuntimeCandidate(requirement, program.path);
      return { name: program.name, path: evidence.realpath, status: 'found', requirement_key: runtimeRequirementKey(requirement), evidence };
    }));
    return { ...request, prepareRuntimeEnvironment: undefined,
      runtime_environment: { status: 'ready', requirements: { executables: [...(request.runtime_environment?.requirements?.executables ?? []), ...requirements] }, tools: [...existing, ...tools] },
      shell: { program: 'shell', args: shell.args, command_transport: shell.commandTransport ?? 'argv' } };
  }
  async createMainTask(request) {
    const mode = request.main_mode !== undefined ? mainContextForMode(request.main_mode) : request.context_mode ?? 'isolated';
    requireValue(!request.context_mode || request.context_mode === mode, 'MAIN_EXECUTION_MODE', 'Main context conflicts with its node mode');
    if (mode === 'isolated') {
      requireValue(request.binding == null && !request.session_file && !request.session_id,
        'PI_MAIN_MODEL_OWNER', 'Logical Main inherits the calling chat model; it cannot supply a Provider binding or another session');
      const identity = this.mainIdentity(), ctx = this.getContext();
      requireValue(ctx.model, 'PI_MAIN_MODEL_REQUIRED', 'The calling Pi conversation has no selected model');
      const binding = resolveBinding({provider:ctx.model.provider,model_id:ctx.model.id,thinking:ctx.thinkingLevel},this.catalog());
      const task = await this.createTask({...request,kind:'isolated_main',binding});
      if (this.mainIdentity().session_id !== identity.session_id) {
        await this.releaseTask(task);
        requireValue(false,'PI_MAIN_SESSION_CHANGED','The calling chat changed while creating isolated Main');
      }
      return Object.assign(task,{main_actor:identity.session_id,context_mode:'isolated',observed_model:binding});
    }
    requireValue(mode === 'current' && !request.strict,'PI_MAIN_CONTEXT','Strict Main must use an isolated Pi context');
    const catalog = await this.mcpCatalog();
    const required = new Set(request.required_mcp_servers ?? []);
    const servers = catalog.servers.filter(server => server.enabled
      && (server.exposure !== 'hidden' || Object.values(server.tool_exposure).some(value => value !== 'hidden'))
      && (required.size === 0 ? !request.strict : required.has(server.name)));
    requireValue([...required].every(name => servers.some(server => server.name === name)), 'PI_MCP_SERVER_UNAVAILABLE', 'A required native Pi MCP server is unavailable');
    const namespaces = new Set(servers.map(server => server.namespace));
    const nativeTools = this.getAllTools().filter(tool => namespaces.has(tool.namespace?.name)).map(tool => tool.name);
    return this.main.createTask({ ...await this.executionRequest(request), native_tools: this.getAllTools().map(tool => tool.name), audit_excluded_roots: [this.agentDir, ...(request.audit_excluded_roots ?? [])], native_mcp_servers: servers.map(server => server.name), native_mcp_namespaces: [...namespaces], native_mcp_tools: nativeTools });
  }
  async runtimeFor(binding) {
    const registry = this.getContext().modelRegistry;
    let runtime = this.modelRuntimes.get(binding.provider);
    if (!runtime) {
      runtime = await this.sdk.ModelRuntime.create({ authPath: join(this.agentDir, 'auth.json'), modelsPath: join(this.agentDir, 'models.json') });
      const native = registry.getRegisteredNativeProvider?.(binding.provider);
      const config = registry.getRegisteredProviderConfig?.(binding.provider);
      if (native) runtime.registerNativeProvider(native);
      else if (config) runtime.registerProvider(binding.provider, config);
      this.modelRuntimes.set(binding.provider, runtime);
    }
    const model = runtime.getModel(binding.provider, binding.model_id);
    requireValue(model && modelFingerprint(model) === binding.fingerprint, 'PI_MODEL_RUNTIME_MISMATCH', 'Child runtime does not match the active Pi model binding');
    return { runtime, model };
  }
  async createTask(request) {
    requireValue(request.kind !== 'main', 'PI_MAIN_CURRENT_CHAT', 'Main must execute in the current Pi chat, never a child SDK session');
    const binding = resolveBinding(request.binding, this.catalog());
    const { runtime, model } = await this.runtimeFor(binding);
    request = await this.executionRequest(request);
    const { SessionManager, DefaultResourceLoader, createAgentSession } = this.sdk;
    let manager;
    if (request.session_file) {
      manager = SessionManager.open(request.session_file, undefined, request.workspace);
      requireValue(manager.getSessionId() === request.session_id, 'PI_THREAD_IDENTITY', 'Persistent session file has a different identity');
      const metadata = manager.getEntries().find(entry => entry.type === 'custom' && entry.customType === 'pi-caw:task')?.data;
      requireValue(metadata && metadata.run_id === request.run_id && canonicalJSON(metadata.binding) === canonicalJSON(binding),
        'PI_THREAD_BINDING', 'Persistent session belongs to another Run or model binding');
    } else {
      manager = SessionManager.create(request.workspace, this.sessionDirectory, { parentSession: request.parent_session_file ?? this.getContext().sessionManager.getSessionFile() });
      manager.appendCustomEntry('pi-caw:task', { schema_version: 1, run_id: request.run_id, node_id: request.node_id,
        kind: request.kind, binding, parent_session_id: this.getContext().sessionManager.getSessionId() });
      manager.appendSessionInfo(`pi-CAW ${request.kind}: ${request.name}`);
    }
    const sessionId = manager.getSessionId();
    requireValue(!this.tasks.has(sessionId), 'PI_SESSION_BUSY', 'The exact Pi session already has a task owner');
    const state = { submission: null, staged: null, schema: request.schema, mutations: new Map(), request, running: false, completion: null, closed: false };
    const submit = {
      name: 'caw_submit_result', label: 'Submit Workflow result',
      description: 'Submit semantic result values once. If validation fails, the body stays staged and is not official. Correct it with stage_id and patch only; do not resend the body. A patch that validates is promoted. The host owns protocol IDs, paths, receipts and completion evidence.',
      parameters: this.Type.Object({
        summary: this.Type.String({ minLength: 1, maxLength: 4000 }),
        result: this.Type.Optional(this.Type.Unknown()),
        stage_id: this.Type.Optional(this.Type.String({ minLength: 1, maxLength: 80 })),
        patch: this.Type.Optional(this.Type.Array(this.Type.Object({
          op: this.Type.String({ minLength: 1, maxLength: 16 }),
          key: this.Type.Optional(this.Type.String({ minLength: 1, maxLength: 128 })),
          path: this.Type.Optional(this.Type.String({ minLength: 1, maxLength: 256 })),
          value: this.Type.Optional(this.Type.Unknown()),
        }))),
      }),
      async execute(_id, params) {
        const accepted = await acceptSemanticResult(state, params, async result => {
          validateData(result, state.schema);
          await state.request.validateResult?.(result);
        }, state.schema);
        const text = accepted.promoted
          ? 'Host inserted the required result wrapper and recorded the staged body. End this turn.'
          : 'Semantic result recorded for Host verification. End this turn.';
        return { content: [{ type: 'text', text }], details: { promoted: accepted.promoted, stage_id: accepted.stage_id } };
      },
    };
    const resource = {
      name: 'caw_read_resource', label: 'Read pinned resource', description: 'Read one declared immutable resource from this task packet.',
      parameters: this.Type.Object({ path: this.Type.String(), start_line: this.Type.Optional(this.Type.Integer()), end_line: this.Type.Optional(this.Type.Integer()) }),
      async execute(_id, params) {
        const result = await readPinnedResource(request.resources ?? [], params);
        return { content: [{ type: 'text', text: result.content }], details: result };
      },
    };
    // Strict nodes read through the source broker only. Native SDK search/read
    // accepts arbitrary absolute paths and cannot enforce immutable Skill pins.
    const tools = [submit, resource, ...(!request.strict ? [this.sdk.createReadToolDefinition(request.workspace), this.sdk.createGrepToolDefinition(request.workspace),
      this.sdk.createFindToolDefinition(request.workspace), this.sdk.createLsToolDefinition(request.workspace)] : [])];
    const broker = await scopedTaskBroker(request, state.mutations,
      async () => { requireValue(!state.closed && !request.signal?.aborted, 'PI_TASK_ABORTED', 'Task authority was revoked'); await request.authorize?.(); });
    tools.push(...broker.tools().map(descriptor => ({ name: descriptor.name, label: descriptor.name, description: descriptor.description,
      parameters: this.Type.Unsafe(descriptor.inputSchema), executionMode: 'sequential',
      execute: (id, params) => broker.execute(descriptor.name, params, id),
    })));
    if (request.access === 'bounded_write' && !request.strict) tools.push(...[
      this.sdk.createWriteToolDefinition(request.workspace), this.sdk.createEditToolDefinition(request.workspace),
    ].map(tool => scopedMutationTool(tool, request, state.mutations)));
    const requiredServers = request.required_mcp_servers ?? [];
    const mcpFactories = childMcpFactories({ sdk: this.sdk, catalog: await this.mcpCatalog(),
      requiredServers, includeAll: !request.strict && requiredServers.length === 0 });
    const authorityGuard = { name: 'pi-caw-task-authority', factory: pi => {
      pi.on('tool_call', async () => {
        try {
          requireValue(!state.closed && !request.signal?.aborted, 'PI_TASK_ABORTED', 'Task authority was revoked');
          await request.authorize?.();
        } catch (error) { return { block: true, reason: `${error.code ?? 'PI_TASK_AUTHORITY'}: ${error.message}` }; }
      });
    } };
    const loader = new DefaultResourceLoader({ cwd: request.workspace, agentDir: this.agentDir,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: request.strict || request.kind === 'isolated_main',
      extensionFactories: [authorityGuard, ...mcpFactories],
      systemPrompt: 'Execute one pi-CAW task using its declared inputs and pinned resources. Follow the task access grant. Submit semantic values once with caw_submit_result. If that call stages the body, correct it with stage_id and patch only; do not output the body again. Never invent Host evidence or identities.' });
    let created;
    try {
    await loader.reload();
    created = await createAgentSession({ cwd: request.workspace, agentDir: this.agentDir, modelRuntime: runtime,
      model, thinkingLevel: binding.thinking, sessionManager: manager, resourceLoader: loader,
      noTools: mcpFactories.length ? 'builtin' : 'all', ...(mcpFactories.length ? {} : { tools: tools.map(tool => tool.name) }), customTools: tools });
    if (mcpFactories.length) {
      created.session.setActiveToolsByName(tools.map(tool => tool.name));
    }
    let startupError;
    await created.session.bindExtensions({ mode: 'rpc', onError: error => { startupError = error; } });
    await Promise.all(mcpFactories.filter(factory => factory.ready).map(factory => factory.ready));
    requireValue(!startupError, 'PI_TASK_EXTENSION_STARTUP', startupError?.message ?? 'Task extensions failed to initialize');
    if (created.modelFallbackMessage || created.session.model?.provider !== model.provider
      || created.session.model?.id !== model.id || created.session.thinkingLevel !== binding.thinking) {
      requireValue(false, 'PI_MODEL_SUBSTITUTION', 'Pi substituted the requested model or thinking level');
    }
    } catch (error) {
      // Retain startup ownership before cleanup. A partial startup can own an
      // MCP process even though no task was returned to the graph driver.
      const startupOwner = { session_id: sessionId, session_file: manager.getSessionFile(),
        abort: async () => { broker.revoke(); await created?.session.abort(); },
        close: async () => {
          state.closed = true; broker.revoke();
          const cleanup = await Promise.allSettled([broker.close(), ...mcpFactories.filter(factory => factory.close).map(factory => factory.close()),
            ...(created ? [created.session.abort()] : [])]);
          const failures = cleanup.filter(result => result.status === 'rejected').map(result => result.reason);
          if (failures.length) throw Object.assign(new AggregateError([error, ...failures], 'Pi startup and cleanup failed'),
            { quiescent: false, cleanup_owner: { session_id: sessionId, run_id: request.run_id } });
          created?.session.dispose();
        } };
      this.tasks.set(sessionId, startupOwner);
      await this.releaseTask(startupOwner);
      throw error;
    }
    const session = created.session;
    const task = {
      session_id: sessionId, session_file: manager.getSessionFile(), binding,
      async run({ prompt, schema, signal }) {
        requireValue(!state.running && !state.closed, 'PI_SESSION_BUSY', 'Pi task is already running or closed');
        requireValue(!signal?.aborted, 'PI_TASK_ABORTED', 'Pi task was cancelled before dispatch');
        state.running = true; state.submission = null; state.staged = null; state.schema = schema;
        const dispatchId = randomUUID();
        const marker = `PI_CAW_DISPATCH ${dispatchId}`;
        const beforeIds = new Set(manager.getEntries().map(entry => entry.id));
        const abort = () => {
          broker.revoke();
          state.abortCompletion = session.abort();
          // Observe immediately; the dispatch's finally awaits and reports it.
          state.abortCompletion.catch(error => { state.abortError = error; });
        };
        signal?.addEventListener('abort', abort, { once: true });
        // Native streams are observable before Pi persists its first assistant
        // message. Keep only phase/tool metadata, never token deltas or prompts.
        let progress=Promise.resolve(), progressError;
        const observe=metadata=>{
          progress=progress.then(()=>request.onOperation?.({...metadata,execution_session_id:sessionId}));
          progress.catch(error=>{progressError=error;});
        };
        const unsubscribe=session.subscribe(event=>{
          if(event.type==='message_start' && event.message.role==='assistant')observe({tool:'model',phase:'message_started'});
          else if(event.type==='message_end' && event.message.role==='assistant')observe({tool:'model',phase:'message_completed'});
          else if(event.type==='message_update' && ['thinking_start','text_start'].includes(event.assistantMessageEvent?.type))
            observe({tool:'model',phase:event.assistantMessageEvent.type==='thinking_start'?'thinking':'responding'});
          else if(event.type==='tool_execution_start')observe({tool:event.toolName,phase:'started'});
          else if(event.type==='tool_execution_end')observe({tool:event.toolName,phase:event.isError?'failed':'completed'});
        });
        try {
          observe({tool:'model',phase:'dispatch_started'});await progress;
          state.completion = session.prompt(`${marker}\n${prompt}\n\nRequired semantic result schema:\n${JSON.stringify(schema)}\nSubmit the result once using caw_submit_result, then finish this turn. If that call stages the body, correct it with stage_id and patch only. Do not output the body again.`);
          await state.completion;
          await progress;if(progressError)throw progressError;
          requireValue(!signal?.aborted, 'PI_TASK_ABORTED', 'Pi task was cancelled');
          const newEntries = manager.getEntries().filter(entry => !beforeIds.has(entry.id));
          const user = newEntries.find(entry => entry.type === 'message' && entry.message.role === 'user');
          const assistant = newEntries.filter(entry => entry.type === 'message' && entry.message.role === 'assistant').at(-1);
          requireValue(user && assistant && assistant.message.stopReason === 'stop', 'PI_TURN_INCOMPLETE', 'No exact successful completed assistant turn was observed');
          const text = typeof user.message.content === 'string' ? user.message.content : user.message.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
          requireValue(text.startsWith(marker), 'PI_TURN_CORRELATION', 'Completed turn does not match the Host dispatch marker');
          requireValue(state.submission, 'PI_RESULT_MISSING', 'Completed Pi turn did not submit a semantic result');
          broker.assertScope();
          return { ...state.submission, session_id: sessionId, session_file: manager.getSessionFile(), turn_id: assistant.id,
            user_entry_id: user.id, dispatch_id: dispatchId, result_sha256: digest(canonicalJSON(state.submission.result)),
            usage: usageFromEntries(newEntries),
            changed_paths: await observedChanges(state.mutations), evidence: { kind: 'pi_session', thread_id: sessionId,
              turn_id: assistant.id, user_entry_id: user.id, observed: 'completed', dispatch_id: dispatchId } };
        } finally {
          unsubscribe();
          signal?.removeEventListener('abort', abort); state.running = false;
          if (state.abortCompletion) await state.abortCompletion;
          await progress;
        }
      },
      abort: async () => { broker.revoke(); await session.abort(); },
      close: async () => {
        broker.revoke(); await session.abort();
        // The caller of run() receives prompt failure; disposal waits for it.
        if (state.completion) await Promise.allSettled([state.completion]);
        await broker.close();
        await Promise.all(mcpFactories.filter(factory => factory.close).map(factory => factory.close()));
        session.dispose(); state.closed = true;
      },
    };
    this.tasks.set(sessionId, task);
    this.emit('pi-caw:session-created', { session_id: sessionId, session_file: manager.getSessionFile(), kind: request.kind,
      parent_session_id: this.getContext().sessionManager.getSessionId(), run_id: request.run_id });
    return task;
  }
  async releaseTask(task) { await task.close(); this.tasks.delete(task.session_id); }
  async close() {
    const results = await Promise.allSettled([...this.tasks.values()].map(task => this.releaseTask(task)));
    const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (failures.length) throw new AggregateError(failures, 'Pi task shutdown is unconfirmed');
    this.modelRuntimes.clear();
  }
}
