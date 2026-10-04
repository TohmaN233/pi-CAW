import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { requireValue } from '../core/workflow-paths.mjs';
import { canonicalJSON } from '../core/workflow-revisions.mjs';
import { availableModels } from './models.mjs';
import { PiSdkHost } from './pi-sdk-host.mjs';
import {assertMainTaskIdentity} from './main-context.mjs';
import { PiCawService } from './service.mjs';
import { ownerRpc } from './detached-owner.mjs';
import { createRemoteHostTools } from './external-host-tools.mjs';

const terminal = new Set(['succeeded', 'failed', 'cancelled']);
function pending() {
  let resolveValue, rejectValue;
  const promise = new Promise((resolvePromise, rejectPromise) => { resolveValue = resolvePromise; rejectValue = rejectPromise; });
  void promise.catch(() => {});
  return { promise, resolve: resolveValue, reject: rejectValue };
}
function diagnostic(error) { return { code: error.code ?? 'PI_WORKER_ERROR', message: error.message }; }
export function remoteError(error, signal, dispatched = false) {
  if (signal?.aborted) return Object.assign(new Error('The detached Main dispatch was cancelled'), { code: 'PI_TASK_ABORTED', cause: error,
    ...(dispatched || error.quiescent === false ? { quiescent: false } : {}) });
  if (error.rpc_application_error === true || error.code?.startsWith('PI_')) return error;
  return Object.assign(new Error('The original Pi Main bridge disconnected; reconcile this exact attempt before continuing'),
    { code: 'PI_PARENT_MAIN_DISCONNECTED', cause: error, quiescent: false });
}

// Notifications can concern a nested Run or an ordinary Role. Only a result
// addressed to this exact root can settle its independent execution owner.
export function createWorkerObserver({ run_id, report, send, settle, active = () => true }) {
  const notifications = new Map(); let rootOutcome = { run_id, status: 'running' }, terminalSeen = false;
  const classify = (outcome, { defaultRoot = false } = {}) => {
    requireValue(outcome && typeof outcome.status === 'string', 'PI_WORKER_OUTCOME', 'Execution notification needs an explicit status');
    const event = structuredClone(outcome);
    if (defaultRoot && event.run_id === undefined) event.run_id = run_id;
    return { event, root: event.run_id === run_id };
  };
  const queueEvidence = (status, error) => ({ status, queued_count: notifications.size,
    events: [...notifications.values()].map(event => structuredClone(event)), ...(error ? { error: diagnostic(error) } : {}) });
  const record = async (outcome, options) => {
    const addressed = classify(outcome, options);
    if (addressed.root) rootOutcome = addressed.event;
    if (active()) await report({ ...rootOutcome, ...(!addressed.root ? { child_event: addressed.event } : {}),
      ...(notifications.size ? { parent_notification: queueEvidence('queued') } : {}) });
    return addressed;
  };
  return {
    current: () => structuredClone(rootOutcome),
    record,
    async observe(outcome, options) {
      if (!active()) return;
      const addressed = classify(outcome, options);
      const rootTerminal = addressed.root && terminal.has(addressed.event.status);
      if (terminalSeen && !rootTerminal) return;
      if (terminalSeen) requireValue(rootOutcome.status === addressed.event.status,
        'PI_WORKER_TERMINAL_CHANGED', 'A completed owner cannot change its exact terminal result');
      const settles = rootTerminal && !terminalSeen;
      if (rootTerminal) terminalSeen = true;
      const key = canonicalJSON(addressed.event); notifications.set(key, addressed.event);
      await record(outcome, options);
      let sendError;
      try { await send(addressed.event); notifications.delete(key); }
      catch (error) { sendError = error; }
      // A terminal report may begin stop while this driver is still notifying.
      // Its exact queued event and delivery acknowledgment remain journal data,
      // even after execution authority is revoked.
      await report({ ...rootOutcome, ...(!addressed.root ? { child_event: addressed.event } : {}),
        parent_notification: queueEvidence(notifications.size ? 'queued' : 'delivered', sendError) });
      if (settles) await settle(addressed.event);
    },
    async flush() {
      for (const [key, event] of notifications) {
        try { await send(event); notifications.delete(key); }
        catch (error) { if (active()) await report({ ...rootOutcome, parent_notification: queueEvidence('queued', error) }); throw error; }
      }
      if (active()) await report({ ...rootOutcome, parent_notification: queueEvidence('delivered') });
    },
  };
}

