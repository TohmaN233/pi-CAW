import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPiToolBroker } from '../lib/host-tools.mjs';
import { digest } from '../core/workflow-revisions.mjs';

async function fixture(t) {
  const workspace = await mkdtemp(join(tmpdir(), 'pi-program-broker-'));
  await mkdir(join(workspace, 'src'));
  await writeFile(join(workspace, 'src', 'main.txt'), 'before');
  await mkdir(join(workspace, '.pi'));
  await writeFile(join(workspace, '.pi', 'settings.json'), '{"secret":"not a task input"}');
  t.after(() => rm(workspace, { recursive: true, maxRetries: 3, retryDelay: 100 }));
  const operations = [];
  const options = {
    workspace,
    access: 'bounded_write',
    allowedPaths: ['src'],
    authorize: async () => {},
    onOperation: async event => operations.push(structuredClone(event)),
  };
  return { workspace, operations, options };
}

const value = result => JSON.parse(result.contentItems[0].text);
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function waitForFile(path, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { return await readFile(path, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await delay(10);
  }
  throw new Error(`Timed out waiting for ${path}`);
}

function runtimeEnvironment(tools) {
  return { status: 'ready', tools: tools.map(([name, path]) => ({ name, path, status: 'found' })) };
}

test('Pi broker runs only declared local programs and journals scoped file operations', async t => {
  const f = await fixture(t);
  const broker = await createPiToolBroker({ ...f.options, runtimeEnvironment: runtimeEnvironment([['node', process.execPath]]) });
  const descriptors = broker.tools();
  const program = descriptors.find(tool => tool.name === 'run_task_program');
  assert(program, 'a declared runtime executable should expose run_task_program');
  assert.deepEqual(program.inputSchema.properties.program.enum, ['node']);
  assert.equal(descriptors.some(tool => /shell/i.test(tool.name)), false, 'there is no implicit shell tool');

  const script = 'process.stdout.write(JSON.stringify({cwd:process.cwd(),arg:process.argv[1]}))';
  const result = value(await broker.call('run_task_program', {
    program: 'node', args: ['-e', script, 'argument with spaces'], cwd: 'workspace',
  }, 'node-local'));
  assert.equal(result.exit_code, 0);
  assert.deepEqual(JSON.parse(result.stdout), { cwd: f.workspace, arg: 'argument with spaces' });

  await broker.call('mkdir_workspace', { path: 'src/generated' }, 'mkdir-generated');
  await broker.call('write_workspace', {
    path: 'src/generated/result.txt', text: 'written by the scoped broker', expected_sha256: null,
  }, 'write-generated');
  assert.equal((await readFile(join(f.workspace, 'src', 'generated', 'result.txt'), 'utf8')), 'written by the scoped broker');
  assert.deepEqual(f.operations.filter(item => item.call_id === 'node-local').map(item => item.phase), ['started', 'completed']);
  assert.equal(f.operations.find(item => item.call_id === 'node-local' && item.phase === 'completed').exit_code, 0);
  assert.deepEqual(f.operations.filter(item => item.call_id === 'write-generated').map(item => item.phase), ['intent', 'committed']);
  const drained = await broker.quiesce();
  assert.equal(drained.quiescent, true);
  assert.equal(drained.error, null);
});

test('registered shell executables run only when the Host declares them', async t => {
  const f = await fixture(t);
  const broker = await createPiToolBroker({ ...f.options, runtimeEnvironment: runtimeEnvironment([['node', process.execPath]]) });
  assert.equal(broker.tools().some(tool => tool.name === 'run_task_program'), true);
  assert.equal(broker.tools().some(tool => tool.name === 'run_shell'), false);
  await broker.quiesce();

  const shellPath = process.platform === 'win32'
    ? process.env.ComSpec ?? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe')
    : '/bin/sh';
  const declared = await createPiToolBroker({ ...f.options, runtimeEnvironment: runtimeEnvironment([['shell', await realpath(shellPath)]]) });
  assert.deepEqual(declared.tools().find(tool => tool.name === 'run_task_program').inputSchema.properties.program.enum, ['shell']);
  const args = process.platform === 'win32' ? ['/d', '/c', 'echo', 'declared-shell'] : ['-c', 'printf declared-shell'];
  const result = value(await declared.call('run_task_program', { program: 'shell', args, cwd: 'workspace' }, 'declared-shell'));
  assert.equal(result.exit_code, 0);
  assert.match(result.stdout, /declared-shell/i);
  await declared.quiesce();
});

test('broker without a runtime binding exposes no task-program or shell execution', async t => {
  const f = await fixture(t);
  const broker = await createPiToolBroker(f.options);
  assert.equal(broker.tools().some(tool => tool.name === 'run_task_program' || tool.name === 'run_shell'), false);
  await assert.rejects(broker.call('run_task_program', { program: 'node', args: ['-p', '1'], cwd: 'workspace' }, 'no-runtime'),
    { code: 'PI_TOOL_DENIED' });
});

test('workspace runtime configuration is excluded from reads and directory listings', async t => {
  const f = await fixture(t);
  const broker = await createPiToolBroker(f.options);
  const listing = value(await broker.call('list_workspace', { path: '.' }, 'workspace-list'));
  assert.equal(listing.entries.some(entry => entry.name === '.pi'), false);
  await assert.rejects(broker.call('read_workspace', { path: '.pi/settings.json' }, 'read-pi-settings'),
    { code: 'PI_TOOL_PATH_DENIED' });
});

test('task inputs and immutable Workflow resources use declared roots and exact pins', async t => {
  const f = await fixture(t), taskRoot = await mkdtemp(join(tmpdir(), 'pi-task-input-'));
  await writeFile(join(taskRoot, 'request.txt'), 'input data');
  t.after(() => rm(taskRoot, { recursive: true, maxRetries: 3, retryDelay: 100 }));
  const bytes = Buffer.from('alpha\nbeta\ngamma');
  const broker = await createPiToolBroker({
    ...f.options,
    access: 'read_only',
    allowedPaths: [],
    inputRoots: [{ name: 'task_root', path: taskRoot }],
    resources: [{ path: 'references/guide.txt', bytes, sha256: digest(bytes) }],
  });
  assert.equal(value(await broker.call('read_input', { root: 'task_root', path: 'request.txt' }, 'read-input')).text, 'input data');
  const chunk = value(await broker.call('read_workflow_resource_chunk', {
    path: 'references/guide.txt', start_byte: 0, max_bytes: 9,
  }, 'read-resource'));
  assert.equal(chunk.text, 'alpha\nbet');
  assert.equal(chunk.complete, false);
  const range = value(await broker.call('read_workflow_resource_range', {
    path: 'references/guide.txt', start_line: 2, end_line: 2,
  }, 'read-range'));
  assert.equal(range.text, '2: beta');
  assert.equal(range.total_lines, 3);
  assert.equal((await broker.quiesce()).quiescent, true);
});

test('revoking a native task program confirms quiescence before later effects', async t => {
  const f = await fixture(t);
  const broker = await createPiToolBroker({ ...f.options, runtimeEnvironment: runtimeEnvironment([['node', process.execPath]]) });
  const ready = join(f.workspace, 'src', 'program.ready');
  const late = join(f.workspace, 'src', 'late-effect.txt');
  const script = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(ready)},'ready');setTimeout(()=>fs.writeFileSync(${JSON.stringify(late)},'late'),1200);`;
  const pending = broker.call('run_task_program', { program: 'node', args: ['-e', script], cwd: 'workspace' }, 'revoked-program');
  const outcome = pending.then(result => ({ result }), error => ({ error }));
  assert.equal(await waitForFile(ready), 'ready');
  broker.revoke();
  const stopped = await outcome;
  assert.equal(stopped.error?.code, 'PI_EXECUTION_CANCELLED');
  const quiescence = await broker.quiesce();
  assert.equal(quiescence.quiescent, true);
  assert.equal(quiescence.error?.code, 'PI_EXECUTION_CANCELLED');
  await delay(1400);
  await assert.rejects(readFile(late, 'utf8'), { code: 'ENOENT' });
});

test('declared task input supports task_root cwd and exact path substitution', async t => {
  const f = await fixture(t), taskRoot = await mkdtemp(join(tmpdir(), 'pi-task-root-'));
  await writeFile(join(taskRoot, 'input.txt'), 'task-root-content');
  t.after(() => rm(taskRoot, { recursive: true, maxRetries: 3, retryDelay: 100 }));
  const broker = await createPiToolBroker({
    ...f.options,
    inputRoots: [{ name: 'task_root', path: taskRoot }],
    runtimeEnvironment: runtimeEnvironment([['node', process.execPath]]),
  });
  const result = value(await broker.call('run_task_program', {
    program: 'node',
    args: ['-e', "process.stdout.write(require('node:fs').readFileSync(process.argv[1], 'utf8'))", '@TASK_ROOT@/input.txt'],
    cwd: 'task_root',
  }, 'task-root-cwd'));
  assert.equal(result.exit_code, 0);
  assert.equal(result.stdout, 'task-root-content');
  await broker.quiesce();
});
