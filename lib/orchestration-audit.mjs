import { readdir, lstat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { requireValue } from '../core/workflow-paths.mjs';

const key = path => process.platform === 'win32' ? path.toLowerCase() : path;
const within = (path, boundary) => boundary === '.' || key(path) === key(boundary) || key(path).startsWith(key(boundary) + '/');
// Cooperative observation, not an OS sandbox. Metadata captures native shell
// and helper writes without reading a whole repository into model context.
// Exact Host-owned session/state roots cannot count as product modifications.
export async function snapshotOrchestration(workspace, excludedRoots = []) {
  const files = new Map(), excluded = new Set(excludedRoots.map(path => key(resolve(path))));
  async function walk(directory) {
    for (const entry of await readdir(directory, {withFileTypes:true})) {
      const absolute = join(directory, entry.name);
      if (entry.name === '.git' && entry.isDirectory() || excluded.has(key(resolve(absolute)))) continue;
      const stat = await lstat(absolute, {bigint:true});
      const path = relative(workspace, absolute).replaceAll('\\', '/');
      if (stat.isDirectory()) await walk(absolute);
      else files.set(path, `${stat.mode}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`);
    }
  }
  await walk(workspace);
  return files;
}
export function orchestrationChanges(before, after, request) {
  const changed = [...new Set([...before.keys(), ...after.keys()])].filter(path => before.get(path) !== after.get(path)).sort();
  const outside = changed.filter(path => request.access !== 'bounded_write' || !request.allowed_paths.some(boundary => within(path, boundary)));
  requireValue(!outside.length, 'PI_ORCHESTRATION_SCOPE', 'Native orchestration changed files outside its node write grant', {changed_paths:changed, outside_paths:outside});
  return changed;
}