export async function createOwnerRuntime(context) {
  let dispatched = false;
  try { return await initializeOwnerRuntime(context, () => { dispatched = true; }); }
  catch (error) {
    // Before the driver starts there are no agent sessions, task brokers or
    // native programs. The registry can retire this failed bootstrap safely.
    if (!dispatched && error.quiescent !== false) Object.assign(error, { quiescent: true, shutdown_reason: 'pi_bootstrap_before_driver' });
    throw error;
  }
}

async function initializeOwnerRuntime(context, markDispatched) {
  const { boot, run_id, main_actor } = context;
  requireValue(boot && ['directory', 'sdkPackageDir', 'agentDir', 'cwd'].every(key => typeof boot[key] === 'string' && isAbsolute(boot[key]))
    && boot.main_identity?.session_id === main_actor && Array.isArray(boot.catalog)
    && Array.isArray(boot.provider_configs) && Array.isArray(boot.registered_mcp_servers),
  'PI_WORKER_BOOT', 'Detached Pi execution needs the exact trusted Host bootstrap');
  await context.assertAuthority();
  const sdk = await import(pathToFileURL(join(boot.sdkPackageDir, 'dist/index.js')).href);
  const ai = await import(pathToFileURL(join(dirname(boot.sdkPackageDir), 'pi-ai/dist/compat.js')).href);
  requireValue(resolve(sdk.getPackageDir()) === resolve(boot.sdkPackageDir), 'PI_WORKER_SDK', 'The worker loaded a different Pi SDK installation');
  const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(boot.agentDir, 'auth.json'),
    modelsPath: join(boot.agentDir, 'models.json'), refreshOnCreate: false });
  for (const item of boot.provider_configs) modelRuntime.registerProvider(item.provider, item.config);
  for (const modulePath of boot.native_provider_modules ?? []) {
    requireValue(typeof modulePath === 'string' && (modulePath.startsWith('file:') || isAbsolute(modulePath)),
      'PI_WORKER_PROVIDER_MODULE', 'Native provider modules need an absolute trusted Host location');
    const url = modulePath.startsWith('file:') ? new URL(modulePath) : pathToFileURL(modulePath);
    requireValue(url.protocol === 'file:' && isAbsolute(fileURLToPath(url)), 'PI_WORKER_PROVIDER_MODULE', 'Native provider modules must be trusted local Host resources');
    const module = await import(url.href);
    const providers = module.providers ?? (module.provider ? [module.provider] : null);
    requireValue(Array.isArray(providers) && providers.length > 0, 'PI_WORKER_PROVIDER_MODULE', 'A trusted native provider module exports provider or providers');
    for (const provider of providers) modelRuntime.registerNativeProvider(provider);
  }
  await modelRuntime.refresh({ allowNetwork: false });
  const registry = new sdk.ModelRegistry(modelRuntime);
  const manager = boot.main_identity.session_file
    ? sdk.SessionManager.open(boot.main_identity.session_file, undefined, boot.cwd)
    : { getSessionId: () => main_actor, getSessionFile: () => undefined };
  requireValue(manager.getSessionId() === main_actor, 'PI_WORKER_PARENT_IDENTITY', 'The captured Pi parent session has a different identity');
  const hostContext = { cwd: boot.cwd, sessionManager: manager, modelRegistry: registry,
    scopedModels: boot.catalog.map(item => ({ provider: item.provider, id: item.model_id })), isProjectTrusted: () => boot.project_trusted === true };
  const actual = availableModels(hostContext, ai.getSupportedThinkingLevels);
  const catalog = boot.catalog.map(item => {
    const matches = actual.filter(candidate => candidate.provider === item.provider && candidate.model_id === item.model_id);
    requireValue(matches.length === 1 && matches[0].fingerprint === item.fingerprint
      && canonicalJSON(matches[0].thinking_levels) === canonicalJSON(item.thinking_levels),
    'PI_WORKER_MODEL_CHANGED', `The captured Pi child model contract is unavailable or changed: ${item.provider}/${item.model_id}; expected ${item.fingerprint}, observed ${matches.map(candidate => candidate.fingerprint).join(',') || 'unavailable'}; expected thinking ${item.thinking_levels.join(',')}, observed ${matches.map(candidate => candidate.thinking_levels.join(',')).join(';') || 'unavailable'}`,
    { provider: item.provider, model_id: item.model_id });
    return structuredClone(item);
  });
  const host = new PiSdkHost({ sdk, Type: ai.Type, supportedThinking: ai.getSupportedThinkingLevels,
    agentDir: boot.agentDir, getContext: () => hostContext,
    getMcpServers: () => structuredClone(boot.registered_mcp_servers), sessionDirectory: join(boot.agentDir, 'sessions') });
  host.catalog = () => structuredClone(catalog);
  host.mainIdentity = () => structuredClone(boot.main_identity);
  const lifetime = pending(), waiters = new Set(), operations = new Map(), remoteTasks = new Set();
  let bridge = context.parent_bridge ?? null, service, stopped = false, stopping = false, completed = false, monitor, checking = false, pendingCalls = 0;
  const observer = createWorkerObserver({ run_id, report: outcome => context.report(outcome), active: () => !stopped,
    send: event => {
      requireValue(bridge, 'PI_PARENT_NOTIFICATION_UNAVAILABLE', 'Original Pi parent is detached; its exact notification is queued');
      return ownerRpc(bridge, 'notify', { event });
    }, settle: outcome => { completed = true; lifetime.resolve(outcome); } });
  const validateBridge = value => {
    requireValue(value?.url && value.token && value.main_actor === main_actor && value.run_id === run_id,
      'PI_PARENT_MAIN_IDENTITY', 'Reattach the original Pi Main actor and exact detached Run');
    return value;
  };
  if (bridge) validateBridge(bridge);
  const waitForBridge = async signal => {
    await context.assertAuthority();
    let error;
    if (bridge) {
      try {
        const identity = await ownerRpc(bridge, 'main_identity', {}, { timeoutMs: 5000, signal });
        requireValue(identity.session_id === main_actor, 'PI_PARENT_MAIN_IDENTITY', 'The live Main bridge is attached to another Pi conversation');
        return bridge;
      } catch (cause) {
        if (signal?.aborted) throw remoteError(cause, signal);
        error = diagnostic(cause); bridge = null;
      }
    }
    await observer.record({ run_id, status: 'waiting_parent', main_actor, stop_reason: 'parent_main_bridge_required', ...(error ? { error } : {}) });
    const waiter = pending(); waiters.add(waiter);
    const abort = () => waiter.reject(Object.assign(new Error('Main was cancelled before its parent reattached'), { code: 'PI_TASK_ABORTED' }));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    try { return await waiter.promise; }
    finally { waiters.delete(waiter); signal?.removeEventListener('abort', abort); }
  };
  host.createMainTask = async request => {
    const signal = request.signal ? AbortSignal.any([request.signal, context.signal]) : context.signal;
    const target = await waitForBridge(signal), operation_id = randomUUID(), task_handle = randomUUID();
    const { signal: _signal, onOperation, authorize, validateResult, prepareRuntimeEnvironment: _prepare, ...packet } = request;
    if (validateResult) packet.validate_result_required = true;
    operations.set(operation_id, { onOperation, authorize, validateResult });
    const entry = { target, task_handle, operation_id, closed: false, completion: null, abortCompletion: null };
    remoteTasks.add(entry);
    const command = async (operation, args = {}, options = {}) => {
      try { return await ownerRpc(target, operation, { task_handle, ...args }, options); }
      catch (error) { throw remoteError(error, options.signal, true); }
    };
    let identity;
    try {
      await context.assertAuthority();
      identity = await command('create_main_task', { request: packet, main_actor, operation_id, owner_descriptor: context.owner_descriptor }, { timeoutMs: 0, signal });
      requireValue(identity.task_handle === task_handle,'PI_PARENT_MAIN_IDENTITY','The parent Main bridge returned a different task');
      assertMainTaskIdentity(identity,main_actor,request.context_mode ?? (request.strict ? 'isolated' : 'current'));
    } catch (error) { throw remoteError(error, signal); }
    return { session_id: identity.session_id, ...(identity.session_file ? { session_file: identity.session_file } : {}),
      ...(identity.context_mode ? {context_mode:identity.context_mode,main_actor:identity.main_actor,observed_model:identity.observed_model} : {}),
      async run({ prompt, schema, signal: dispatchSignal }) {
        requireValue(!entry.closed && !entry.completion, 'PI_PARENT_MAIN_REPLAY', 'The exact Main dispatch is closed or has already run');
        await context.assertAuthority();
        const combined = dispatchSignal ? AbortSignal.any([dispatchSignal, context.signal]) : context.signal;
        const abort = () => {
          entry.abortCompletion = command('abort_main_task');
          void entry.abortCompletion.catch(() => {});
        };
        combined.addEventListener('abort', abort, { once: true });
        if (combined.aborted) abort();
        try {
          entry.completion = command('run_main_task', { prompt, schema }, { timeoutMs: 0, signal: combined });
          return await entry.completion;
        } catch (error) { throw remoteError(error, combined); }
        finally { combined.removeEventListener('abort', abort); if (entry.abortCompletion) await entry.abortCompletion; }
      },
      async abort() { await command('abort_main_task'); },
      async close() {
        if (entry.closed) return;
        const result = await command('close_main_task', {}, { timeoutMs: 0 });
        requireValue(result?.quiescent === true, 'PI_PARENT_MAIN_SHUTDOWN', 'The original Pi Main task has not confirmed shutdown');
        entry.closed = true; operations.delete(operation_id); remoteTasks.delete(entry);
      },
    };
  };
  const closeNative = host.close.bind(host);
  const domain = createRemoteHostTools({ descriptors: boot.external_host_tools ?? [], run_id, main_actor,
    owner_descriptor: context.owner_descriptor, waitForBridge, assertAuthority: context.assertAuthority, operations });
  host.getHostTools = () => domain.registry;
  host.close = async () => {
    const results = await Promise.allSettled([closeNative(), domain.close(), ...[...remoteTasks].map(async entry => {
      const result = await ownerRpc(entry.target, 'close_main_task', { task_handle: entry.task_handle }, { timeoutMs: 0 });
      requireValue(result?.quiescent === true, 'PI_PARENT_MAIN_SHUTDOWN', 'Detached Main shutdown remains unconfirmed');
      entry.closed = true; operations.delete(entry.operation_id); remoteTasks.delete(entry);
    })]);
    const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (failures.length) throw new AggregateError(failures, 'Detached Pi tasks have not confirmed quiescence');
  };
  try {
    service = await new PiCawService({ directory: boot.directory, host, workerMode: true,
      notify: outcome => completed || stopped || stopping ? Promise.resolve() : observer.observe(outcome), beforeRunPurge: outcome => observer.record(outcome).then(() => undefined) }).initialize();
    await context.assertAuthority();
    markDispatched();
    await service.launchDriver(run_id, boot.driver_options ?? {});
    // Human acceptance and controller calls can settle the durable Run after a
    // driver has paused. Keep the owner alive at every nonterminal boundary.
    monitor = setInterval(() => {
      if (stopped || completed || checking || pendingCalls || terminal.has(observer.current().status)) return;
      checking = true;
      void service.runtime.runs.read(run_id).then(async record => {
        if (!pendingCalls && terminal.has(record.state.status)) return observer.observe(await service.enrichNotification({ run_id, status: record.state.status, sequence: record.sequence }));
      }).catch(error => { if (!stopped && !completed) lifetime.reject(error); }).finally(() => { checking = false; });
    }, 500);
  } catch (error) {
    try {
      if (service) await service.close(); else await host.close();
      requireValue(host.tasks.size === 0 && remoteTasks.size === 0 && (!service || service.active.size === 0),
        'PI_WORKER_SHUTDOWN', 'Failed bootstrap retains an owned effect producer');
      Object.assign(error, { quiescent: true, shutdown_reason: 'pi_bootstrap_cleanup_confirmed' });
    } catch (cleanupError) { throw Object.assign(new AggregateError([error, cleanupError], 'Pi worker startup and shutdown failed'), { quiescent: false }); }
    throw error;
  }
  return {
    completion: lifetime.promise,
    async call(operation, args = {}) {
      await context.assertAuthority();
      requireValue(!stopped, 'PI_WORKER_STOPPED', 'The detached owner has stopped');
      if (operation === 'main_authorize' || operation === 'main_operation' || operation === 'main_validate_result') {
        requireValue(operations.has(args.operation_id), 'PI_PARENT_MAIN_CALLBACK', 'Tool evidence belongs to an unknown Main dispatch');
        const callback = operations.get(args.operation_id)[operation === 'main_authorize' ? 'authorize' : operation === 'main_validate_result' ? 'validateResult' : 'onOperation'];
        requireValue(typeof callback === 'function', 'PI_PARENT_MAIN_CALLBACK', 'The Main task has no durable tool evidence callback');
        await callback(operation === 'main_validate_result' ? args.result : args.metadata);
        return operation === 'main_authorize' ? { authorized: true } : operation === 'main_validate_result' ? { validated: true } : { recorded: true };
      }
      if (operation === 'host_tool_authorize') {
        const callback = operations.get(args.operation_id)?.authorize;
        requireValue(typeof callback === 'function', 'PI_EXTERNAL_HOST_CALLBACK', 'Domain authorization belongs to an unknown exact attempt');
        await callback(args); return { authorized: true };
      }
      requireValue(operation === 'service_call' && typeof args.operation === 'string', 'PI_WORKER_OPERATION', 'Use an authenticated service_call envelope');
      if (args.operation === 'continue' && waiters.size > 0 && service.active.has(run_id))
        return { run_id, status: 'waiting_parent', background: true, main_actor };
      pendingCalls++;
      try {
        const result = await service.call(args.operation, args.args ?? {}, { human: args.options?.human === true, signal: context.signal });
        if (result?.authoring_cleanup) await observer.observe(await service.enrichNotification({ run_id: args.args.run_id, status: 'succeeded',
          workflow_id: result.workflow.id, revision_hash: result.revision_hash, authoring_cleanup: result.authoring_cleanup }));
        return result;
      }
      catch (error) {
        if (error.code === 'AUTHORING_PURGE_INCOMPLETE') await observer.record({ run_id: args.args?.run_id, status: 'succeeded',
          publication: 'accepted_cleanup_incomplete', deployed_workflow_id: error.deployed_workflow_id,
          deployed_revision: error.deployed_revision, error: diagnostic(error) });
        throw error;
      }
      finally { pendingCalls--; }
    },
    async reattach(value) {
      await context.assertAuthority(); bridge = validateBridge(value);
      await observer.flush();
      await observer.record({ ...observer.current(), ...(waiters.size ? { status: 'running' } : {}), main_actor, parent_reattached: true });
      for (const waiter of waiters) waiter.resolve(bridge);
      return { reattached: true, main_actor };
    },
    async stop(reason) {
      // Journal terminal state fences authority before all producers necessarily
      // close. Drain the exact owned tasks before publishing release evidence.
      stopping = true; clearInterval(monitor);
      let outcome = observer.current();
      const terminalObserved = terminal.has(outcome.status);
      if (!terminal.has(outcome.status) && ['execution_settled', 'cancelled'].includes(reason)) {
        const record = await service.runtime.runs.read(run_id);
        requireValue(terminal.has(record.state.status), 'PI_WORKER_TERMINAL', 'Settled owner needs exact durable terminal Run evidence');
        outcome = await service.enrichNotification({ run_id, status: record.state.status, sequence: record.sequence });
      }
      for (const waiter of waiters) waiter.reject(Object.assign(new Error(`Detached Pi owner stopped: ${reason}`), { code: 'PI_TASK_ABORTED' }));
      await service.close();
      requireValue(host.tasks.size === 0 && remoteTasks.size === 0 && service.active.size === 0,
        'PI_WORKER_SHUTDOWN', 'Detached Pi tasks or drivers have not confirmed quiescence');
      if (terminal.has(outcome.status) && (!terminalObserved || outcome.ownership_released !== true)) await observer.observe(await service.enrichNotification({ ...outcome,
        shutdown: { source: 'pi-worker-stop', run_id, main_actor, quiescent: true } }));
      stopped = true;
      return { quiescent: true };
    },
  };
}
