import { readdir, readFile, access } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = resolve(import.meta.dirname, '..');
const failures = [];
async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['.git', 'node_modules', '.artifacts'].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) { await visit(path); continue; }
    if (!entry.name.endsWith('.mjs')) continue;
    const checked = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
    if (checked.status !== 0) failures.push(checked.stderr);
    const body = await readFile(path, 'utf8');
    if (path.includes(join(root, 'core')) || path.includes(join(root, 'lib'))) {
      for (const match of body.matchAll(/(?:from\s*|import\s*\()(['"])(\.[^'"]+)\1/g)) {
        try { await access(resolve(dirname(path), match[2])); } catch { failures.push(`Missing module ${match[2]} in ${path}`); }
      }
      if (/gpt-\d|native-(?:luna|sol|astra)|grok_acp|cursor_cdp|codex-app-server-client/.test(body)) failures.push(`Retired runtime/model dependency: ${path}`);
    }
  }
}
await visit(root);
await import('../lib/service.mjs');
if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1; }
else console.log('Syntax, module closure, Pi service imports and retired-runtime checks passed.');
