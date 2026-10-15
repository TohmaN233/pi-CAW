import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { transform } from 'esbuild';

// Execute the actual native extension factory with controlled construction
// boundaries. No SDK session, model, child process or persistent state is used.
async function fixture(t, options = {}) {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const services = [], handlers = new Map(), commands = new Map(), bus = new Map(), lifecycle = [], workbenches = [];
  let workbenchRelease, notifications = 0, toolCalls = 0, readyEvents = 0;
  t.mock.method(console, 'info', (prefix, event) => { if (prefix === '[pi-CAW] extension lifecycle') lifecycle.push(structuredClone(event)); });
  let references = 0, ticks = 0;
  const initialError = Object.assign(new Error('Run admission timed out after timer creation'), { code: 'RUN_STORE_ADMISSION_TIMEOUT' });
  const closeError = Object.assign(new Error('Synthetic maintenance settlement remains unconfirmed'), { code: 'HISTORY_STOP_PENDING' });
  class PiCawService {
    constructor({ host }) { this.host = host; references += 1; services.push(this); this.closed = false; }
    async initialize() {
      await new Promise(resolve => { this.releaseInitialize = resolve; });
      this.timer = setInterval(() => { ticks += 1; }, 60000);
      this.timer.unref?.();
      if (options.failInitialize) throw initialError;
      return this;
    }
    async close() {
      if (options.failCloseUndefined) throw undefined;
      if (options.failClose) throw closeError;
      if (!this.closed) { this.closed = true; clearInterval(this.timer); references -= 1; }
    }
    async call() { toolCalls += 1; return { ready: true }; }
  }
  const key = `piCawLifecycleFixture${randomUUID().replaceAll('-', '')}`;
  globalThis[key] = {
    PiCawService, randomUUID, PiSdkHost: class { constructor() { this.main = { sessionChanged() {} }; } },
    Type: new Proxy({}, { get: (_target, name) => (...args) => ({ name, args }) }),
    getSupportedThinkingLevels: () => ['off'], getAgentDir: () => '/unused',
    WORKBENCH_OPERATIONS: [], feedbackText: () => '', projectWorkflowContext: messages => messages,
    resolveStateDirectory: () => '/unused', requestPiExecutionAdmission: () => { throw new Error('No execution'); },
    openWorkbench: async () => {
      const opened = { url: 'http://127.0.0.1:1', closed: false, async close() { if (options.failWorkbenchClose) throw new Error('Synthetic Workbench close failed'); this.closed = true; } };
      workbenches.push(opened);
      if (options.deferWorkbenchOpen) await new Promise(resolve => { workbenchRelease = resolve; });
      if (Object.hasOwn(options, 'workbenchOpenError')) throw options.workbenchOpenError;
      return opened;
    },
  };
  t.after(() => { for (const service of services) clearInterval(service.timer); delete globalThis[key]; });
  const names = Object.keys(globalThis[key]);
  const mockCode = `const fixture=globalThis[${JSON.stringify(key)}];` + names.map(name => `export const ${name}=fixture.${name};`).join('');
  const mockUrl = `data:text/javascript;base64,${Buffer.from(mockCode).toString('base64')}`;
  const source = await readFile(new URL('../extensions/pi-caw.ts', import.meta.url), 'utf8');
  const compiled = await transform(source, { loader: 'ts', format: 'esm', target: 'es2022' });
  const code = compiled.code.replace(/from "[^"]+"/g, `from ${JSON.stringify(mockUrl)}`) + '\n//# sourceURL=pi-caw-native-lifecycle-fixture.mjs';
  const { default: piCaw } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
  let tool;
  piCaw({ on: (event, handler) => handlers.set(event, handler), events: {
    on: (event, handler) => { bus.set(event, handler); return () => bus.delete(event); },
    emit: (event, data) => { if (event === 'pi-caw:host-ready') readyEvents += 1; return bus.get(event)?.(data); },
  },
    registerTool(value) { tool = value; }, registerCommand: (name, value) => commands.set(name, value) });
  const context = { cwd: '/unused', sessionManager: { getSessionId: () => 'native-parent', getEntries: () => [] }, ui: { notify() { notifications += 1; } } };
  return { services, initialError, closeError, commands, context, lifecycle, workbenches,
    start: () => handlers.get('session_start')({}, context),
    shutdown: () => handlers.get('session_shutdown')({}),
    tool: (action = 'roles', args = {}) => tool.execute('synthetic', { action, args }, undefined, undefined, context),
    readiness: () => { const request = { session_id: 'native-parent', ready: false }; bus.get('pi-caw:host-readiness')?.(request); return request.ready; },
    allowInitializeSuccess: () => { options.failInitialize = false; },
    releaseWorkbenchOpen: () => workbenchRelease(),
    privateCommand: (operation, args) => new Promise((resolve, reject) => {
      bus.get('pi-caw:host-command')({ session_id: 'native-parent', operation, args, resolve, reject });
    }),
    get readyEvents() { return readyEvents; },
    get notifications() { return notifications; }, get toolCalls() { return toolCalls; },
    get references() { return references; }, get ticks() { return ticks; } };
}

