import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createPiToolBroker } from './host-tools.mjs';
import { digest } from '../core/workflow-revisions.mjs';
import { requireValue } from '../core/workflow-paths.mjs';
import { captureWorkspaceSnapshot, workspaceEffects } from '../core/execution/workflow-resource-program.mjs';
import { writablePath, observeMutation } from './scope.mjs';

// Shared tool lane for native Pi children and the existing chat's Main.
// Transport never changes the resource pins, write grant or effect evidence.
export async function scopedTaskBroker(request, mutations, authorize) {
  let scopeError = null;
  const resources = await Promise.all((request.resources ?? []).map(async item => {
    const bytes = await readFile(item.object_path);
    requireValue(digest(bytes) === item.sha256, 'PI_RESOURCE_DRIFT', 'Task resource changed before its tools were built');
    return { ...item, bytes };
  }));
  const broker = await createPiToolBroker({ workspace: request.workspace, access: request.access,
    allowedPaths: request.allowed_paths, resources, runtimeEnvironment: request.runtime_environment,
    executionBinding: request.execution_binding,
    prepareRuntimeEnvironment: request.prepareRuntimeEnvironment,
    inputRoots: request.task_root ? [{ name: 'task_root', path: request.task_root }] : [],
    authorize, onOperation: metadata => request.onOperation?.(metadata), recoverToolErrors: true });
  return {
    tools: () => broker.tools(), revoke: () => broker.revoke(),
    assertScope() { if (scopeError) throw scopeError; },
    async close() {
      const stopped = await broker.quiesce();
      requireValue(stopped.quiescent, 'PI_PROGRAM_STOP_UNCONFIRMED', 'Task program is not quiescent');
      if (stopped.error && stopped.error.code !== 'PI_EXECUTION_CANCELLED') throw stopped.error;
    },
    async execute(name, params, callId) {
      if (scopeError) throw scopeError;
      let before;
      if (name === 'run_task_program') before = await captureWorkspaceSnapshot(request.workspace);
      if (['write_workspace', 'materialize_workflow_resource'].includes(name)) {
        const target = await writablePath(request.workspace, name === 'materialize_workflow_resource' ? params.destination : params.path,
          request.access, request.allowed_paths);
        await observeMutation(target, mutations);
      }
      let result, error;
      try { result = await broker.call(name, params, callId); } catch (cause) { error = cause; }
      if (before) {
        let after;
        try { after = await captureWorkspaceSnapshot(request.workspace); }
        catch (cause) { scopeError = Object.assign(new Error(`Program effect verification failed: ${cause.message}`), { code: 'PI_PROGRAM_SCOPE_UNOBSERVED' }); throw scopeError; }
        const effects = workspaceEffects(before, after, request.access === 'bounded_write' ? request.allowed_paths : []);
        await request.onOperation?.({ tool: name, phase: 'effects', ...effects });
        for (const path of effects.changed_paths) if (!mutations.has(path)) mutations.set(path, { absolute: join(request.workspace, path), before: before.get(path) ?? null });
        if (effects.outside_paths.length) {
          scopeError = Object.assign(new Error(`Task program changed paths outside its grant: ${effects.outside_paths.join(', ')}`), { code: 'PI_PROGRAM_SCOPE' });
          throw scopeError;
        }
      }
      if (error) throw error;
      requireValue(result?.success === true, 'PI_TASK_TOOL_FAILED', result?.contentItems?.[0]?.text ?? 'Pi task tool failed');
      return { content: result.contentItems.map(item => ({ type: 'text', text: item.text })), details: { kind: 'pi-caw-broker', tool: name } };
    },
  };
}
