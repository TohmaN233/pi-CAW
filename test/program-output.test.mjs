import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPiToolBroker } from '../core/execution/program-broker.mjs';
import { prepareOwnedCommandTemp } from '../core/execution/owned-command-temp.mjs';
import { createProgramOutput, PROGRAM_REPLY_BYTES, serializedProgramResultBytes } from '../core/execution/program-output.mjs';

const value = result => JSON.parse(result.contentItems[0].text);
const runtime = { status: 'ready', tools: [{ name: 'node', path: process.execPath, status: 'found' }] };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(t) {
  const parent = await mkdtemp(join(tmpdir(), 'pi-output-test-')), workspace = join(parent, 'workspace'), base = join(parent, 'temp');
  await mkdir(workspace); await mkdir(base);
  t.after(() => rm(parent, { recursive: true, force: true, maxRetries: 3 }));
  const events = [];
  const options = { workspace, access: 'read_only', runtimeEnvironment: runtime, commandTempBase: base,
    authorize: async () => {}, onOperation: async event => events.push(event) };
  return { parent, workspace, base, events, options };
}
const command = script => ({ program: 'node', args: ['-e', script], cwd: 'workspace' });
test('trusted Host deadline reaches refreshed native execution while ordinary broker keeps its default', async t => {
  const f = await fixture(t);
  for (const deadline of [undefined, 3600000]) {
    let refreshes = 0;
    const broker = await createPiToolBroker({ ...f.options, programDeadlineMs: deadline,
      prepareRuntimeEnvironment: async () => { refreshes++; return runtime; } });
    assert.equal(Object.hasOwn(broker.tools().find(tool => tool.name === 'run_task_program').inputSchema.properties, 'deadline_ms'), false);
    const callId = `deadline-${deadline}`;
    assert.equal(value(await broker.call('run_task_program', command('process.stdout.write("done")'), callId)).stdout, 'done');
    assert.equal(refreshes, 1);
    assert.equal(f.events.find(event => event.call_id === callId && event.phase === 'started').command_timeout_ms, deadline ?? 300000);
    assert.equal((await broker.quiesce()).error, null);
  }
  for (const deadline of [0, 3600001, 1.5]) {
    await assert.rejects(createPiToolBroker({ ...f.options, programDeadlineMs: deadline }), { code: 'PI_BROKER_DEADLINE' });
  }
});
async function reconstruct(broker, outputId, stream) {
  const chunks = []; let start = 0, complete = false;
  while (!complete) {
    const reply = await broker.call('read_program_output', { output_id: outputId, stream, start_byte: start, max_bytes: 12000 }, `${stream}-${start}`);
    assert(Buffer.byteLength(JSON.stringify(reply)) <= PROGRAM_REPLY_BYTES);
    const result = value(reply), bytes = Buffer.from(result.data_base64, 'base64');
    assert.equal(bytes.length, result.next_byte - start);
    if (result.text !== undefined) { assert(!/[\uD800-\uDBFF]$/.test(result.text)); assert.deepEqual(Buffer.from(result.text), bytes); }
    assert(result.complete || result.next_byte > start);
    chunks.push(bytes); start = result.next_byte; complete = result.complete;
  }
  return Buffer.concat(chunks);
}

test('parallel native brokers receive distinct sealed TEMP TMP TMPDIR and remove only their leaves', async t => {
  const f = await fixture(t), brokers = await Promise.all([createPiToolBroker(f.options), createPiToolBroker(f.options)]);
  const script = 'process.stdout.write(JSON.stringify({TEMP:process.env.TEMP,TMP:process.env.TMP,TMPDIR:process.env.TMPDIR}))';
  const results = await Promise.all(brokers.map((broker, index) => broker.call('run_task_program', command(script), `temp-${index}`)));
  const paths = results.map(reply => JSON.parse(value(reply).stdout));
  assert.notEqual(paths[0].TEMP, paths[1].TEMP);
  for (const path of paths) { assert.equal(path.TEMP, path.TMP); assert.equal(path.TEMP, path.TMPDIR); await readFile(join(path.TEMP, '.host-command-temp-owner.json')); }
  await brokers[0].quiesce(); await readFile(join(paths[1].TEMP, '.host-command-temp-owner.json'));
  await brokers[1].quiesce(); assert.deepEqual(await readdir(f.base), []);
});

