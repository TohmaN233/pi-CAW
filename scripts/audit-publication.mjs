import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
const privatePath = /(?:^|\/)(?:node_modules|\.artifacts|\.pi|\.learning-harness-data|sessions)(?:\/|$)|(?:^|\/)(?:auth|models)\.json$|(?:^|\/)\.env(?:\.|$)|\.(?:jsonl|sqlite|db|log|tgz)$/i;
const patterns = [
  ['credential', /(?:sk-[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{40,}|AKIA[A-Z0-9]{16}|AIza[0-9A-Za-z_-]{35})/],
  ['private-key', /BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY/],
  ['personal-home-path', /[A-Z]:[\\/]Users[\\/][^\s\\/"'<>]+[\\/]|\/(?:home|Users)\/[a-z0-9._-]+\//i],
  ['local-session-link', /https?:\/\/(?:localhost|127(?:\.\d+){3})(?::\d+)?\/[^\s"'<>]*[?&](?:sessionId|session_id)=/i],
];
const findings = [];
const scan = (file, body, revision) => {
  const source = revision ? `${revision}:${file}` : file;
  if (privatePath.test(file)) findings.push({ file: source, kind: 'private-path' });
  for (const [kind, pattern] of patterns) if (pattern.test(body)) findings.push({ file: source, kind });
  if (file.startsWith('test/fixtures/') && /"tool"\s*:\s*"course_/.test(body)) findings.push({ file: source, kind: 'private-course-fixture' });
};
for (const file of files) {
  const body = await readFile(resolve(root, file), 'utf8');
  scan(file, body);
}
if (process.argv.includes('--history')) {
  const objects = execFileSync('git', ['rev-list', '--objects', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim().split('\n');
  for (const object of objects) {
    const space = object.indexOf(' ');
    if (space < 0) continue;
    const revision = object.slice(0, space), file = object.slice(space + 1);
    if (execFileSync('git', ['cat-file', '-t', revision], { cwd: root, encoding: 'utf8' }).trim() !== 'blob') continue;
    scan(file, execFileSync('git', ['cat-file', 'blob', revision], { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }), revision);
  }
}
const defaults = JSON.parse(await readFile(resolve(root, 'defaults/workflows/defaults.json'), 'utf8'));
const ids = defaults.map(item => item.workflow.id).sort();
if (JSON.stringify(ids) !== JSON.stringify(['system.build-workflow', 'system.skill2workflow'])) findings.push({ file: 'defaults/workflows/defaults.json', kind: 'unexpected-default-workflow' });
if (findings.length) {
  for (const finding of findings) console.error(`${finding.kind}: ${finding.file}`);
  process.exitCode = 1;
} else console.log(`Publication audit passed: ${files.length} tracked files; only the two portable authoring Workflows are shipped.`);
