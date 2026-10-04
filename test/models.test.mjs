import test from 'node:test';
import assert from 'node:assert/strict';
import { availableModels, resolveBinding } from '../lib/models.mjs';
import { emptySettings, validateSettings, resolveStateDirectory } from '../lib/settings.mjs';
import { catalog, binding } from './fixtures.mjs';
test('there is no default child Provider, Role or model routing, and Main has no plugin setting', () => {
  assert.deepEqual(emptySettings(), { schema_version: 1, providers: [], roles: [], routing: {} });
  assert.throws(() => resolveBinding(null, catalog), { code: 'PI_MODEL_BINDING_REQUIRED' });
  assert.throws(() => resolveBinding({ ...binding, thinking: undefined }, catalog), { code: 'PI_MODEL_BINDING_REQUIRED' });
});
test('models resolve by exact Pi provider, model and supported thinking with drift detection', () => {
  assert.equal(resolveBinding(binding, catalog).fingerprint, catalog[0].fingerprint);
  assert.throws(() => resolveBinding({ ...binding, provider: 'other' }, catalog), { code: 'PI_MODEL_UNAVAILABLE' });
  assert.throws(() => resolveBinding({ ...binding, thinking: 'max' }, catalog), { code: 'PI_THINKING_UNSUPPORTED' });
  assert.throws(() => resolveBinding({ ...binding, fingerprint: 'b'.repeat(64) }, catalog), { code: 'PI_MODEL_CHANGED' });
});
test('active Pi session scoping restricts the available catalog without choosing a model', () => {
  const models = ['a', 'b'].map(id => ({ provider: 'test', id, name: id, api: 'fixture', baseUrl: 'http://example.invalid', reasoning: false, input: ['text'], contextWindow: 100, maxTokens: 20 }));
  const context = { modelRegistry: { getAvailable: () => models }, scopedModels: [{ model: models[1] }] };
  assert.deepEqual(availableModels(context, () => ['off']).map(model => model.model_id), ['b']);
});
test('settings refuse external connector/credential fields and never target Codex storage', () => {
  const settings = emptySettings(); settings.providers.push({ id: 'x', name: 'X', enabled: true, binding, connector: 'cursor_cdp' });
  assert.throws(() => validateSettings(settings), { code: 'PI_PROVIDER' });
  assert.match(resolveStateDirectory(undefined, {}), /[\\/]\.pi[\\/]agent[\\/]pi-CAW$/);
});
