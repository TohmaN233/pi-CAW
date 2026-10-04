import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, link, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { writablePath } from '../lib/scope.mjs';
test('Pi write tools enforce read-only and exact grants before native mutation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-caw-scope-')); await mkdir(join(root, 'allowed'));
  t.after(async () => { assert(resolve(root).startsWith(resolve(tmpdir()))); await rm(root, { recursive: true }); });
  assert.equal((await writablePath(root, 'allowed/new.txt', 'bounded_write', ['allowed'])).portable, 'allowed/new.txt');
  await assert.rejects(writablePath(root, 'allowed/a.txt', 'read_only', ['allowed']), { code: 'PI_READ_ONLY' });
  await assert.rejects(writablePath(root, '../other.txt', 'bounded_write', ['.']), { code: 'PI_WRITE_SCOPE' });
  await assert.rejects(writablePath(root, 'allowed2/a.txt', 'bounded_write', ['allowed']), { code: 'PI_WRITE_SCOPE' });
  await writeFile(join(root, 'origin.txt'), 'original'); await link(join(root, 'origin.txt'), join(root, 'allowed/link.txt'));
  await assert.rejects(writablePath(root, 'allowed/link.txt', 'bounded_write', ['allowed']), { code: 'PI_WRITE_LINK' });
});
