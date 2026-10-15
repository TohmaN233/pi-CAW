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
  let pendingProgram = null;
  async function observeProgramEffects() {
    if (!pendingProgram) return;
    const { before, tool, call_id, process_id } = pendingProgram;
    let after;
    try { after = await captureWorkspaceSnapshot(request.workspace); }
    catch (cause) {
      scopeError = Object.assign(new Error(`Program effect verification failed: ${cause.message}`, { cause }), { code: 'PI_PROGRAM_SCOPE_UNOBSERVED' });
      throw scopeError;
    }
    pendingProgram = null;
    const effects = workspaceEffects(before, after, request.access === 'bounded_write' ? request.allowed_paths : []);
    for (const path of effects.changed_paths) if (!mutations.has(path)) mutations.set(path, { absolute: join(request.workspace, path), before: before.get(path) ?? null });
    if (effects.outside_paths.length) scopeError = Object.assign(new Error(`Task program changed paths outside its grant: ${effects.outside_paths.join(', ')}`), { code: 'PI_PROGRAM_SCOPE' });
    await request.onOperation?.({ tool, call_id, ...(process_id ? { process_id } : {}), phase: 'effects', ...effects });
    if (scopeError) throw scopeError;
  }
  async function onOperation(metadata) {
    if (['run_task_program', 'run_workspace_program'].includes(metadata.tool)) {
      if (metadata.phase === 'started') {
        requireValue(!pendingProgram, 'PI_PROGRAM_ACTIVE', 'Previous task program effects have not settled');
        pendingProgram = { before: await captureWorkspaceSnapshot(request.workspace), tool: metadata.tool,
          call_id: metadata.call_id, process_id: metadata.process_id };
      } else if (metadata.phase === 'completed' || metadata.phase === 'failed' && metadata.quiescent === true) {
        await observeProgramEffects();
      }
    }
    await request.onOperation?.(metadata);
  }
  const resources = await Promise.all((request.resources ?? []).map(async item => {
    const bytes = await readFile(item.object_path);
    requireValue(digest(bytes) === item.sha256, 'PI_RESOURCE_DRIFT', 'Task resource changed before its tools were built');
    return { ...item, bytes };
  }));
  const broker = await createPiToolBroker({ workspace: request.workspace, access: request.access,
    allowedPaths: request.allowed_paths, resources, runtimeEnvironment: request.runtime_environment,
    executionBinding: request.execution_binding,
    ...(request.program_output_directory?{programOutputDirectory:request.program_output_directory,retainProgramOutput:true}:{}),
    prepareRuntimeEnvironment: request.prepareRuntimeEnvironment,
    inputRoots: request.task_root ? [{ name: 'task_root', path: request.task_root }] : [],
    authorize, onOperation, recoverToolErrors: true });
  return {
    tools: () => broker.tools(), revoke: () => broker.revoke(),
    assertScope() {
      if (scopeError) throw scopeError;
      requireValue(!pendingProgram && broker.isQuiescent(), 'PI_PROGRAM_ACTIVE', 'Wait for the task program and its effect observation before submitting a result');
    },
    async close() {
      const stopped = await broker.quiesce();
      requireValue(stopped.quiescent, 'PI_PROGRAM_STOP_UNCONFIRMED', 'Task program is not quiescent');
      await observeProgramEffects();
      if (scopeError) throw scopeError;
      if (stopped.error && stopped.error.code !== 'PI_EXECUTION_CANCELLED') throw stopped.error;
    },
    async execute(name, params, callId) {
      if (scopeError) throw scopeError;
      if (['write_workspace', 'materialize_workflow_resource'].includes(name)) {
        const target = await writablePath(request.workspace, name === 'materialize_workflow_resource' ? params.destination : params.path,
          request.access, request.allowed_paths);
        await observeMutation(target, mutations);
      }
      let result, error;
      try { result = await broker.call(name, params, callId); } catch (cause) { error = cause; }
      if (scopeError) throw scopeError;
      if (error) throw error;
      requireValue(result?.success === true, 'PI_TASK_TOOL_FAILED', result?.contentItems?.[0]?.text ?? 'Pi task tool failed');
      return { content: result.contentItems.map(item => ({ type: 'text', text: item.text })), details: { kind: 'pi-caw-broker', tool: name } };
    },
  };
}
