import * as sdk from '@earendil-works/pi-coding-agent';
import { randomUUID } from 'node:crypto';
import { Type } from '@earendil-works/pi-ai';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai/compat';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { PiSdkHost, requestPiExecutionAdmission } from '../lib/pi-sdk-host.mjs';
import { PiCawService } from '../lib/service.mjs';
import { resolveStateDirectory } from '../lib/settings.mjs';
import { openWorkbench } from '../lib/workbench-server.mjs';
import { WORKBENCH_OPERATIONS } from '../lib/workbench-api.mjs';
import { feedbackText } from '../lib/run-feedback.mjs';
import { projectWorkflowContext } from '../lib/notification-context.mjs';

const actions = [...new Set(['capabilities', 'models', 'roles', 'list', 'get_workflow', 'create_workflow', 'save_workflow', 'validate',
  'runs', 'inspect_run_admission', 'recover_run_admission', 'run_snapshot', 'run', 'launch_role', 'pause', 'cancel', 'continue', 'collect_host_tool', 'main_task', 'main_resource', 'main_tool', 'main_result',
  ...WORKBENCH_OPERATIONS])];

export default function piCaw(pi: ExtensionAPI) {
  let context: ExtensionContext;
  let service: PiCawService | undefined;
  let ownedService: PiCawService | undefined;
  let ownedServiceTrace: { lifecycle_id: string; pid: number; session_id: string } | undefined;
  let initialization: Promise<PiCawService> | undefined;
  let ownedServiceClose: Promise<void> | undefined;
  let shuttingDown = false;
  let shutdown: Promise<void> | undefined;
  let workbench: Awaited<ReturnType<typeof openWorkbench>> | undefined;
  let workbenchOpening: Promise<Awaited<ReturnType<typeof openWorkbench>>> | undefined;
  let workbenchOpeningCancellation: { opening: Promise<Awaited<ReturnType<typeof openWorkbench>>>; error: Error } | undefined;
  let workbenchClose: Promise<void> | undefined;
  const domainRuns = new Set<string>();
  const releaseFeedback=pi.events.on('pi-caw:run-feedback',(value:unknown)=>{
    const event=value as {run_id:string;main_actor:string;status:string};
    if(!context || context.sessionManager.getSessionId()!==event.main_actor)return;
    const content=feedbackText(value),entries=context.sessionManager.getEntries();
    const previous=[...entries].reverse().find((entry:any)=>entry.type==='custom_message' && entry.customType==='pi-caw:status' && entry.details?.run_id===event.run_id) as any;
    if(previous?.content===content && JSON.stringify(previous?.details)===JSON.stringify(event))return;
    pi.sendMessage({customType:'pi-caw:status',content,details:event,display:true},{triggerTurn:false});
  });
  const admissionRequiredSessions = new Set<string>();
  const releaseHostReadiness = pi.events.on('pi-caw:host-readiness', (value: unknown) => {
    const request = value as { session_id: string; ready: boolean };
    request.ready = !!service && !!context && request.session_id === context.sessionManager.getSessionId();
  });
  const releaseHostCommand = pi.events.on('pi-caw:host-command', (value: unknown) => {
    const request = value as { session_id: string; operation: string; args: Record<string, unknown>; resolve: (result: unknown) => void; reject: (error: unknown) => void };
    if (!context || request.session_id !== context.sessionManager.getSessionId()) return;
    if (typeof request?.resolve !== 'function' || typeof request?.reject !== 'function') throw new Error('Invalid private pi-CAW Host command callbacks');
    void (async () => {
      if (shuttingDown) throw shutdownError();
      const current = service;
      if (!current) throw new Error('Private pi-CAW Host is not ready in this session');
      if (!['list', 'run', 'get', 'inspect_run', 'inspect_run_admission', 'cancel', 'cleanup_run_history', 'run_retention', 'install_workflow_package'].includes(request.operation)) throw new Error('Private pi-CAW Host operation is not allowed');
      if (request.operation === 'install_workflow_package' && (typeof request.args?.package_path !== 'string'
        || typeof request.args?.expected_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(request.args.expected_sha256)
        || Object.keys(request.args).some(key => !['package_path', 'expected_sha256'].includes(key)))) {
        throw new Error('Private pi-CAW Host installation requires one pinned local package file');
      }
      if (request.operation === 'get' || request.operation === 'cancel') {
        const run = await current.call('get', { run_id: request.args?.run_id });
        if (shuttingDown) throw shutdownError();
        if (run.main_actor !== request.session_id) throw new Error('Private pi-CAW Host cannot access another session’s Run');
        if (request.operation === 'get') return run;
      }
      return current.call(request.operation, request.args,{human:['cleanup_run_history','run_retention'].includes(request.operation)});
    })().then(request.resolve, request.reject);
  });
  const releaseLifecycle = pi.events.on('pi-caw:run-lifecycle', (value: unknown) => {
    const event=value as {run_id:string;host_tool_ids?:string[]};
    if(event.host_tool_ids?.some(id => id.startsWith('course_'))) domainRuns.add(event.run_id);
  });
  const releaseMainQuery = pi.events.on('pi-caw:main-query', (value: unknown) => {
    const query=value as {session_id:string;prompt?:string;owned:boolean};
    if(service?.host.main.ownsPrompt(query.prompt, query.session_id)) query.owned = true;
  });
  const shutdownError = () => Object.assign(new Error('pi-CAW extension is shutting down; initialization cannot publish a service'), { code: 'PI_CAW_SHUTTING_DOWN' });
  const lifecycleCode = (error: unknown) => {
    const code = (error as { code?: unknown } | null)?.code;
    return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code
      : error instanceof AggregateError ? 'AGGREGATE_ERROR' : 'INITIALIZATION_OR_CLEANUP_ERROR';
  };
  const traceLifecycle = (trace: { lifecycle_id: string; pid: number; session_id: string } | undefined, phase: string, error?: unknown) => {
    console.info('[pi-CAW] extension lifecycle', { ...trace, phase, ...(phase.endsWith('_failed') ? { code: lifecycleCode(error) } : {}) });
  };
  async function closeOwnedService() {
    const owner = ownedService;
    const trace = ownedServiceTrace;
    if (!owner) return;
    ownedServiceClose ??= Promise.resolve().then(async () => {
      traceLifecycle(trace, 'cleanup_started');
      try { await owner.close(); }
      catch (error) { traceLifecycle(trace, 'cleanup_failed', error); throw error; }
      traceLifecycle(trace, 'cleanup_complete');
      if (ownedService === owner) ownedService = undefined;
      if (service === owner) service = undefined;
    });
    await ownedServiceClose;
  }
  async function initializeWorkbench(current: PiCawService) {
    if (shuttingDown) throw shutdownError();
    if (workbench) return workbench;
    if (workbenchOpening) return workbenchOpening;
    const opening = Promise.resolve().then(async () => {
      if (shuttingDown) {
        const error = shutdownError();
        workbenchOpeningCancellation = { opening, error };
        throw error;
      }
      const opened = await openWorkbench(current);
      // Even a late result remains owned so shutdown can close its server.
      workbench = opened;
      return opened;
    });
    workbenchOpening = opening;
    try { return await opening; }
    finally { if (workbenchOpening === opening && !workbench) workbenchOpening = undefined; }
  }
  async function closeOwnedWorkbench() {
    const owner = workbench;
    if (!owner) return;
    workbenchClose ??= Promise.resolve().then(async () => {
      await owner.close();
      if (workbench === owner) workbench = undefined;
    });
    await workbenchClose;
  }
  async function initialize(ctx: ExtensionContext) {
    context = ctx;
    if (shuttingDown) throw shutdownError();
    if (service) return service;
    if (initialization) return initialization;
    const starting = (async () => {
    const agentDir = sdk.getAgentDir();
    const runtimeRequest: { binding?: Record<string, unknown>; error?: Error } = {};
    pi.events.emit('pi-caw:sdk-runtime', runtimeRequest);
    if (runtimeRequest.error) throw runtimeRequest.error;
    const host = new PiSdkHost({ sdk, Type, supportedThinking: getSupportedThinkingLevels, runtimeBinding: runtimeRequest.binding,
      agentDir, getContext: () => ({ ...context, thinkingLevel: pi.getThinkingLevel() }), getCommands: () => pi.getCommands(),
      getMcpServers: () => pi.getMcpServers(), getAllTools: () => pi.getAllTools(),
      workflowScope: (sessionId: string, catalog: unknown[]) => {
        const request: {session_id:string;catalog:unknown[];scope?:unknown;error?:Error} = {session_id:sessionId,catalog};
        pi.events.emit('pi-caw:workflow-scope',request);if(request.error)throw request.error;return request.scope;
      },
      setWorkflowEnabled: (selection: {session_id:string;mode_pack_id:string;workflow_id:string;enabled:boolean;catalog:unknown[];expected_revision?:number;expected_origin?:string;expected_snapshot_id?:string}) => new Promise((resolve,reject) => {
        const timer=setTimeout(()=>reject(new Error('Current-mode Workflow preference adapter timed out; refresh its actual state before retrying')),30000);
        try { pi.events.emit('pi-caw:workflow-setting',{...selection,resolve:(result:unknown)=>{clearTimeout(timer);resolve(result);},reject:(error:unknown)=>{clearTimeout(timer);reject(error);}}); }
        catch(error){clearTimeout(timer);reject(error);}
      }),
      getHostTools: () => { const request = {session_id:context.sessionManager.getSessionId(),registry:{},execution_admission_required:false};
        pi.events.emit('pi-caw:host-tools',request);
        if (request.execution_admission_required === true) admissionRequiredSessions.add(request.session_id);
        return request.registry; },
      executionAdmissionRequired: (sessionId: string) => admissionRequiredSessions.has(sessionId),
      authorizeExecution: (selection: {session_id:string;operation:string;args:Record<string,unknown>;required:boolean}) => requestPiExecutionAdmission(
        (name: string, request: unknown) => pi.events.emit(name,request),
        {...selection,required:selection.required === true || admissionRequiredSessions.has(selection.session_id)},
        (sessionId: string) => admissionRequiredSessions.add(sessionId)),
      deliverMain: (prompt: string) => pi.sendUserMessage(prompt, { deliverAs: 'followUp' }),
      emit: (name: string, data: unknown) => pi.events.emit(name, data) });
    const candidate = new PiCawService({ directory: resolveStateDirectory(agentDir), host,
      notify: (event: unknown) => {
        const deliveryId = (event as { delivery_id?: string }).delivery_id;
        if (deliveryId && context.sessionManager.getEntries().some((entry: any) => {
          if (entry.type !== 'custom_message' || entry.customType !== 'pi-caw:completion' || typeof entry.content !== 'string') return false;
          return JSON.parse(entry.content).delivery_id === deliveryId;
        })) return;
        pi.events.emit('pi-caw:task-finished', event);
        const completion=event as {run_id?:string;notification_context?:{authoring?:boolean}};
        pi.sendMessage({ customType: 'pi-caw:completion', content: JSON.stringify(event), display: true },
          { deliverAs: 'followUp', triggerTurn: completion.notification_context?.authoring !== true && !domainRuns.has(completion.run_id ?? '') });
      },
    });
    // Ownership begins before initialization can create timers or acquire
    // maintenance references. Readiness is published only after success.
    ownedService = candidate; ownedServiceClose = undefined;
    const trace = { lifecycle_id: randomUUID(), pid: process.pid, session_id: ctx.sessionManager.getSessionId() };
    ownedServiceTrace = trace;
    traceLifecycle(trace, 'init_started');
    try {
      await candidate.initialize();
      if (shuttingDown) throw shutdownError();
      service = candidate;
      traceLifecycle(trace, 'init_ready');
      return candidate;
    } catch (error) {
      traceLifecycle(trace, 'init_failed', error);
      try { await closeOwnedService(); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], 'pi-CAW initialization failed and owned service shutdown is unconfirmed'); }
      throw error;
    }
    })();
    initialization = starting;
    try { return await starting; }
    finally {
      // An unconfirmed close keeps this exact failed owner/promise fenced.
      if (initialization === starting && !ownedService) initialization = undefined;
    }
  }
  pi.on('session_start', async (_event, ctx) => {
    const current = await initialize(ctx);
    if (shuttingDown) throw shutdownError();
    current.host.main.sessionChanged();
    pi.events.emit('pi-caw:host-ready', { session_id: ctx.sessionManager.getSessionId() });
  });
  pi.on('model_select', async (_event, ctx) => { context = ctx; });
  pi.on('context',async event=>({messages:projectWorkflowContext(event.messages)}));
  pi.on('before_agent_start', async (event, ctx) => {
    context = ctx; const instruction = service?.host.main.begin(event.prompt);
    if (instruction) return { systemPrompt: `${event.systemPrompt}\n${instruction}` };
  });
  pi.on('message_start', async (event, ctx) => {
    context = ctx;
    // Pi can drain follow-up user messages inside an existing agent loop,
    // without firing before_agent_start for each queued message.
    if (event.message.role === 'user') {
      const content = event.message.content;
      const text = typeof content === 'string' ? content : content.filter(item => item.type === 'text').map(item => item.text).join('\n');
      service?.host.main.begin(text);
    }
  });
  pi.on('tool_call', async (event, ctx) => { context = ctx; return service?.host.main.guard(event); });
  pi.on('agent_end', async (_event, ctx) => { context = ctx; await service?.host.main.end(); });
  pi.on('session_shutdown', async () => {
    if (shutdown) return shutdown;
    shuttingDown = true;
    releaseFeedback();releaseLifecycle(); releaseMainQuery(); releaseHostCommand(); releaseHostReadiness();
    shutdown = (async () => {
      const failures: unknown[] = [];
      const opening = workbenchOpening;
      try { await opening; }
      catch (error) {
        // Only this exact pre-open admission cancellation owns no server.
        // An external open failure, even with the same code, remains visible.
        if (!workbenchOpeningCancellation || workbenchOpeningCancellation.opening !== opening
          || workbenchOpeningCancellation.error !== error) failures.push(error);
      }
      try { await closeOwnedWorkbench(); }
      catch (error) { failures.push(error); }
      let initializationError: unknown;
      let initializationFailed = false;
      try { await initialization; }
      catch (error) { initializationError = error; initializationFailed = true; }
      try { await closeOwnedService(); }
      catch (error) {
        if (initializationFailed && initializationError !== error) failures.push(initializationError);
        failures.push(error);
      }
      // Initialization errors already reach their callers. Successful owned
      // cleanup, including after such an error, is the shutdown proof.
      if (failures.length) throw new AggregateError(failures, 'pi-CAW extension shutdown is unconfirmed');
      service = undefined;
    })();
    return shutdown;
  });
  pi.registerCommand('caw', { description: 'Open pi-CAW Workbench; configure explicit Pi model bindings',
    handler: async (_args, ctx) => {
      const current = await initialize(ctx);
      if (shuttingDown) throw shutdownError();
      const opened = await initializeWorkbench(current);
      if (shuttingDown) throw shutdownError();
      ctx.ui.notify(`pi-CAW: ${opened.url}`, 'info');
      pi.events.emit('pi-caw:open-workbench', { url: opened.url });
    },
  });
  pi.registerTool({
    name: 'caw', label: 'pi-CAW',
    description: 'Pi Workflow control plane and automatic Role delegation. Use route for compact valid Ready candidates; role_templates/role_template for one suitable helper; launch_role for its exact configured binding. Management supports graph/resources/history, Skill inventory/import/build/authoring, portable packages, dependency preparation and exact recovery. Logical Main inherits this chat model and thinking. Each Main node executor.mode is worker (default: fresh context with declared inputs/resources) or orchestration (Cooperative only: this chat and its native tools). The initiating Agent may select per-node Run args.main_modes, e.g. {final:"orchestration"}; Host validates and freezes the choices. Current-chat orchestration retrieves main_task, uses tools, submits main_result and finishes its turn; Host verifies actual entries and effects. Children require explicit Pi bindings. Runs notify asynchronously; do not poll. Model configuration, approval, patch integration and final publication require the human Workbench.',
    parameters: Type.Object({ action: Type.Union(actions.map(value => Type.Literal(value))),
      args: Type.Optional(Type.Record(Type.String(), Type.Unknown())) }),
    async execute(id, params, _signal, _update, ctx) {
      const current = await initialize(ctx);
      if (shuttingDown) throw shutdownError();
      const args = { ...params.args };
      if(params.action==='recover_run_admission'){
        const detail=JSON.stringify(args.records);
        if(typeof args.run_id!=='string'||typeof detail!=='string'||Buffer.byteLength(detail)>65536)throw new Error('Admission operation requires one exact Run and bounded inspected records');
        const accepted=await ctx.ui.confirm('Recover inspected Run admission ownership',
          `Run: ${args.run_id}\n${detail}\nOnly selected unchanged records with confirmed absent owners are retired. Business state and execution stay unchanged.`);
        if(!accepted)throw Object.assign(new Error('Human admission authorization was not granted'),{code:'HUMAN_RECOVERY_REQUIRED'});
        if (shuttingDown) throw shutdownError();
        const result=await current.call(params.action,args,{human:true,signal:_signal});
        return {content:[{type:'text',text:JSON.stringify(result)}],details:{kind:'pi-caw',action:params.action}};
      }
      if (params.action === 'run' || params.action === 'launch_role') args.workspace ??= ctx.cwd;
      const result = params.action === 'main_task' ? current.host.main.packet()
        : params.action === 'main_resource' ? await current.host.main.readResource(args)
        : params.action === 'main_tool' ? await current.host.main.tool(args, id)
        : params.action === 'main_result' ? await current.host.main.submit(args, id)
        : await current.call(params.action, args, { signal: _signal });
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: { kind: 'pi-caw', action: params.action } };
    },
  });
}
