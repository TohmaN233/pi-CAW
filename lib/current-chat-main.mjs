import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { requireValue } from '../core/workflow-paths.mjs';
import { validateData } from '../core/workflow-data-schema.mjs';
import { acceptSemanticResult } from '../core/result-staging.mjs';
import { canonicalJSON, digest } from '../core/workflow-revisions.mjs';
import { writablePath, observeMutation, observedChanges } from './scope.mjs';
import { readPinnedResource } from './resources.mjs';
import { scopedTaskBroker } from './task-broker.mjs';
import { usageFromEntries } from './usage.mjs';
import { snapshotOrchestration, orchestrationChanges } from './orchestration-audit.mjs';

// Orchestration Main is the existing Pi conversation. This bridge never constructs an SDK
// session, chooses a model, or calls a provider. Pi continues its own agent loop.
export class CurrentChatMain {
  constructor({ getContext, deliver }) { this.getContext = getContext; this.deliver = deliver; this.pending = null; this.cancelledMarkers = new Map(); this.blockCancelledActor = null; }
  identity() {
    const manager = this.getContext().sessionManager;
    requireValue(manager?.getSessionId(), 'PI_MAIN_SESSION_REQUIRED', 'Main requires the current Pi chat session');
    const file = manager.getSessionFile();
    return { session_id: manager.getSessionId(), ...(file ? { session_file: file } : {}) };
  }
  sessionChanged() {
    if (this.blockCancelledActor !== this.identity().session_id) { this.blockCancelled = false; this.blockCancelledActor = null; }
    const state = this.pending;
    if (!state || this.identity().session_id === state.identity.session_id) return;
    state.finished = true;
    if (state.reject) state.reject(Object.assign(new Error('Main belongs to the previous Pi chat'), { code: 'PI_MAIN_SESSION_CHANGED' }));
  }
  createTask(request) {
    requireValue(!request.signal?.aborted, 'PI_TASK_ABORTED', 'Main was cancelled before acquiring the current chat');
    if (this.pending) {
      const wait = new Promise((resolveWait, reject) => {
        const abort = () => reject(Object.assign(new Error('Main was cancelled while waiting for the current chat'), { code: 'PI_TASK_ABORTED' }));
        request.signal?.addEventListener('abort', abort, { once: true });
        this.pending.released.then(() => { request.signal?.removeEventListener('abort', abort); resolveWait(); });
      });
      return wait.then(() => this.createTask(request));
    }
    const identity = this.identity();
    requireValue(resolve(request.workspace) === resolve(this.getContext().cwd), 'PI_MAIN_WORKSPACE', 'Main must execute in the current Pi chat workspace');
    const state = { request, identity, dispatch_id: randomUUID(), active: false, mutations: new Map(), submission: null, closed: false };
    state.released = new Promise(resolveRelease => { state.release = resolveRelease; });
    this.pending = state;
    const assertSession = () => requireValue(this.identity().session_id === identity.session_id, 'PI_MAIN_SESSION_CHANGED', 'Main cannot move to another Pi chat');
    const task = { ...identity,
      run: ({ prompt, schema, signal }) => {
        assertSession(); requireValue(!state.completion && !state.closed && !signal?.aborted, 'PI_MAIN_DISPATCH', 'Main dispatch is closed, cancelled or already running');
        this.pending = state; state.schema = schema; state.before = new Set(this.getContext().sessionManager.getEntries().map(entry => entry.id));
        state.completion = new Promise((resolveResult, reject) => { state.resolve = resolveResult; state.reject = reject; });
        const abort = () => {
          state.cancelled = true;
          state.broker?.revoke();
          if (this.identity().session_id !== state.identity.session_id) {
            state.finished = true;
            state.reject(Object.assign(new Error('The original Main chat changed; the new chat was not aborted'), { code: 'PI_MAIN_SESSION_CHANGED' }));
          } else if (state.active) this.getContext().abort();
          else { this.cancelledMarkers.set(state.dispatch_id, state.identity.session_id); state.reject(Object.assign(new Error('Main was cancelled before its queued turn'), { code: 'PI_TASK_ABORTED' })); }
        };
        state.cancel = abort;
        signal?.addEventListener('abort', abort, { once: true });
        state.completion = state.completion.finally(() => { signal?.removeEventListener('abort', abort); if (this.pending === state) this.pending = null; });
        void Promise.resolve().then(async () => {
          if (request.main_mode === 'orchestration') state.workspaceBefore = await snapshotOrchestration(request.workspace, request.audit_excluded_roots);
          requireValue(!state.cancelled && !state.closed, 'PI_TASK_ABORTED', 'Main cancelled before its queued turn');
          await request.authorize?.();
          this.deliver(`PI_CAW_MAIN ${state.dispatch_id}\nExecute the Main node in this current Pi chat. Retrieve its packet with caw action main_task; submit semantic values once with main_result and finish the turn. If that call stages the body, correct it with stage_id and patch only. Do not output the body again.\n${prompt}\nRequired semantic result schema:\n${JSON.stringify(schema)}`);
        }).catch(error => state.reject(error));
        return state.completion;
      },
      abort: async () => { if (state.cancel && !state.finished) state.cancel(); },
      close: async () => {
        state.closed = true; await task.abort();
        // run() reports its error to the driver; shutdown observes settlement.
        if (state.completion) await Promise.allSettled([state.completion]);
        if (state.broker) await state.broker.close();
        if (this.pending === state) this.pending = null;
        state.release();
      },
    };
    return task;
  }
  ownsPrompt(prompt, actor = this.identity().session_id) {
    if (actor !== this.identity().session_id) return false;
    if (this.blockCancelled && this.blockCancelledActor === actor) return true;
    if (typeof prompt === 'string' && [...this.cancelledMarkers].some(([id, owner]) => owner === actor && prompt.startsWith(`PI_CAW_MAIN ${id}\n`))) return true;
    const state = this.pending;
    return !!(state && state.completion && !state.closed && !state.finished && !state.cancelled && state.identity.session_id === actor
      && (state.active || typeof prompt === 'string' && prompt.startsWith(`PI_CAW_MAIN ${state.dispatch_id}\n`)));
  }
  begin(prompt) {
    const actor = this.identity().session_id;
    const cancelled = [...this.cancelledMarkers].find(([id, owner]) => owner === actor && prompt.startsWith(`PI_CAW_MAIN ${id}\n`))?.[0];
    if (cancelled) { this.cancelledMarkers.delete(cancelled); this.blockCancelled = true; this.blockCancelledActor = actor; return 'This queued pi-CAW Main dispatch was cancelled. Do not execute tools or perform work. End the turn.'; }
    const state = this.pending;
    if (!state || !prompt.startsWith(`PI_CAW_MAIN ${state.dispatch_id}\n`)) return;
    requireValue(this.identity().session_id === state.identity.session_id, 'PI_MAIN_SESSION_CHANGED', 'Main chat changed before dispatch');
    state.active = true;
    const ctx = this.getContext();
    state.observed_model = ctx.model ? { provider: ctx.model.provider, model_id: ctx.model.id, thinking: ctx.thinkingLevel } : null;
  }
  current() {
    const state = this.pending;
    requireValue(state?.active && this.identity().session_id === state.identity.session_id, 'PI_MAIN_NOT_ACTIVE', 'No Main dispatch is active in this Pi chat');
    return state;
  }
  packet() {
    const state = this.current();
    return { run_id: state.request.run_id, node_id: state.request.node_id, main_mode: state.request.main_mode ?? 'legacy_current', outputs_schema: state.schema,
      access: state.request.access, allowed_paths: state.request.allowed_paths, resources: state.request.resources.map(item => ({ path: item.path, sha256: item.sha256 })),
      tools: ['list_workspace', 'read_workspace', ...(state.request.access === 'bounded_write' ? ['write_workspace', 'mkdir_workspace', 'materialize_workflow_resource'] : []),
        ...(state.request.resources.length ? ['read_workflow_resource', 'read_workflow_resource_range', 'read_workflow_resource_chunk'] : []),
        ...(state.request.runtime_environment?.tools?.length ? ['run_task_program'] : [])],
      native_mcp_servers: state.request.native_mcp_servers ?? [], native_mcp_tools: state.request.native_mcp_tools ?? [],
      runtime_environment: state.request.runtime_environment ?? null, shell: state.request.shell ?? null };
  }
  async submit(params, toolCallId) {
    const state = this.current();
    const accepted = await acceptSemanticResult(state, params, async result => {
      validateData(result, state.schema);
      await state.request.validateResult?.(result);
      requireValue(this.current() === state, 'PI_TASK_ABORTED', 'Main task changed during semantic result validation');
    }, state.schema);
    state.submission_call = toolCallId;
    return { recorded: true, promoted: accepted.promoted, stage_id: accepted.stage_id,
      message: accepted.promoted
        ? 'Staged correction validated and promoted. Finish the current turn. The Host will verify its actual Pi entries.'
        : 'Finish the current turn. The Host will verify its actual Pi entries.' };
  }
  async readResource(params) { return readPinnedResource(this.current().request.resources, params); }
  async tool(params, callId) {
    const state = this.current();
    state.brokerPromise ??= scopedTaskBroker(state.request, state.mutations,
      async () => { this.current(); requireValue(!state.cancelled && !state.closed, 'PI_TASK_ABORTED', 'Main task authority was revoked'); await state.request.authorize?.(); });
    state.broker ??= await state.brokerPromise;
    requireValue(state.broker.tools().some(tool => tool.name === params.name), 'PI_MAIN_TOOL_SCOPE', 'Tool is not declared in this Main packet');
    return state.broker.execute(params.name, params.args ?? {}, callId);
  }
  async guard(event) {
    if (this.blockCancelled && this.blockCancelledActor === this.identity().session_id) return { block: true, terminate: true, reason: 'This queued Main dispatch was cancelled' };
    const state = this.pending; if (!state?.active) return;
    try {
      this.current();
      await state.request.authorize?.();
      if (event.toolName === 'caw') {
        requireValue([...['main_task', 'main_resource', 'main_tool', 'main_result', 'run_snapshot', 'pause', 'cancel'], ...(state.request.main_mode === 'orchestration' ? ['capabilities', 'models', 'roles', 'list', 'get_workflow', 'route', 'role_templates', 'role_template', 'launch_role'] : [])].includes(event.input.action), 'PI_MAIN_TOOL_SCOPE', 'This caw action is outside the active Main packet');
        if (['run_snapshot', 'pause', 'cancel'].includes(event.input.action)) requireValue(event.input.args?.run_id === state.request.run_id,
          'PI_MAIN_RUN_SCOPE', 'Main controller actions belong only to the exact active packet Run');
      }
      else if (['write', 'edit'].includes(event.toolName)) {
        const target = await writablePath(state.request.workspace, event.input.path, state.request.access, state.request.allowed_paths);
        await observeMutation(target, state.mutations); event.input.path = target.absolute;
      } else if (['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'].includes(event.toolName)) {
        const server = event.input.server;
        requireValue(server ? state.request.native_mcp_servers?.includes(server)
          : event.toolName !== 'read_mcp_resource' && state.request.native_mcp_servers?.length && !state.request.required_mcp_servers?.length,
          'PI_MAIN_MCP_SCOPE', 'MCP resource calls need a server declared in this Main packet');
      } else if (state.request.main_mode === 'orchestration') {
        requireValue(state.request.native_tools?.includes(event.toolName), 'PI_MAIN_TOOL_SCOPE', `Tool ${event.toolName} is absent from this Pi Host catalog`);
      } else requireValue(['read', 'grep', 'find', 'ls'].includes(event.toolName)
        || state.request.native_mcp_tools?.includes(event.toolName)
        || state.request.native_mcp_namespaces?.some(namespace => event.toolName.startsWith(`${namespace}__`))
        || (state.request.native_mcp_servers?.length && ['codemode', 'tool_search'].includes(event.toolName)),
        'PI_MAIN_TOOL_SCOPE', `Tool ${event.toolName} is not qualified for this Main node`);
    } catch (error) { return { block: true, reason: `${error.code ?? 'PI_MAIN_TOOL_SCOPE'}: ${error.message}` }; }
  }
  async end() {
    if (this.blockCancelled && this.blockCancelledActor === this.identity().session_id) { this.blockCancelled = false; this.blockCancelledActor = null; return; }
    const state = this.pending; if (!state?.active) return;
    try {
      this.current();
      requireValue(!state.cancelled, 'PI_TASK_ABORTED', 'Current-chat Main was cancelled');
      const entries = this.getContext().sessionManager.getBranch().filter(entry => !state.before.has(entry.id));
      const marker = `PI_CAW_MAIN ${state.dispatch_id}\n`;
      const user = entries.find(entry => entry.type === 'message' && entry.message.role === 'user' && (typeof entry.message.content === 'string' ? entry.message.content : entry.message.content.filter(item => item.type === 'text').map(item => item.text).join('\n')).startsWith(marker));
      const assistant = entries.filter(entry => entry.type === 'message' && entry.message.role === 'assistant').at(-1);
      const call = entries.find(entry => entry.message?.role === 'assistant' && Array.isArray(entry.message.content) && entry.message.content.some(item => item.type === 'toolCall' && item.id === state.submission_call && item.name === 'caw'));
      const result = entries.find(entry => entry.message?.role === 'toolResult' && entry.message.toolCallId === state.submission_call && !entry.message.isError);
      requireValue(user && assistant && assistant.message.stopReason === 'stop', 'PI_MAIN_TURN_INCOMPLETE', 'Main has no exact successful current-chat turn');
      requireValue(state.submission && call && result, 'PI_MAIN_RESULT_MISSING', 'Main has no successful semantic result tool submission in this chat');
      if (state.helperCompletions?.length) await Promise.all(state.helperCompletions);
      state.broker?.assertScope();
      let changed = await observedChanges(state.mutations);
      if (state.workspaceBefore) {
        const after = await snapshotOrchestration(state.request.workspace, state.request.audit_excluded_roots);
        changed = orchestrationChanges(state.workspaceBefore, after, state.request);
        await state.request.onOperation?.({phase:'completed', tool:'orchestration_workspace_audit', entries:changed.length, sha256:digest(canonicalJSON(changed))});
      }
      state.resolve({ ...state.submission, ...state.identity, turn_id: assistant.id, user_entry_id: user.id,
        usage: usageFromEntries(entries),
        changed_paths: changed, evidence: { kind: 'pi_session', thread_id: state.identity.session_id,
          turn_id: assistant.id, user_entry_id: user.id, observed: 'completed', dispatch_id: state.dispatch_id, model: state.observed_model } });
    } catch (error) {
      console.error('[pi-CAW] Main completion validation failed', {run_id:state.request.run_id,node_id:state.request.node_id,main_mode:state.request.main_mode,code:error.code ?? 'PI_MAIN_COMPLETION',message:String(error.message).slice(0,1200),...(error.outside_paths?{outside_paths:error.outside_paths.slice(0,20),outside_count:error.outside_paths.length}:{})});
      state.reject(error);
    }
    finally { state.finished = true; }
  }
}
