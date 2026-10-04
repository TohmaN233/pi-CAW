import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixtures.mjs';
import { openWorkbench } from '../lib/workbench-server.mjs';

test('human configuration requires the loopback token and same origin; concurrent settings retain revision checks', async t => {
  const f = await fixture(t), server = await openWorkbench(f.service); t.after(() => server.close());
  const url = new URL(server.url), token = url.hash.slice(1); url.hash = '';
  const post = (operation, args = {}, extra = {}) => fetch(new URL('/api', url), { method: 'POST', headers: {
    'content-type': 'application/json', authorization: `Bearer ${token}`, ...extra }, body: JSON.stringify({ operation, args }) });
  assert.equal((await post('settings', {}, { authorization: 'Bearer wrong' })).status, 403);
  assert.equal((await post('settings', {}, { origin: 'https://foreign.invalid' })).status, 403);
  const config = (await (await post('settings')).json()).result;
  config.settings.providers[0].name = 'Edited once';
  const first = await post('save_settings', { settings: config.settings, expected_revision: config.revision }); assert.equal(first.status, 200);
  const stale = await post('save_settings', { settings: config.settings, expected_revision: config.revision }); assert.equal(stale.status, 409);
  const page = await fetch(url); assert.equal(page.status, 200); assert.match(await page.text(), /Pi Agents Workflow/);
  for (const path of ['/workflows.js', '/workflows.css', '/i18n.js']) assert.equal((await fetch(new URL(path, url))).status, 200, path);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
});