test('native extension coalesces concurrent starts and tool initialization into one owned service', async t => {
  const f = await fixture(t);
  const first = f.start(), second = f.start(), tool = f.tool();
  assert.equal(f.services.length, 1);
  assert.equal(f.readiness(), false);
  f.services[0].releaseInitialize();
  await Promise.all([first, second, tool]);
  assert.equal(f.readiness(), true);
  await f.shutdown();
  assert.equal(f.references, 0);
  assert.equal(f.readiness(), false);
  t.mock.timers.tick(120000);
  assert.equal(f.ticks, 0);
});

test('native extension closes a failed initializer after timers and retention lease creation', async t => {
  const f = await fixture(t, { failInitialize: true });
  const started = f.start();
  const rejected = assert.rejects(started, error => error === f.initialError);
  f.services[0].releaseInitialize();
  await rejected;
  assert.equal(f.services[0].closed, true);
  assert.equal(f.references, 0);
  assert.equal(f.readiness(), false);
  assert.deepEqual(f.lifecycle.map(event => event.phase), ['init_started', 'init_failed', 'cleanup_started', 'cleanup_complete']);
  assert.equal(new Set(f.lifecycle.map(event => event.lifecycle_id)).size, 1);
  assert(f.lifecycle.every(event => event.pid === process.pid && event.session_id === 'native-parent'));
  assert.equal(f.lifecycle[1].code, 'RUN_STORE_ADMISSION_TIMEOUT');
  assert(f.lifecycle.every(event => Object.keys(event).every(key => ['lifecycle_id', 'pid', 'session_id', 'phase', 'code'].includes(key))));
  f.allowInitializeSuccess();
  const retry = f.start();
  assert.equal(f.services.length, 2);
  f.services[1].releaseInitialize(); await retry;
  assert.equal(f.readiness(), true);
  await f.shutdown();
  t.mock.timers.tick(120000);
  assert.equal(f.ticks, 0);
});

test('native shutdown awaits an in-flight initializer and prevents late background service publication', async t => {
  const f = await fixture(t);
  const started = f.start();
  const rejected = assert.rejects(started, error => error.code === 'PI_CAW_SHUTTING_DOWN');
  let stopped = false;
  const closing = f.shutdown().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false);
  f.services[0].releaseInitialize();
  await Promise.all([rejected, closing]);
  assert.equal(f.references, 0);
  t.mock.timers.tick(120000);
  assert.equal(f.ticks, 0);
  await assert.rejects(f.tool(), error => error.code === 'PI_CAW_SHUTTING_DOWN');
  assert.equal(f.services.length, 1);
});

