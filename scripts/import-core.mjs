// Development-only, explicit source import. Never reads or writes user runtime stores.
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { resolve, dirname, relative, join } from 'node:path';
import { execFileSync } from 'node:child_process';
const source = resolve(process.argv[2]);
const target = resolve(import.meta.dirname, '..');
const sourceLib = join(source, 'plugins/codex-agents-workflow/control-plane/lib');
const roots = ['workflow-runtime.mjs', 'workflow-store.mjs', 'workflow-package.mjs', 'templates.mjs'];
const seen = new Set();
async function visit(path) {
  const absolute = resolve(sourceLib, path);
  if (!absolute.startsWith(sourceLib + '\\') && !absolute.startsWith(sourceLib + '/')) throw new Error('Import escapes source library');
  const key = relative(sourceLib, absolute).replaceAll('\\', '/');
  if (seen.has(key)) return;
  seen.add(key);
  const body = await readFile(absolute, 'utf8');
  for (const match of body.matchAll(/(?:from\s*|import\s*\()(['"])(\.[^'"]+)\1/g)) {
    await visit(relative(sourceLib, resolve(dirname(absolute), match[2])));
  }
  const destination = join(target, 'core', key);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, body);
}
for (const root of roots) await visit(root);
await copyFile(join(source, 'LICENSE'), join(target, 'LICENSE'));
await mkdir(join(target, 'docs'), { recursive: true });
await writeFile(join(target, 'docs/upstream.json'), JSON.stringify({
  repository: 'https://github.com/TohmaN233/codex-agents-workflow',
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim(),
  roots, files: [...seen].sort(),
  note: 'Portable graph/store/runtime source imported into a separate repository. Pi adapters and product configuration are independent.'
}, null, 2) + '\n');
console.log(`Imported ${seen.size} core modules`);
