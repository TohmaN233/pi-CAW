import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { stopNativeWindowsTree } from '../core/execution/program-broker.mjs';

test('Windows tree helper is bounded and a zero exit preserves exact helper evidence', async () => {
  const result = await stopNativeWindowsTree(1234, { executor: (program, args, options, callback) => {
    assert.match(program, /taskkill\.exe$/i); assert.deepEqual(args, ['/PID', '1234', '/T', '/F']);
    assert.equal(options.timeout, 5000); assert.equal(options.maxBuffer, 8192);
    assert.equal(options.windowsHide, true); assert.equal(options.shell, false); assert.equal(options.killSignal, 'SIGKILL');
    queueMicrotask(() => callback(null, 'exact tree stopped', ''));
  } });
  assert.equal(result.pid, 1234); assert.equal(result.helper_exit_code, 0); assert.equal(result.helper_killed, false);
  assert.equal(result.helper_stdout, 'exact tree stopped'); assert(result.helper_duration_ms >= 0);
});

test('nonzero helper exit remains unconfirmed even when the parent naturally exited and pipes closed', async () => {
  await assert.rejects(stopNativeWindowsTree(1234, { parentState: () => ({ exited: true, closed: true }),
    executor: (_program, _args, _options, callback) => queueMicrotask(() => callback(Object.assign(new Error('not found'), { code: 128 }), 'x'.repeat(2000), 'parent no longer found')),
  }), error => {
    assert.equal(error.code, 'PI_EXECUTION_STOP_UNCONFIRMED'); assert.equal(error.details.helper_exit_code, 128);
    assert.equal(error.details.parent_exited, true); assert.equal(error.details.parent_closed, true);
    assert.equal(error.details.helper_stdout.length, 1000); assert.equal(error.details.helper_stderr, 'parent no longer found'); return true;
  });
});

test('helper deadline kills and closes its own real synthetic process before reporting uncertainty', async () => {
  let helper, closed = false;
  await assert.rejects(stopNativeWindowsTree(1234, { timeoutMs: 100, executor: (_program, _args, options, callback) => {
    // The trusted seam starts a synthetic Node helper, never taskkill or a
    // live user process. execFile's timeout owns and closes this exact child.
    helper = execFile(process.execPath, ['-e', 'setInterval(()=>{},1000)'], options, callback);
    helper.once('close', () => { closed = true; }); return helper;
  } }), error => {
    assert.equal(error.code, 'PI_EXECUTION_STOP_UNCONFIRMED'); assert.equal(error.details.helper_killed, true);
    assert.equal(error.details.helper_timeout_ms, 100); assert(error.details.helper_duration_ms >= 90); return true;
  });
  assert.equal(closed, true); assert.equal(helper.killed, true);
  assert.throws(() => process.kill(helper.pid, 0), { code: 'ESRCH' });
});

test('helper spawn failures remain visible and cannot confirm tree termination', async () => {
  await assert.rejects(stopNativeWindowsTree(1234, { executor: (_program, _args, _options, callback) => {
    queueMicrotask(() => callback(Object.assign(new Error('access denied'), { code: 'EACCES' }), '', ''));
  } }), error => {
    assert.equal(error.code, 'PI_EXECUTION_STOP_UNCONFIRMED'); assert.equal(error.details.helper_cause_code, 'EACCES');
    assert.equal(error.details.helper_exit_code, null); return true;
  });
});