test('failed initialization cleanup retains its exact owner and failure instead of constructing a replacement', async t => {
  const f = await fixture(t, { failInitialize: true, failClose: true });
  const started = f.start();
  const rejected = assert.rejects(started, error => error instanceof AggregateError && error.errors.includes(f.initialError) && error.errors.includes(f.closeError));
  f.services[0].releaseInitialize();
  await rejected;
  await assert.rejects(f.tool(), error => error instanceof AggregateError);
  assert.equal(f.services.length, 1);
  assert.equal(f.references, 1);
  await assert.rejects(f.shutdown(), error => error instanceof AggregateError);
  assert.equal(f.services[0].closed, false);
});

test('Workbench shutdown failure still closes the owned native service and remains visible', async t => {
  const f = await fixture(t, { failWorkbenchClose: true });
  const started = f.start(); f.services[0].releaseInitialize(); await started;
  await f.commands.get('caw').handler('', f.context);
  await assert.rejects(f.shutdown(), error => error instanceof AggregateError && error.errors.some(cause => /Workbench close/.test(cause.message)));
  assert.equal(f.services[0].closed, true);
  assert.equal(f.references, 0);
});

test('non-Error shutdown rejection stays visible and retains the exact owned service', async t => {
  const f = await fixture(t, { failCloseUndefined: true });
  const started = f.start(); f.services[0].releaseInitialize(); await started;
  await assert.rejects(f.shutdown(), error => error instanceof AggregateError && error.errors.includes(undefined));
  assert.equal(f.references, 1);
  assert.equal(f.services[0].closed, false);
  const failure = f.lifecycle.find(event => event.phase === 'cleanup_failed');
  assert.equal(failure.code, 'INITIALIZATION_OR_CLEANUP_ERROR');
});

test('native shutdown waits for an opening Workbench and rejects its late notification', async t => {
  const f = await fixture(t, { deferWorkbenchOpen: true });
  const started = f.start(); f.services[0].releaseInitialize(); await started;
  const command = f.commands.get('caw').handler('', f.context);
  const rejected = assert.rejects(command, error => error.code === 'PI_CAW_SHUTTING_DOWN');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.workbenches.length, 1);
  let stopped = false;
  const closing = f.shutdown().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false);
  f.releaseWorkbenchOpen();
  await Promise.all([rejected, closing]);
  assert.equal(f.workbenches[0].closed, true);
  assert.equal(f.services[0].closed, true);
  assert.equal(f.notifications, 0);
});

test('concurrent native Workbench commands share one opening and exact server ownership', async t => {
  const f = await fixture(t, { deferWorkbenchOpen: true });
  const started = f.start(); f.services[0].releaseInitialize(); await started;
  const first = f.commands.get('caw').handler('', f.context), second = f.commands.get('caw').handler('', f.context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.workbenches.length, 1);
  f.releaseWorkbenchOpen(); await Promise.all([first, second]);
  assert.equal(f.notifications, 2);
  await f.shutdown(); assert.equal(f.workbenches[0].closed, true);
});

test('ready-service await cannot release a new tool operation after shutdown admission closes', async t => {
  const f = await fixture(t);
  const started = f.start(); f.services[0].releaseInitialize(); await started;
  const pending = f.tool();
  const rejected = assert.rejects(pending, error => error.code === 'PI_CAW_SHUTTING_DOWN');
  await Promise.all([rejected, f.shutdown()]);
  assert.equal(f.toolCalls, 0);
});

