import { lstat, readFile, rm, readdir, rmdir } from 'node:fs/promises';
import { resolve, relative, isAbsolute, sep, dirname, join } from 'node:path';
import { noSymlinks, requireValue, resourcePath, insideRoot } from '../core/workflow-paths.mjs';
import { digest } from '../core/workflow-revisions.mjs';

export const executionSessionRoot = directory => resolve(directory, 'execution-sessions');
export function executionSessionDirectory(root, runId) {
  requireValue(typeof runId === 'string' && /^[a-zA-Z0-9._-]{1,160}$/.test(runId), 'PI_SESSION_RUN', 'Execution storage requires a portable Run identity');
  return insideRoot(root, join(root, resourcePath(runId)));
}
export function containsSession(root, path) {
  if (!root) return false;
  const rel = relative(resolve(root), resolve(path));
  return !!rel && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
}
// A persisted cleanup intent binds the original bytes, not merely a filename.
export async function sessionCleanupIntent(root, receipt, { run_id, privateSession = false } = {}) {
  const path = insideRoot(root, receipt.session_file);
  let stat;
  try { await noSymlinks(path); stat = await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  requireValue(stat.isFile() && stat.nlink === 1, 'RUN_SESSION_FILE', 'Execution session must be a regular unlinked file');
  const data = await readFile(path), entries = data.toString('utf8').trim().split('\n').map(JSON.parse);
  requireValue(entries[0]?.type === 'session' && typeof receipt.thread_id === 'string' && entries[0].id === receipt.thread_id,
    'RUN_SESSION_IDENTITY', 'Execution JSONL header differs from the exact closed receipt');
  const task = entries.find(entry => entry.type === 'custom' && entry.customType === 'pi-caw:task')?.data;
  if (task?.kind === 'thread') return null;
  if(task)requireValue(task.run_id===run_id,'RUN_SESSION_BINDING','Execution session belongs to another Run');
  if (privateSession) requireValue(task?.run_id === run_id && ['isolated_main','subagent'].includes(task.kind),
    'RUN_SESSION_BINDING', 'Private execution session differs from its Run or lifetime');
  return { path, sha256: digest(data), bytes: stat.size };
}
export async function deleteSessionIntent(root, file) {
  insideRoot(root, file.path);
  try {
    await noSymlinks(file.path); const stat = await lstat(file.path);
    requireValue(stat.isFile() && stat.nlink === 1, 'RUN_SESSION_CHANGED', 'Execution session is no longer a regular unlinked file');
    const data=await readFile(file.path);
    requireValue(digest(data) === file.sha256,
      'RUN_SESSION_CHANGED', 'Execution session changed since cleanup intent');
    // Old cleanup summaries may predate persistent-thread protection.
    if(data.toString('utf8').trim().split('\n').map(JSON.parse).some(entry=>entry.type==='custom' && entry.customType==='pi-caw:task' && entry.data?.kind==='thread')) {
      console.info('[pi-CAW] persistent thread retained',{path:file.path});return 0;
    }
    await rm(file.path); return stat.size;
  } catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
}
export async function removeEmptySessionDirectory(root, path) {
  const directory = dirname(path);
  if (!containsSession(root, directory)) return;
  try { await noSymlinks(directory); if (!(await readdir(directory)).length) await rmdir(directory); }
  catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY') throw error; }
}
