import { requireValue } from './workflow-paths.mjs';

export const MAIN_EXECUTION_MODES = ['worker', 'orchestration'];
export function checkedMainMode(mode) {
  requireValue(MAIN_EXECUTION_MODES.includes(mode), 'MAIN_EXECUTION_MODE', 'Main mode must be worker or orchestration');
  return mode;
}
// A durable per-node selection wins. Old pinned Runs retain their original
// current/isolated contract; a new unannotated Main defaults to worker.
export function mainExecutionMode(node, policy, constraints = {}, workflowId) {
  const frozen = constraints.pi_caw_main_modes?.[workflowId]?.[node.id];
  let mode = frozen ?? node.executor?.mode;
  if (mode === undefined && Object.hasOwn(constraints, 'pi_caw_main_context')) {
    const legacy = constraints.pi_caw_main_context;
    requireValue(['auto', 'current', 'isolated'].includes(legacy), 'PI_MAIN_CONTEXT', 'Invalid historical Main context');
    mode = policy.mode === 'strict' || legacy === 'isolated' ? 'worker' : 'orchestration';
  }
  mode = checkedMainMode(mode ?? 'worker');
  requireValue(mode !== 'orchestration' || policy.mode === 'cooperative', 'MAIN_ORCHESTRATION_POLICY', 'Orchestration retains the current conversation and requires Cooperative execution');
  return mode;
}
export const mainContextForMode = mode => checkedMainMode(mode) === 'worker' ? 'isolated' : 'current';
