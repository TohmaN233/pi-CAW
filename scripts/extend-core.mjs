// Import additional portable editor/compiler modules without overwriting the
// independently maintained Pi runtime or reading any user configuration.
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { resolve, relative, dirname, join } from 'node:path';
const source = resolve(process.argv[2], 'plugins/codex-agents-workflow/control-plane/lib');
const target = resolve(import.meta.dirname, '../core');
const roots = ['workflow-editor.mjs', 'template-kind.mjs', 'workflow-routing.mjs',
  'skill-import/inventory.mjs', 'skill-import/folder-inventory.mjs', 'skill-import/source-status.mjs',
  'skill-import/inline-skill.mjs', 'skill-import/review-import.mjs', 'skill-import/generation.mjs',
  'parallel/worktree-manager.mjs', 'workflow-recovery.mjs', 'workflow-wait.mjs'];
const seen = new Set(), added = [];
async function visit(key) {
  key = key.replaceAll('\\', '/').replaceAll('codex-skill-policy.mjs', 'skill-policy.mjs');
  if (seen.has(key)) return;
  seen.add(key);
  const dest = resolve(target, key);
  if (!dest.startsWith(target + '\\') && !dest.startsWith(target + '/')) throw new Error('Import escapes target');
  try { await access(dest); return; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const sourceKey = key.replaceAll('skill-policy.mjs', 'codex-skill-policy.mjs');
  let body = await readFile(join(source, sourceKey), 'utf8');
  body = body.replaceAll('codex-skill-policy.mjs', 'skill-policy.mjs');
  for (const match of body.matchAll(/(?:from\s*|import\s*\()(['"])(\.[^'"]+)\1/g))
    await visit(relative(source, resolve(dirname(join(source, key)), match[2])));
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, body);
  added.push(key);
}
for (const root of roots) await visit(root);
console.log(JSON.stringify({ added }));
