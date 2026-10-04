import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './fixtures.mjs';
import { readPinnedResource } from '../lib/resources.mjs';
import { digest } from '../core/workflow-revisions.mjs';

test('pinned resource reads verify exact bytes, ranges and UTF-8 without silently truncating data', async t => {
  const f = await fixture(t), path = join(f.root, 'resource');
  const bytes = Buffer.from('first\nsecond\nthird'); await writeFile(path, bytes);
  const pins = [{ path: 'doc.txt', sha256: digest(bytes), object_path: path }];
  const result = await readPinnedResource(pins, { path: 'doc.txt', start_line: 2, end_line: 2 });
  assert.equal(result.content, 'second'); assert.equal(result.complete, false);
  await assert.rejects(readPinnedResource(pins, { path: 'elsewhere' }), { code: 'PI_RESOURCE_NOT_DECLARED' });
  await writeFile(path, 'changed'); await assert.rejects(readPinnedResource(pins, { path: 'doc.txt' }), { code: 'PI_RESOURCE_DRIFT' });
  const binary = Buffer.from([0xff]); await writeFile(path, binary); pins[0].sha256 = digest(binary);
  await assert.rejects(readPinnedResource(pins, { path: 'doc.txt' }), { code: 'PI_RESOURCE_BINARY' });
});
