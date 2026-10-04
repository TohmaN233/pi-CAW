import {requireValue} from '../core/workflow-paths.mjs';

export function mainContextChoice(value = 'auto') {
  requireValue(['auto','current','isolated'].includes(value), 'PI_MAIN_CONTEXT', 'Main context must be auto, current or isolated');
  return value;
}

export function mainContextMode(policy, choice = 'auto') {
  mainContextChoice(choice);
  requireValue(policy.mode !== 'strict' || choice !== 'current', 'PI_MAIN_CONTEXT', 'A declared strict node requires isolated Main context');
  return policy.mode === 'strict' || choice === 'isolated' ? 'isolated' : 'current';
}

/** The logical actor is stable; an isolated execution has its own actual Pi journal. */
export function assertMainTaskIdentity(task, actor, mode) {
  requireValue(mode === 'isolated'
    ? task?.context_mode === 'isolated' && task.main_actor === actor && typeof task.session_id === 'string' && task.session_id !== actor
    : task?.session_id === actor,
  'PI_PARENT_MAIN_IDENTITY', 'The Main task does not match its original actor and selected context mode');
}
