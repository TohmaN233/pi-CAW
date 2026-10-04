import * as sdk from '@earendil-works/pi-coding-agent';
import { Type } from '@earendil-works/pi-ai';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai/compat';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { PiSdkHost, requestPiExecutionAdmission } from '../lib/pi-sdk-host.mjs';
import { PiCawService } from '../lib/service.mjs';
import { resolveStateDirectory } from '../lib/settings.mjs';
import { openWorkbench } from '../lib/workbench-server.mjs';
import { WORKBENCH_OPERATIONS } from '../lib/workbench-api.mjs';
import { feedbackText } from '../lib/run-feedback.mjs';

const actions = [...new Set(['capabilities', 'models', 'roles', 'list', 'get_workflow', 'create_workflow', 'save_workflow', 'validate',
  'runs', 'run_snapshot', 'run', 'launch_role', 'pause', 'cancel', 'continue', 'collect_host_tool', 'main_task', 'main_resource', 'main_tool', 'main_result',
  ...WORKBENCH_OPERATIONS])];

export default function piCaw(pi: ExtensionAPI) {
  let context: ExtensionContext;
  let service: PiCawService | undefined;
  let workbench: Awaited<ReturnType<typeof openWorkbench>> | undefined;
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
    if (typeof request?.resolve !== 'function' || typeof request?.reject !== 'function') throw new Error('Invalid private pi-CAW Host command callbacks');
    void (async () => {
      if (!service || !context || request.session_id !== context.sessionManager.getSessionId()) throw new Error('Private pi-CAW Host command requires the exact current Pi session');
      if (!['list', 'run', 'get', 'inspect_run', 'cancel', 'cleanup_run_history', 'run_retention', 'install_workflow_package'].includes(request.operation)) throw new Error('Private pi-CAW Host operation is not allowed');
      if (request.operation === 'install_workflow_package' && (typeof request.args?.package_path !== 'string'
        || typeof request.args?.expected_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(request.args.expected_sha256)
        || Object.keys(request.args).some(key => !['package_path', 'expected_sha256'].includes(key)))) {
        throw new Error('Private pi-CAW Host installation requires one pinned local package file');
      }
      if (request.operation === 'get' || request.operation === 'cancel') {
        const run = await service.call('get', { run_id: request.args?.run_id });
        if (run.main_actor !== request.session_id) throw new Error('Private pi-CAW Host cannot access another session’s Run');
        if (request.operation === 'get') return run;
      }
      return service.call(request.operation, request.args,{human:['cleanup_run_history','run_retention'].includes(request.operation)});
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
  async function initialize(ctx: ExtensionContext) {
    context = ctx;
    if (service) return service;
    const agentDir = sdk.getAgentDir();
    const host = new PiSdkHost({ sdk, Type, supportedThinking: getSupportedThinkingLevels,
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
    service = await new PiCawService({ directory: resolveStateDirectory(agentDir), host,
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
    }).initialize();
    return service;
  }
  pi.on('session_start', async (_event, ctx) => {
    await initialize(ctx); service?.host.main.sessionChanged();
    pi.events.emit('pi-caw:host-ready', { session_id: ctx.sessionManager.getSessionId() });
  });
  pi.on('model_select', async (_event, ctx) => { context = ctx; });
  pi.on('context',async event=>({messages:event.messages.filter((message:any)=>message.role!=='custom' || message.customType!=='pi-caw:status')}));
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
    releaseFeedback();releaseLifecycle(); releaseMainQuery(); releaseHostCommand(); releaseHostReadiness();
    if (workbench) await workbench.close();
    if (service) await service.close();
    workbench = undefined; service = undefined;
  });
  pi.registerCommand('caw', { description: 'Open pi-CAW Workbench; configure explicit Pi model bindings',
    handler: async (_args, ctx) => {
      const current = await initialize(ctx);
      workbench ??= await openWorkbench(current);
      ctx.ui.notify(`pi-CAW: ${workbench.url}`, 'info');
      pi.events.emit('pi-caw:open-workbench', { url: workbench.url });
    },
  });
  pi.registerTool({
    name: 'caw', label: 'pi-CAW',
    description: 'Pi Workflow control plane and automatic Role delegation. Use route for compact valid Ready candidates; role_templates/role_template for one suitable helper; launch_role for its exact configured binding. Management supports graph/resources/history, Skill inventory/import/build/authoring, portable packages, dependency preparation and exact recovery. Logical Main inherits this chat model and thinking. Each Main node executor.mode is worker (default: fresh context with declared inputs/resources) or orchestration (Cooperative only: this chat and its native tools). The initiating Agent may select per-node Run args.main_modes, e.g. {final:"orchestration"}; Host validates and freezes the choices. Current-chat orchestration retrieves main_task, uses tools, submits main_result and finishes its turn; Host verifies actual entries and effects. Children require explicit Pi bindings. Runs notify asynchronously; do not poll. Model configuration, approval, patch integration and final publication require the human Workbench.',
    parameters: Type.Object({ action: Type.Union(actions.map(value => Type.Literal(value))),
      args: Type.Optional(Type.Record(Type.String(), Type.Unknown())) }),
    async execute(id, params, _signal, _update, ctx) {
      const current = await initialize(ctx);
      const args = { ...params.args };
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
