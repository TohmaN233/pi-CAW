import test from 'node:test';
import assert from 'node:assert/strict';
import { openWorkbench } from '../lib/workbench-server.mjs';
import { WORKBENCH_OPERATIONS } from '../lib/workbench-api.mjs';

function client(server) {
  const origin = new URL(server.url), token = origin.hash.slice(1);
  origin.hash = '';
  return {
    origin,
    post: (operation, args = {}, headers = {}) => fetch(new URL('/api', origin), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers },
      body: JSON.stringify({ operation, args }),
    }),
  };
}

test('update checks stay behind authenticated /api dispatch and do not call the service or start a Run', async t => {
  const serviceCalls = [], updateChecks = [];
  const service = { async call(...args) { serviceCalls.push(args); return { operation: args[0] }; } };
  const server = await openWorkbench(service, { checkPluginUpdate: async version => {
    updateChecks.push(version);
    return { status: 'update_available', currentVersion: version, latestVersion: '0.5.6' };
  } });
  t.after(() => server.close());
  const api = client(server);

  assert.equal(updateChecks.length, 0, 'opening the server does not contact the update checker');
  assert.equal((await fetch(api.origin)).status, 200);
  assert.equal(updateChecks.length, 0, 'serving the Workbench page does not check for updates');
  assert.equal(WORKBENCH_OPERATIONS.has('plugin_update'), false, 'update status is not a service or agent operation');

  const denied = await api.post('plugin_update', { current_version: '0.5.5' }, { authorization: 'Bearer wrong' });
  assert.equal(denied.status, 403);
  assert.equal(updateChecks.length, 0);
  assert.equal(serviceCalls.length, 0);

  const foreign = await api.post('plugin_update', { current_version: '0.5.5' }, { origin: 'https://foreign.invalid' });
  assert.equal(foreign.status, 403);
  assert.equal(updateChecks.length, 0);

  const response = await api.post('plugin_update', { current_version: '0.5.5' });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).result, { status: 'update_available', currentVersion: '0.5.5', latestVersion: '0.5.6' });
  assert.deepEqual(updateChecks, ['0.5.5']);
  assert.equal(serviceCalls.length, 0, 'the read-only update request bypasses Run and service dispatch');

  const ordinary = await api.post('settings');
  assert.equal(ordinary.status, 200);
  assert.deepEqual(serviceCalls, [['settings', {}, { human: true }]], 'existing authenticated service dispatch is unchanged');
});

test('update-check errors remain explicit HTTP errors instead of looking current', async t => {
  const serviceCalls = [];
  const server = await openWorkbench({ async call(...args) { serviceCalls.push(args); } }, {
    checkPluginUpdate: async () => { throw Object.assign(new Error('GitHub metadata unavailable'), { code: 'PI_CAW_UPDATE_CHECK_FAILED' }); },
  });
  t.after(() => server.close());
  const api = client(server);
  const response = await api.post('plugin_update', { current_version: '0.5.5' });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'GitHub metadata unavailable', code: 'PI_CAW_UPDATE_CHECK_FAILED', details: null });
  assert.deepEqual(serviceCalls, []);
});
