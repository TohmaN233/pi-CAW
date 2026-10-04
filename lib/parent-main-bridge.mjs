import { randomUUID } from 'node:crypto';
import { requireValue } from '../core/workflow-paths.mjs';
import { canonicalJSON } from '../core/workflow-revisions.mjs';
import { createOwnerRpcServer, ownerRpc } from './detached-owner.mjs';
import { createExternalHostToolBridge } from './external-host-tools.mjs';
import {assertMainTaskIdentity} from './main-context.mjs';

// The detached owner delegates Main to its original, live Pi chat. Bridge handles
// identify RPC ownership only; all session and turn evidence comes from Pi.
export async function createParentMainBridge({ host, run_id, main_actor, emitOperation, notify, getHostTools = () => host.getHostTools?.() ?? {} }) {
  requireValue(host && typeof host.createMainTask === 'function' && typeof run_id === 'string' && run_id
    && typeof main_actor === 'string' && main_actor, 'PI_PARENT_MAIN_CONTEXT', 'Parent Main bridge needs an exact Run and Pi actor');
  const tasks = new Map(); let closing = false;
  const authority = () => {
    requireValue(!closing, 'PI_PARENT_MAIN_CLOSED', 'The parent Main bridge is closed');
    requireValue(host.mainIdentity().session_id === main_actor, 'PI_MAIN_SESSION_CHANGED', 'Detached Main cannot move to another Pi conversation');
  };
  authority();
  const domain = createExternalHostToolBridge({ run_id, main_actor, authority, getHostTools });
  const lookup = args => {
    const entry = tasks.get(args.task_handle);
    requireValue(entry, 'PI_PARENT_MAIN_TASK', 'No exact parent Main task matches this bridge handle');
    return entry;
  };
  const closeTask = entry => entry.closePromise ??= (async () => {
    entry.controller.abort();
    // A rejected create never acquired Main. A fulfilled create must confirm
    // its own broker/turn shutdown before this bridge reports quiescence.
    const [created] = await Promise.allSettled([entry.creation]);
    if (created.status === 'fulfilled') await (host.releaseTask ? host.releaseTask(created.value) : created.value.close());
    if (entry.running) await Promise.allSettled([entry.running]);
    entry.closed = true;
    return { quiescent: true };
  })();
  const server = await createOwnerRpcServer({ run_id, owner_id: randomUUID(), handle: async (operation, args) => {
    if (operation === 'execute_host_tool' || operation === 'cancel_host_tool') return domain.call(operation, args);
    // Teardown addresses an already acquired task object. A session switch
    // revokes new execution, but must not prevent that old broker from closing.
    if (operation === 'abort_main_task' || operation === 'close_main_task') {
      const entry = lookup(args);
      if (operation === 'close_main_task') return closeTask(entry);
      entry.controller.abort();
      const [created] = await Promise.allSettled([entry.creation]);
      if (created.status === 'fulfilled' && !entry.closed) await created.value.abort();
      return { abort_requested: true };
    }
    authority();
    if (operation === 'main_identity') return host.mainIdentity();
    if (operation === 'notify') {
      requireValue(typeof notify === 'function', 'PI_PARENT_NOTIFY_UNAVAILABLE', 'The parent Pi notification bridge is unavailable');
      await notify(args.event); return { delivered: true };
    }
    if (operation === 'create_main_task') {
      requireValue(typeof args.task_handle === 'string' && /^[a-f0-9-]{36}$/.test(args.task_handle)
        && args.request?.kind === 'main' && typeof args.request.run_id === 'string'
        && args.main_actor === main_actor && typeof args.operation_id === 'string'
        && args.owner_descriptor?.url && args.owner_descriptor?.token,
      'PI_PARENT_MAIN_REQUEST', 'Parent Main creation needs an exact actor, task packet and owner callback');
      const signature = canonicalJSON(args);
      const previous = tasks.get(args.task_handle);
      if (previous) {
        requireValue(previous.signature === signature && !previous.closed, 'PI_PARENT_MAIN_REPLAY', 'This bridge handle already belongs to another or closed task');
        const task = await previous.creation; return { task_handle: args.task_handle, session_id: task.session_id, session_file: task.session_file,
          ...(task.context_mode ? {context_mode:task.context_mode,main_actor:task.main_actor,observed_model:task.observed_model} : {}) };
      }
      const entry = { signature, controller: new AbortController(), creation: null, running: null, closed: false };
      tasks.set(args.task_handle, entry);
      entry.creation = Promise.resolve().then(() => host.createMainTask({ ...args.request, signal: entry.controller.signal,
        ...(args.request.validate_result_required ? {validateResult: async result => {
          authority();
          requireValue(!entry.closed && !entry.controller.signal.aborted, 'PI_TASK_ABORTED', 'Main result authority was revoked');
          const response = await ownerRpc(args.owner_descriptor, 'main_validate_result', {operation_id: args.operation_id, result});
          requireValue(response?.validated === true, 'PI_PARENT_MAIN_VALIDATION', 'The exact detached attempt did not validate this semantic result');
        }} : {}),
        authorize: async () => {
          authority();
          const result = await ownerRpc(args.owner_descriptor, 'main_authorize', { operation_id: args.operation_id });
          requireValue(result?.authorized === true, 'PI_PARENT_MAIN_AUTHORITY', 'The exact detached attempt did not authorize this Main tool effect');
        },
        onOperation: async metadata => {
          authority();
          await emitOperation?.(metadata);
          const result = await ownerRpc(args.owner_descriptor, 'main_operation', { operation_id: args.operation_id, metadata });
          requireValue(result?.recorded === true, 'PI_PARENT_MAIN_EVIDENCE', 'The detached owner did not acknowledge exact Main operation evidence');
        },
      }));
      // The create requester observes failures; close still needs that promise.
      void entry.creation.catch(() => {});
      const task = await entry.creation;
      assertMainTaskIdentity(task,main_actor,args.request.context_mode ?? (args.request.strict ? 'isolated' : 'current'));
      return { task_handle: args.task_handle, session_id: task.session_id, ...(task.session_file ? { session_file: task.session_file } : {}),
        ...(task.context_mode ? {context_mode:task.context_mode,main_actor:task.main_actor,observed_model:task.observed_model} : {}) };
    }
    const entry = lookup(args);
    requireValue(operation === 'run_main_task', 'PI_PARENT_MAIN_OPERATION', 'Unknown parent Main bridge operation');
    requireValue(!entry.closed && !entry.running && !entry.controller.signal.aborted,
      'PI_PARENT_MAIN_REPLAY', 'The exact parent Main task has already run or been revoked');
    const task = await entry.creation; authority();
    requireValue(!entry.closed && !entry.running && !entry.controller.signal.aborted,
      'PI_PARENT_MAIN_REPLAY', 'The exact parent Main task has already run or been revoked');
    // Reserve the single dispatch before calling the Host. Pi Main can throw
    // synchronously, which must still leave this exact handle consumed.
    entry.running = Promise.resolve().then(() => task.run({ prompt: args.prompt, schema: args.schema, signal: entry.controller.signal }));
    return entry.running;
  } });
  const descriptor = Object.freeze({ ...server.descriptor, main_actor });
  return { ...descriptor, descriptor, async close() {
    closing = true;
    const results = await Promise.allSettled([domain.close(), ...[...tasks.values()].map(closeTask)]);
    await server.close();
    const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (failures.length) throw new AggregateError(failures, 'Parent Main shutdown is unconfirmed');
    return { quiescent: true };
  } };
}
