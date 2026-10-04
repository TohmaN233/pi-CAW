import { readFile, lstat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { requireValue, noSymlinks } from '../core/workflow-paths.mjs';
import { digest } from '../core/workflow-revisions.mjs';
export async function writablePath(workspace, path, access, allowedPaths) {
  requireValue(typeof path === 'string' && path.length > 0 && !/[\x00-\x1f]/.test(path), 'PI_WRITE_PATH', 'Write target must be a path');
  requireValue(access === 'bounded_write', 'PI_READ_ONLY', 'This Pi task is read-only');
  const absolute = isAbsolute(path) ? resolve(path) : resolve(workspace, path);
  const key = value => process.platform === 'win32' ? value.toLowerCase() : value;
  const portable = relative(workspace, absolute).replaceAll('\\', '/');
  requireValue(portable && !isAbsolute(portable) && portable !== '..' && !portable.startsWith('../')
    && allowedPaths.some(root => root === '.' || key(portable) === key(root) || key(portable).startsWith(key(root) + '/')),
  'PI_WRITE_SCOPE', `Write target is outside this task grant: ${path}`);
  try { await noSymlinks(absolute); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  try { const info = await lstat(absolute); requireValue(info.nlink === 1 && info.isFile(), 'PI_WRITE_LINK', 'Write target must be a single-link regular file'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { absolute, portable };
}
async function fingerprint(path) {
  try { return digest(await readFile(path)); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export function scopedMutationTool(tool, request, mutations) {
  return { ...tool, executionMode: 'sequential', async execute(id, params, signal, update, context) {
    await request.authorize?.();
    const target = await writablePath(request.workspace, params.path, request.access, request.allowed_paths);
    await observeMutation(target, mutations);
    return tool.execute(id, { ...params, path: target.absolute }, signal, update, context);
  } };
}
export async function observeMutation(target, mutations) {
  if (!mutations.has(target.portable)) mutations.set(target.portable, { absolute: target.absolute, before: await fingerprint(target.absolute) });
}
export async function observedChanges(mutations) {
  const changed = [];
  for (const [path, entry] of mutations) if (entry.before !== await fingerprint(entry.absolute)) changed.push(path);
  return changed.sort();
}