test('temp marker tampering prevents launch and retains visible ownership evidence', async t => {
  const f = await fixture(t), effect = join(f.workspace, 'effect'); let retained;
  const broker = await createPiToolBroker({ ...f.options, onOperation: async event => {
    f.events.push(event);
    if (event.phase === 'temp_prepared') { retained = event.runtime_temp.path; await writeFile(join(retained, '.host-command-temp-owner.json'), '{}'); }
  } });
  await assert.rejects(broker.call('run_task_program', command(`require('fs').writeFileSync(${JSON.stringify(effect)},'late')`), 'tampered'), { code: 'PI_COMMAND_TEMP_OWNER' });
  await assert.rejects(readFile(effect), { code: 'ENOENT' });
  const closed = await broker.quiesce(); assert.equal(closed.quiescent, true); assert(closed.error);
  assert(f.events.some(event => event.phase === 'temp_retained' && event.retained_at === retained));
  assert.equal(await readFile(join(retained, '.host-command-temp-owner.json'), 'utf8'), '{}');
});

test('quiesce awaits in-flight allocation and revocation prevents a late native launch', async t => {
  const f = await fixture(t); let release, allocated;
  const gate = new Promise(resolve => { release = resolve; });
  const broker = await createPiToolBroker({ ...f.options, prepareCommandTemp: async options => {
    allocated = await prepareOwnedCommandTemp(options); await gate; return allocated;
  } });
  const pending = broker.call('run_task_program', command(`require('fs').writeFileSync(${JSON.stringify(join(f.workspace, 'late'))},'late')`), 'allocation');
  const outcome = pending.then(() => null, error => error);
  while (!allocated) await delay(5);
  let closeFinished = false; const close = broker.quiesce().then(result => { closeFinished = true; return result; });
  await delay(30); assert.equal(closeFinished, false); release();
  assert.equal((await outcome).code, 'PI_BROKER_REVOKED'); assert.equal((await close).quiescent, true);
  assert.deepEqual(await readdir(f.base), []); await assert.rejects(readFile(join(f.workspace, 'late')), { code: 'ENOENT' });
});

for (const exitCode of [0, 7]) test(`native ${exitCode === 0 ? 'success' : 'failure'} output over 1 MiB reconstructs Unicode and JSON escapes byte-for-byte`, async t => {
  const f = await fixture(t), broker = await createPiToolBroker(f.options);
  const unit = '😀漢字\n\t"\\\u0000', stdout = Buffer.from(unit.repeat(70000)), stderr = Buffer.from(unit.repeat(18000));
  const reply = await broker.call('run_task_program', command(`process.stdout.write(${JSON.stringify(unit)}.repeat(70000));process.stderr.write(${JSON.stringify(unit)}.repeat(18000));process.exitCode=${exitCode};`), 'large');
  assert(Buffer.byteLength(JSON.stringify(reply)) <= PROGRAM_REPLY_BYTES);
  const result = value(reply); assert.equal(result.exit_code, exitCode); assert.equal(result.output_complete, false);
  assert.deepEqual(await reconstruct(broker, result.output_ref.output_id, 'stdout'), stdout);
  assert.deepEqual(await reconstruct(broker, result.output_ref.output_id, 'stderr'), stderr);
  assert.equal(f.events.find(event => event.phase === 'completed').output_ref.streams.stdout.total_bytes, stdout.length);
  assert.equal((await broker.quiesce()).error, null);
});

