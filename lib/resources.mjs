import { readFile } from 'node:fs/promises';
import { digest } from '../core/workflow-revisions.mjs';
import { requireValue } from '../core/workflow-paths.mjs';
export async function readPinnedResource(resources, { path, start_line, end_line }) {
  const item = resources.find(item => item.path === path);
  requireValue(item, 'PI_RESOURCE_NOT_DECLARED', 'Resource is not declared in this task');
  const bytes = await readFile(item.object_path);
  requireValue(digest(bytes) === item.sha256, 'PI_RESOURCE_DRIFT', 'Pinned resource bytes changed');
  const text = bytes.toString('utf8');
  requireValue(Buffer.from(text).equals(bytes), 'PI_RESOURCE_BINARY', 'Resource is not UTF-8 text; it cannot be transported through the text reader');
  const lines = text.split('\n');
  let content = text;
  if (start_line !== undefined || end_line !== undefined) {
    requireValue(Number.isSafeInteger(start_line) && Number.isSafeInteger(end_line) && start_line >= 1
      && end_line >= start_line && end_line <= lines.length && end_line - start_line < 200,
      'PI_RESOURCE_RANGE', 'Choose an explicit range of at most 200 lines within the resource');
    content = lines.slice(start_line - 1, end_line).join('\n');
  }
  requireValue(Buffer.byteLength(content) <= 32768, 'PI_RESOURCE_SIZE', 'Resource read exceeds 32 KiB; request an explicit smaller start_line/end_line range');
  return { path, sha256: item.sha256, content, start_line: start_line ?? 1, end_line: end_line ?? lines.length,
    total_lines: lines.length, complete: start_line === undefined || start_line === 1 && end_line === lines.length };
}
