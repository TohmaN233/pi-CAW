import { randomUUID } from 'node:crypto';
import { requireValue } from '../core/workflow-paths.mjs';
import { validateData } from '../core/workflow-data-schema.mjs';
import { acceptSemanticResult } from '../core/result-staging.mjs';
import { canonicalJSON, digest } from '../core/workflow-revisions.mjs';
import { writablePath, observeMutation, observedChanges } from './scope.mjs';
import { readPinnedResource } from './resources.mjs';
import { scopedTaskBroker } from './task-broker.mjs';
import { usageFromEntries } from './usage.mjs';
import { snapshotOrchestration, orchestrationChanges } from './orchestration-audit.mjs';
import { currentMainTaskPrompt, currentMainResultProtocol, currentMainCorrectionPrompt } from './task-prompt.mjs';
import { correctableCompletionError } from '../core/execution/completion-preflight.mjs';

const semanticSubmissionCode=code=>correctableCompletionError({code})||['PI_RESULT_SUMMARY','PI_RESULT_BODY','PI_RESULT_STAGE_MISSING','PI_RESULT_STAGE_RESEND','PI_RESULT_PATCH','PI_RESULT_STAGED','PI_RESULT_SIZE','PI_RESULT_CONFLICT'].includes(code);
const failure=(message,code)=>Object.assign(new Error(message),{code});
const pinnedResourceFault=error=>error?.code==='PI_RESOURCE_DRIFT'||Number.isInteger(error?.errno)&&typeof error?.syscall==='string';

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
    const state = { request, identity, dispatch_id: randomUUID(), active: false, mutations: new Map(), submission: null, closed: false, running:false };
    state.released = new Promise(resolveRelease => { state.release = resolveRelease; });
    this.pending = state;
    const assertSession = () => requireValue(this.identity().session_id === identity.session_id, 'PI_MAIN_SESSION_CHANGED', 'Main cannot move to another Pi chat');
    const task = { ...identity,
      run: ({ prompt, schema, signal }) => {
        assertSession(); requireValue(this.pending===state&&!state.running&&!state.closed&&!state.failed&&!state.cancelled&&!signal?.aborted, 'PI_MAIN_DISPATCH', 'Main dispatch is closed, failed, cancelled or already running');
        const runToken=state.runToken={};
        Object.assign(state,{schema,running:true,active:false,finished:false,submission:null,staged:null,submission_call:null,lastSubmissionError:null,mechanicalError:null,operationError:null,helperCompletions:[],rejectedEntries:[],dispatch_id:randomUUID(),turnToken:{},workspaceBefore:null});
        state.mutations.clear();
        state.before = new Set(this.getContext().sessionManager.getEntries().map(entry => entry.id));
        state.completion = new Promise((resolveResult, reject) => { state.resolve = resolveResult; state.reject = reject; });
        const abort = () => {
          if(state.runToken!==runToken||!state.running||state.cancelled)return;
          state.cancelled = true;
          state.broker?.revoke();
          if (this.identity().session_id !== state.identity.session_id) {
            state.finished = true;
            state.reject(failure('The original Main chat changed; the new chat was not aborted','PI_MAIN_SESSION_CHANGED'));
          } else {
            if(state.active)this.getContext().abort();
            else {this.cancelledMarkers.set(state.dispatch_id,state.identity.session_id);state.reject(failure('Main was cancelled before its queued turn','PI_TASK_ABORTED'));}
          }
        };
        state.cancel = abort;
        signal?.addEventListener('abort', abort, { once: true });
        state.completion = state.completion.catch(error=>{if(state.runToken===runToken)state.failed=true;throw error;}).finally(() => {
          signal?.removeEventListener('abort', abort);
          if(state.runToken===runToken){state.running=false;state.active=false;state.finished=true;}
        });
        void Promise.resolve().then(async () => {
          if (request.main_mode === 'orchestration') state.workspaceBefore = await snapshotOrchestration(request.workspace, request.audit_excluded_roots);
          requireValue(state.runToken===runToken&&!state.cancelled&&!state.closed,'PI_TASK_ABORTED','Main cancelled before its queued turn');
          await request.authorize?.();
          requireValue(state.runToken===runToken&&!state.cancelled&&!state.closed,'PI_TASK_ABORTED','Main cancelled during dispatch authorization');
          const submitted=currentMainTaskPrompt(state.dispatch_id,prompt,schema,request.prompt_byte_limit,request.workspace);
          await request.onOperation?.({tool:'model',phase:'prompt_prepared',sha256:digest(submitted),bytes:Buffer.byteLength(submitted)});
          requireValue(state.runToken===runToken&&!state.cancelled&&!state.closed,'PI_TASK_ABORTED','Main cancelled before prompt delivery');
          await this.deliver(submitted);
        }).catch(error => {if(state.runToken===runToken)state.reject(error);});
        return state.completion;
      },
      abort: async () => { if (state.cancel && state.running) state.cancel(); },
      close: () => {
        if(state.closePromise)return state.closePromise;
        state.closePromise=(async()=>{
          state.closed = true; await task.abort();
          if (state.completion) await Promise.allSettled([state.completion]);
          if(state.brokerPromise)state.broker=await state.brokerPromise;
          if (state.broker) await state.broker.close();
          if (this.pending === state) this.pending = null;
          state.release();
        })();
        return state.closePromise;
      },
    };
    return task;
  }
  ownsPrompt(prompt, actor = this.identity().session_id) {
    if (actor !== this.identity().session_id) return false;
    if (this.blockCancelled && this.blockCancelledActor === actor) return true;
    if (typeof prompt === 'string' && [...this.cancelledMarkers].some(([id, owner]) => owner === actor && prompt.startsWith(`PI_CAW_MAIN ${id}\n`))) return true;
    const state = this.pending;
    return !!(state && state.running && !state.closed && !state.finished && !state.cancelled && state.identity.session_id === actor
      && (state.active || typeof prompt === 'string' && prompt.startsWith(`PI_CAW_MAIN ${state.dispatch_id}\n`)));
  }
  begin(prompt) {
    const actor = this.identity().session_id;
    const cancelled = [...this.cancelledMarkers].find(([id, owner]) => owner === actor && prompt.startsWith(`PI_CAW_MAIN ${id}\n`))?.[0];
    if (cancelled) { this.cancelledMarkers.delete(cancelled); this.blockCancelled = true; this.blockCancelledActor = actor; return 'This queued pi-CAW Main dispatch was cancelled. Do not execute tools or perform work. End the turn.'; }
    const state = this.pending;
    if (!state || !state.running || state.finished || state.closed || state.cancelled || !prompt.startsWith(`PI_CAW_MAIN ${state.dispatch_id}\n`)) return;
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
    return { run_id: state.request.run_id, node_id: state.request.node_id, workspace: state.request.workspace, main_mode: state.request.main_mode ?? 'legacy_current', outputs_schema: state.schema,
      access: state.request.access, allowed_paths: state.request.allowed_paths, resources: state.request.resources.map(item => ({ path: item.path, sha256: item.sha256 })),
      tools: ['list_workspace', 'read_workspace', ...(state.request.access === 'bounded_write' ? ['write_workspace', 'mkdir_workspace', 'materialize_workflow_resource'] : []),
        ...(state.request.resources.length ? ['read_workflow_resource', 'read_workflow_resource_range', 'read_workflow_resource_chunk'] : []),
        ...(state.request.runtime_environment?.tools?.length ? ['run_task_program','read_program_output'] : [])],
      native_mcp_servers: state.request.native_mcp_servers ?? [], native_mcp_tools: state.request.native_mcp_tools ?? [],
      runtime_environment: state.request.runtime_environment ?? null, shell: state.request.shell ?? null, submission_protocol:currentMainResultProtocol(state.staged?.id) };
  }
  async submit(params, toolCallId) {
    const state = this.current();
    let accepted;
    try{
      accepted=await acceptSemanticResult(state, params, async result => {
        validateData(result, state.schema);
        await state.request.validateResult?.(result);
        requireValue(this.current() === state&&!state.cancelled&&!state.closed, 'PI_TASK_ABORTED', 'Main task changed during semantic result validation');
      }, state.schema);
      state.lastSubmissionError=null;
    }catch(error){
      const cause=error.code==='PI_RESULT_STAGED'?(error.cause??state.staged?.validation_error):null;
      const actual=cause??error;
      state.lastSubmissionError={code:actual.code??'PI_MAIN_SUBMISSION',reason:actual.message};
      if(cause?!correctableCompletionError(cause):!semanticSubmissionCode(error.code))state.mechanicalError??=actual;
      throw error;
    }
    state.submission_call = toolCallId;
    return { recorded: true, promoted: accepted.promoted, stage_id: accepted.stage_id,
      message: accepted.promoted
        ? 'Staged correction validated and promoted. Finish the current turn. The Host will verify its actual Pi entries.'
        : 'Finish the current turn. The Host will verify its actual Pi entries.' };
  }
  async readResource(params) {
    const state=this.current();
    try{return await readPinnedResource(state.request.resources,params);}
    catch(error){state.operationError=error;if(pinnedResourceFault(error))state.mechanicalError??=error;throw error;}
  }
  async tool(params, callId) {
    const state = this.current();
    try{
      state.brokerPromise ??= scopedTaskBroker(state.request, state.mutations,
        async () => { requireValue(this.current()===state&&!state.cancelled&&!state.closed, 'PI_TASK_ABORTED', 'Main task authority was revoked'); await state.request.authorize?.(); });
      state.broker ??= await state.brokerPromise;
      requireValue(state.broker.tools().some(tool => tool.name === params.name), 'PI_MAIN_TOOL_SCOPE', 'Tool is not declared in this Main packet');
      return await state.broker.execute(params.name, params.args ?? {}, callId);
    }catch(error){state.operationError=error;if(pinnedResourceFault(error))state.mechanicalError??=error;throw error;}
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
    } catch (error) { state.operationError=error;return { block: true, reason: `${error.code ?? 'PI_MAIN_TOOL_SCOPE'}: ${error.message}` }; }
  }
  async end() {
    if (this.blockCancelled && this.blockCancelledActor === this.identity().session_id) { this.blockCancelled = false; this.blockCancelledActor = null; return; }
    const state = this.pending; if (!state?.active) return;
    const turnToken=state.turnToken;
    if(state.ending?.token===turnToken)return state.ending.promise;
    const promise=this.completeTurn(state,turnToken);state.ending={token:turnToken,promise};return promise;
  }
  async completeTurn(state,turnToken) {
    try {
      this.current();
      requireValue(!state.cancelled&&!state.closed, 'PI_TASK_ABORTED', 'Current-chat Main was cancelled');
      await state.request.authorize?.();
      requireValue(!state.cancelled&&!state.closed, 'PI_TASK_ABORTED', 'Current-chat Main was cancelled during completion authorization');
      if(state.mechanicalError)throw state.mechanicalError;
      const entries = this.getContext().sessionManager.getBranch().filter(entry => !state.before.has(entry.id));
      const marker = `PI_CAW_MAIN ${state.dispatch_id}\n`;
      const user = entries.find(entry => entry.type === 'message' && entry.message.role === 'user' && (typeof entry.message.content === 'string' ? entry.message.content : entry.message.content.filter(item => item.type === 'text').map(item => item.text).join('\n')).startsWith(marker));
      const assistant = entries.filter(entry => entry.type === 'message' && entry.message.role === 'assistant').at(-1);
      const call = entries.find(entry => entry.message?.role === 'assistant' && Array.isArray(entry.message.content) && entry.message.content.some(item => item.type === 'toolCall' && item.id === state.submission_call && item.name === 'caw'));
      const result = entries.find(entry => entry.message?.role === 'toolResult' && entry.message.toolCallId === state.submission_call && !entry.message.isError);
      requireValue(user && assistant && assistant.message.stopReason === 'stop', 'PI_MAIN_TURN_INCOMPLETE', 'Main has no exact successful current-chat turn');
      state.broker?.assertScope();
      if(!(state.submission&&call&&result)){
        if(state.operationError)throw state.operationError;
        const issue=state.lastSubmissionError??{code:'PI_MAIN_RESULT_MISSING',reason:'Main has no successful semantic result tool submission in this chat'};
        if(state.request.onSemanticCorrection&&(semanticSubmissionCode(issue.code)||issue.code==='PI_MAIN_RESULT_MISSING')){
          try{await state.request.onSemanticCorrection({turn_id:assistant.id,reason:issue.reason,code:issue.code});}
          catch(error){throw failure(`${issue.reason}\nSemantic correction could not continue: ${error.message}`,error.code??issue.code);}
          requireValue(!state.cancelled&&!state.closed&&state.turnToken===turnToken,'PI_TASK_ABORTED','Main was cancelled during semantic correction');
          this.current();
          await state.request.authorize?.();
          requireValue(!state.cancelled&&!state.closed&&state.turnToken===turnToken,'PI_TASK_ABORTED','Main was cancelled before semantic correction delivery');
          state.rejectedEntries.push(...entries);
          state.dispatch_id=randomUUID();state.turnToken={};state.before=new Set(this.getContext().sessionManager.getEntries().map(entry=>entry.id));
          state.active=false;state.finished=false;state.submission=null;state.submission_call=null;
          const prompt=currentMainCorrectionPrompt(state.dispatch_id,{...issue,stageId:state.staged?.id},state.request.prompt_byte_limit);
          await state.request.onOperation?.({tool:'model',phase:'prompt_prepared',sha256:digest(prompt),bytes:Buffer.byteLength(prompt)});
          requireValue(!state.cancelled&&!state.closed&&this.pending===state,'PI_TASK_ABORTED','Main was cancelled before semantic correction prompt');
          await this.deliver(prompt);return;
        }
        throw failure(issue.reason,issue.code);
      }
      if (state.helperCompletions?.length) await Promise.all(state.helperCompletions);
      requireValue(!state.cancelled&&!state.closed&&this.pending===state,'PI_TASK_ABORTED','Main was revoked while waiting for its helpers');
      let changed = await observedChanges(state.mutations);
      if (state.workspaceBefore) {
        const after = await snapshotOrchestration(state.request.workspace, state.request.audit_excluded_roots);
        changed = orchestrationChanges(state.workspaceBefore, after, state.request);
        await state.request.onOperation?.({phase:'completed', tool:'orchestration_workspace_audit', entries:changed.length, sha256:digest(canonicalJSON(changed))});
      }
      requireValue(!state.cancelled&&!state.closed&&this.pending===state,'PI_TASK_ABORTED','Main was revoked during completion verification');
      state.resolve({ ...state.submission, ...state.identity, turn_id: assistant.id, user_entry_id: user.id,
        usage: usageFromEntries([...state.rejectedEntries,...entries]),
        changed_paths: changed, evidence: { kind: 'pi_session', thread_id: state.identity.session_id,
          turn_id: assistant.id, user_entry_id: user.id, observed: 'completed', dispatch_id: state.dispatch_id, model: state.observed_model } });
    } catch (error) {
      console.error('[pi-CAW] Main completion validation failed', {run_id:state.request.run_id,node_id:state.request.node_id,main_mode:state.request.main_mode,code:error.code ?? 'PI_MAIN_COMPLETION',message:String(error.message).slice(0,1200),...(error.outside_paths?{outside_paths:error.outside_paths.slice(0,20),outside_count:error.outside_paths.length}:{})});
      state.reject(error);
    }
    finally { if(state.turnToken===turnToken){state.finished=true;state.active=false;} }
  }
}