test('small program results preserve the exact existing structured shape', async t => {
  const f = await fixture(t), broker = await createPiToolBroker(f.options);
  assert.deepEqual(value(await broker.call('run_task_program', command('process.stdout.write("hello😀");process.stderr.write("warning")'), 'small')),
    { exit_code: 0, signal: null, stdout: 'hello😀', stderr: 'warning', output: 'hello😀warning' });
  await broker.quiesce();
});

test('actual Host operation receives full parseable JSON beyond the model carrier budget', async t => {
  const f = await fixture(t), broker = await createPiToolBroker({ ...f.options, programOutputMode: 'actual' });
  const payload = '😀"\\'.repeat(20000);
  const result = value(await broker.call('run_task_program', command('process.stdout.write(JSON.stringify({payload:' + JSON.stringify('😀"\\') + '.repeat(20000)}))'), 'actual'));
  assert.deepEqual(JSON.parse(result.stdout), { payload }); assert.equal(result.output_ref, undefined);
  await broker.quiesce();
});

test('actual Host operation fails explicitly at its retained 1 MiB operation boundary', async t => {
  const f = await fixture(t), broker = await createPiToolBroker({ ...f.options, programOutputMode: 'actual' });
  let failure;
  try { await broker.call('run_task_program', command('process.stdout.write("a".repeat(1048577))'), 'oversize-actual'); }
  catch (error) { failure = error; }
  assert.equal(failure.code, 'PI_EXECUTION_OUTPUT');
  assert.equal((await reconstruct(broker, failure.program_output.output_id, 'stdout')).length, 1048577);
  await broker.quiesce();
});

test('output identity is exact to a broker and continuation does not repair a poisoned command queue', async t => {
  const f = await fixture(t), first = await createPiToolBroker(f.options), second = await createPiToolBroker(f.options);
  const result = value(await first.call('run_task_program', command('process.stdout.write("a".repeat(50000))'), 'one'));
  await assert.rejects(second.call('read_program_output', { output_id: result.output_ref.output_id, stream: 'stdout', start_byte: 0, max_bytes: 100 }, 'foreign'), { code: 'PI_PROGRAM_OUTPUT_DENIED' });
  await assert.rejects(first.call('run_task_program', { ...command(''), args: ['-e', '\0'] }, 'bad'), { code: 'PI_EXECUTION_ARGUMENTS' });
  assert.equal((await reconstruct(first, result.output_ref.output_id, 'stdout')).length, 50000);
  await assert.rejects(first.call('run_task_program', command('process.stdout.write("later")'), 'later'), { code: 'PI_EXECUTION_ARGUMENTS' });
  await first.quiesce(); await second.quiesce();
});

test('arbitrary byte output is losslessly represented, while the finite disk boundary fails explicitly', async t => {
  const f = await fixture(t), owner = await prepareOwnedCommandTemp({ workspace: f.workspace, base: f.base });
  const capture = createProgramOutput(owner, { maxBytes: 8 });
  capture.write('stdout', Buffer.from([0xff, 0x00, 0xfe, 0xf0]));
  assert.throws(() => capture.write('stderr', Buffer.alloc(5)), { code: 'PI_EXECUTION_OUTPUT' }); capture.finish();
  const carrier = await capture.carrier({ exit_code: 1, signal: null }); assert.equal(carrier.output_ref.capture_error, 'PI_EXECUTION_OUTPUT');
  const chunk = await capture.chunk('stdout', 0, 12000); assert.equal(chunk.encoding, 'base64');
  assert.deepEqual(Buffer.from(chunk.data_base64, 'base64'), Buffer.from([0xff, 0x00, 0xfe, 0xf0]));
  assert(serializedProgramResultBytes(chunk) <= PROGRAM_REPLY_BYTES); await owner.close();
});

test('sealed output contents tampering rejects continuation instead of serving different bytes', async t => {
  const f = await fixture(t), owner = await prepareOwnedCommandTemp({ workspace: f.workspace, base: f.base });
  const capture = createProgramOutput(owner); capture.write('stdout', Buffer.from('original')); capture.finish();
  await writeFile(join(owner.path, `${capture.outputId}.stdout`), 'tampered');
  await assert.rejects(capture.chunk('stdout', 0, 8), { code: 'PI_PROGRAM_OUTPUT_OWNER' }); await owner.close();
});