test('private cancel retains its exact owner but cannot mutate after the awaited lookup crosses shutdown', async t => {
  const f = await fixture(t);
  const started = f.start(); f.services[0].releaseInitialize(); await started;
  let releaseGet, releaseClose, cancelCalls = 0;
  const getHeld = new Promise(resolve => { releaseGet = resolve; });
  const closeHeld = new Promise(resolve => { releaseClose = resolve; });
  f.services[0].call = async operation => { if (operation === 'get') return getHeld; cancelCalls += 1; return {}; };
  const originalClose = f.services[0].close.bind(f.services[0]);
  f.services[0].close = async () => { await closeHeld; return originalClose(); };
  const cancel = f.privateCommand('cancel', { run_id: 'synthetic-run' });
  const rejected = assert.rejects(cancel, error => error.code === 'PI_CAW_SHUTTING_DOWN');
  const closing = f.shutdown();
  releaseGet({ main_actor: 'native-parent' });
  await rejected;
  assert.equal(cancelCalls, 0);
  releaseClose(); await closing;
  assert.equal(f.services[0].closed, true);
});

test('a repeated session_start cannot publish readiness after its ready-service await crosses shutdown', async t => {
  const f = await fixture(t);
  const started = f.start(); f.services[0].releaseInitialize(); await started;
  assert.equal(f.readyEvents, 1);
  const repeated = f.start();
  const rejected = assert.rejects(repeated, error => error.code === 'PI_CAW_SHUTTING_DOWN');
  await Promise.all([rejected, f.shutdown()]);
  assert.equal(f.readyEvents, 1);
});

test('shutdown succeeds when it cancels the exact owned Workbench opening before any server starts', async t => {
  const f = await fixture(t);
  const started = f.start(); f.services[0].releaseInitialize(); await started;
  const command = f.commands.get('caw').handler('', f.context);
  const rejected = assert.rejects(command, error => error.code === 'PI_CAW_SHUTTING_DOWN');
  await Promise.resolve();
  await Promise.all([rejected, f.shutdown()]);
  assert.equal(f.workbenches.length, 0);
  assert.equal(f.notifications, 0);
  assert.equal(f.services[0].closed, true);
});

test('shutdown does not mask a real Workbench open failure that reuses the admission-cancellation code', async t => {
  const external = Object.assign(new Error('Actual synthetic Workbench opening failed'), { code: 'PI_CAW_SHUTTING_DOWN' });
  const f = await fixture(t, { deferWorkbenchOpen: true, workbenchOpenError: external });
  const started = f.start(); f.services[0].releaseInitialize(); await started;
  const command = f.commands.get('caw').handler('', f.context);
  const rejected = assert.rejects(command, error => error === external);
  await new Promise(resolve => setImmediate(resolve));
  const closing = assert.rejects(f.shutdown(), error => error instanceof AggregateError && error.errors.includes(external));
  f.releaseWorkbenchOpen(); await Promise.all([rejected, closing]);
  assert.equal(f.services[0].closed, true);
  assert.equal(f.notifications, 0);
});

test('shutdown before acquisition constructs no service or Workbench and refuses new native callers', async t => {
  const f = await fixture(t);
  await f.shutdown();
  await assert.rejects(f.start(), error => error.code === 'PI_CAW_SHUTTING_DOWN');
  await assert.rejects(f.commands.get('caw').handler('', f.context), error => error.code === 'PI_CAW_SHUTTING_DOWN');
  assert.equal(f.services.length, 0);
  assert.equal(f.workbenches.length, 0);
});

test('human confirmation cannot release an admission recovery after shutdown begins', async t => {
  const f = await fixture(t);
  const started = f.start(); f.services[0].releaseInitialize(); await started;
  let releaseConfirmation;
  f.context.ui.confirm = () => new Promise(resolve => { releaseConfirmation = resolve; });
  const request = f.tool('recover_run_admission', { run_id: 'synthetic-run', records: [] });
  const rejected = assert.rejects(request, error => error.code === 'PI_CAW_SHUTTING_DOWN');
  await new Promise(resolve => setImmediate(resolve));
  const closing = f.shutdown(); releaseConfirmation(true);
  await Promise.all([rejected, closing]);
  assert.equal(f.toolCalls, 0);
  assert.equal(f.services[0].closed, true);
});
