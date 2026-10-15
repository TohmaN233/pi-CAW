import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PI_CAW_PACKAGE_JSON_URL,
  classifyPluginUpdate,
  compareSemVer,
  createPluginUpdateChecker,
} from '../lib/plugin-update.mjs';

function packageResponse(version) {
  return { ok: true, json: async () => ({ version }) };
}

test('semantic version comparison follows core, prerelease, and build metadata precedence', () => {
  assert.equal(compareSemVer('0.5.6', '0.5.5'), 1);
  assert.equal(compareSemVer('1.0.0', '0.99.99'), 1);
  assert.equal(compareSemVer('1.2.3-rc.2', '1.2.3-rc.10'), -1);
  assert.equal(compareSemVer('1.2.3-rc.10', '1.2.3'), -1);
  assert.equal(compareSemVer('1.2.3+build.1', '1.2.3+build.2'), 0);
  assert.throws(() => compareSemVer('v1.2.3', '1.2.3'), /Invalid semantic version/);
});

test('classifies update available, local newer, and current versions', async () => {
  let requests = 0;
  const check = createPluginUpdateChecker({ fetchImpl: async (url, options) => {
    requests++;
    assert.equal(url, PI_CAW_PACKAGE_JSON_URL);
    assert.equal(options.redirect, 'error');
    return packageResponse('0.5.6');
  } });

  assert.deepEqual(await check('0.5.5'), { status: 'update_available', currentVersion: '0.5.5', latestVersion: '0.5.6' });
  assert.deepEqual(await check('0.5.7'), { status: 'local_ahead', currentVersion: '0.5.7', latestVersion: '0.5.6' });
  assert.deepEqual(await check('0.5.6'), { status: 'up_to_date', currentVersion: '0.5.6', latestVersion: '0.5.6' });
  assert.deepEqual(classifyPluginUpdate('1.0.0-rc.1', '1.0.0'), { status: 'update_available', currentVersion: '1.0.0-rc.1', latestVersion: '1.0.0' });
  assert.equal(requests, 1, 'successful metadata is cached across local version comparisons');
});

test('coalesces concurrent checks and reuses a successful response for five minutes', async () => {
  let requests = 0, currentTime = 10_000, releaseFetch;
  const fetchGate = new Promise(resolve => { releaseFetch = resolve; });
  const check = createPluginUpdateChecker({
    fetchImpl: async () => { requests++; await fetchGate; return packageResponse('0.5.6'); },
    now: () => currentTime,
  });

  const first = check('0.5.5'), second = check('0.5.7');
  assert.equal(requests, 1);
  releaseFetch();
  assert.deepEqual(await Promise.all([first, second]), [
    { status: 'update_available', currentVersion: '0.5.5', latestVersion: '0.5.6' },
    { status: 'local_ahead', currentVersion: '0.5.7', latestVersion: '0.5.6' },
  ]);
  await check('0.5.6');
  assert.equal(requests, 1);
  currentTime += 5 * 60_000;
  await check('0.5.6');
  assert.equal(requests, 2, 'an expired success triggers a fresh fetch');
});

test('HTTP failures are visible and are retried on the next check', async () => {
  let requests = 0;
  const check = createPluginUpdateChecker({ fetchImpl: async () => {
    requests++;
    return requests === 1 ? { ok: false, status: 503 } : packageResponse('0.5.6');
  } });

  await assert.rejects(check('0.5.5'), error => error.code === 'PI_CAW_UPDATE_CHECK_FAILED' && /HTTP 503/.test(error.message));
  assert.deepEqual(await check('0.5.5'), { status: 'update_available', currentVersion: '0.5.5', latestVersion: '0.5.6' });
  assert.equal(requests, 2, 'failed checks are not cached');
});

test('a stalled metadata request fails with a timeout error', async () => {
  let requests = 0;
  const check = createPluginUpdateChecker({
    timeoutMs: 20,
    fetchImpl: (_url, { signal }) => {
      requests++;
      if (requests > 1) return Promise.resolve(packageResponse('0.5.6'));
      return new Promise((resolve, reject) => {
        if (signal.aborted) reject(new Error('aborted'));
        else signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    },
  });
  await assert.rejects(check('0.5.5'), error => error.code === 'PI_CAW_UPDATE_CHECK_TIMEOUT' && /timed out/.test(error.message));
  assert.deepEqual(await check('0.5.5'), { status: 'update_available', currentVersion: '0.5.5', latestVersion: '0.5.6' });
  assert.equal(requests, 2, 'a timeout does not poison the shared fetch slot or cache');
});
