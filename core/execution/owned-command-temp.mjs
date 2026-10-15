import { mkdtemp, lstat, readFile, writeFile, rm } from 'node:fs/promises';
import { realpath } from 'node:fs';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, toNamespacedPath } from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonicalJSON, digest } from '../workflow-revisions.mjs';
import { noSymlinks, requireValue } from '../workflow-paths.mjs';

const physical = promisify(realpath.native);
const identity = stat => ({ dev: String(stat.dev), ino: String(stat.ino) });

// The base is a trusted Host/test setting, never model input. Only the unique
// sealed leaf is removable; an incomplete or changed owner retains evidence.
export async function prepareOwnedCommandTemp({ workspace, spool, brokerId = randomUUID(), base = tmpdir(), prefix = 'pi-command-temp-' }) {
  const configured = resolve(base), baseStat = await lstat(configured);
  requireValue(baseStat.isDirectory() && !baseStat.isSymbolicLink(), 'PI_COMMAND_TEMP_BASE', 'Command temporary base must be a physical directory');
  const parent = await physical(configured);
  // Windows mkdtemp needs the extended path form for deep Run/check stores.
  // Canonicalize its result before sealing so all ownership checks use one form.
  const allocated=await mkdtemp(toNamespacedPath(join(parent,prefix))),path=await physical(allocated);
  try {
    await noSymlinks(path);
    const initial = identity(await lstat(path, { bigint: true }));
    const canonicalWorkspace = await physical(resolve(workspace));
    const canonicalSpool = spool ? await physical(resolve(spool)) : path;
    const owner = { schema_version: 1, broker_id: brokerId, workspace: canonicalWorkspace, spool_root: canonicalSpool, path, identity: initial };
    const bytes = Buffer.from(canonicalJSON(owner)), marker = join(path, '.host-command-temp-owner.json');
    await writeFile(marker, bytes, { flag: 'wx', mode: 0o600 });
    const markerIdentity = identity(await lstat(marker, { bigint: true }));
    const summary = Object.freeze({ path, parent, broker_id: brokerId, workspace: canonicalWorkspace, spool_root: canonicalSpool, owner_sha256: digest(bytes), identity: initial });
    let closed = false;
    const assertOwned = async () => {
      try {
        requireValue(!closed, 'PI_COMMAND_TEMP_CLOSED', 'Command temporary owner was already closed');
        await noSymlinks(path); await noSymlinks(marker);
        const stat = await lstat(path, { bigint: true }), markerStat = await lstat(marker, { bigint: true });
        requireValue(stat.isDirectory() && canonicalJSON(identity(stat)) === canonicalJSON(initial)
          && markerStat.isFile() && markerStat.nlink === 1n && canonicalJSON(identity(markerStat)) === canonicalJSON(markerIdentity)
          && (await physical(path)) === path && (await readFile(marker)).equals(bytes),
        'PI_COMMAND_TEMP_OWNER', 'Command temporary ownership changed; retained for diagnosis');
      } catch (error) { throw Object.assign(error, { retained_at: path, temporary_parent: parent }); }
    };
    return { path, parent, summary, assertOwned, async close() {
      if (closed) return;
      await assertOwned();
      requireValue(dirname(path) === parent, 'PI_COMMAND_TEMP_OWNER', 'Command temporary leaf left its sealed parent', { retained_at: path });
      await rm(path, { recursive: true }); closed = true;
    } };
  } catch (error) { throw Object.assign(error, { retained_at: path, temporary_parent: parent }); }
}