test('tampered broker output remains as visible diagnostic evidence after quiesce', async t => {
  const f = await fixture(t), broker = await createPiToolBroker(f.options);
  const result = value(await broker.call('run_task_program', command('process.stdout.write("a".repeat(50000))'), 'capture'));
  const evidence = broker.programOutputEvidence();
  await writeFile(evidence.outputs[0].stream_paths.stdout, 'changed');
  await assert.rejects(broker.call('read_program_output', { output_id: result.output_ref.output_id, stream: 'stdout', start_byte: 0, max_bytes: 100 }, 'changed'), { code: 'PI_PROGRAM_OUTPUT_OWNER' });
  const closed = await broker.quiesce(); assert.equal(closed.quiescent, true); assert.equal(closed.error.code, 'PI_PROGRAM_OUTPUT_OWNER');
  assert.equal(await readFile(evidence.outputs[0].stream_paths.stdout, 'utf8'), 'changed');
  assert(f.events.some(event => event.phase === 'output_retained' && event.retained_at === evidence.spool_owner.path));
});

test('Run-owned output persists through quiesce with a sealed manifest while native temporary state is removed', async t => {
  const f = await fixture(t), material = join(f.parent, 'run-material');
  const broker = await createPiToolBroker({ ...f.options, programOutputDirectory: material, retainProgramOutput: true });
  const result = value(await broker.call('run_task_program', command('process.stdout.write("retained😀");process.stderr.write("failed evidence");process.exitCode=9'), 'retained'));
  assert.equal(result.exit_code, 9);
  const evidence = broker.programOutputEvidence(); assert.equal(evidence.retained, true); assert.equal(evidence.outputs.length, 1);
  const manifest = JSON.parse(await readFile(evidence.outputs[0].manifest_path));
  assert.equal(manifest.broker_id, evidence.broker_id); assert.equal(manifest.outcome.exit_code, 9);
  assert.equal(manifest.streams.stdout.total_bytes, Buffer.byteLength('retained😀'));
  assert.equal((await broker.quiesce()).error, null);
  assert.equal(await readFile(evidence.outputs[0].stream_paths.stdout, 'utf8'), 'retained😀');
  assert.equal(await readFile(evidence.outputs[0].stream_paths.stderr, 'utf8'), 'failed evidence');
  assert.deepEqual(await readdir(f.base), []);
  assert.deepEqual(await readdir(material), [evidence.spool_owner.path.split(/[\\/]/).at(-1)]);
});

test('worst-case escaped ASCII chunks and tiny Unicode chunks preserve bounded serialized replies', async t => {
  const f = await fixture(t), owner = await prepareOwnedCommandTemp({ workspace: f.workspace, base: f.base });
  const capture = createProgramOutput(owner), bytes = Buffer.from('\u0000"\\'.repeat(18000) + '😀');
  capture.write('stdout', bytes); capture.finish();
  const reply = await capture.carrier({ exit_code: 0, signal: null }); assert(serializedProgramResultBytes(reply) <= PROGRAM_REPLY_BYTES);
  let offset = 0; const chunks = [];
  while (offset < bytes.length) {
    const chunk = await capture.chunk('stdout', offset, 12000); assert(serializedProgramResultBytes(chunk) <= PROGRAM_REPLY_BYTES);
    chunks.push(Buffer.from(chunk.data_base64, 'base64')); offset = chunk.next_byte;
  }
  assert.deepEqual(Buffer.concat(chunks), bytes);
  const tiny = await capture.chunk('stdout', bytes.length - 4, 1);
  assert.equal(tiny.text, undefined); assert.equal(tiny.encoding, 'base64'); assert.equal(tiny.next_byte, bytes.length - 3);
  await owner.close();
});
