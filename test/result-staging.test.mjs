import test from 'node:test';
import assert from 'node:assert/strict';
import { validateData } from '../core/workflow-data-schema.mjs';
import { acceptSemanticResult, hostLiftRequiredWrapper } from '../core/result-staging.mjs';

const schema = { type: 'object', required: ['result'], additionalProperties: false, properties: { result: { type: 'object' } } };
const validate = async value => validateData(value, schema);
const state = () => ({ submission: null, staged: null });

test('an invalid body is staged and is not an official result', async () => {
  const current = state();
  await assert.rejects(acceptSemanticResult(current, { summary: 'draft', result: { draft: { title: 'kept' } } }, validate),
    error => error.code === 'PI_RESULT_STAGED' && error.message.includes('required property is missing: result'));
  assert.equal(current.submission, null);
  assert.equal(current.staged.result.draft.title, 'kept');
  assert.equal(current.staged.base.draft.title, 'kept');
});

test('a passing wrap patch promotes the staged body without another copy', async () => {
  const current = state();
  await assert.rejects(acceptSemanticResult(current, { summary: 'draft', result: { draft: { title: 'kept' } } }, validate));
  const stage_id = current.staged.id;
  const accepted = await acceptSemanticResult(current, { summary: 'wrapped', stage_id, patch: [{ op: 'wrap', key: 'result' }] }, validate);
  assert.equal(accepted.promoted, true);
  assert.equal(accepted.stage_id, stage_id);
  assert.equal(current.staged, null);
  assert.equal(current.submission.result.result.draft.title, 'kept');
  assert.equal(JSON.stringify(current.submission.result).includes('"title":"kept"'), true);
});

test('a failed patch stays staged and does not become official', async () => {
  const current = state();
  await assert.rejects(acceptSemanticResult(current, { summary: 'draft', result: { draft: { title: 'kept' } } }, validate));
  await assert.rejects(acceptSemanticResult(current, { summary: 'still wrong', stage_id: current.staged.id, patch: [{ op: 'wrap', key: 'other' }] }, validate),
    error => error.code === 'PI_RESULT_STAGED');
  assert.equal(current.submission, null);
  assert.equal(current.staged.result.other.draft.title, 'kept');
  await acceptSemanticResult(current, { summary: 'reset and wrap', stage_id: current.staged.id, patch: [{ op: 'reset' }, { op: 'wrap', key: 'result' }] }, validate);
  assert.equal(current.submission.result.result.draft.title, 'kept');
});

test('resending the same invalid body does not replace the stage', async () => {
  const current = state();
  await assert.rejects(acceptSemanticResult(current, { summary: 'draft', result: { draft: { title: 'kept' } } }, validate));
  const id = current.staged.id;
  await assert.rejects(acceptSemanticResult(current, { summary: 'again', result: { draft: { title: 'kept' } } }, validate),
    error => error.stage_id === id && error.message.includes('Do not resend'));
  assert.equal(current.staged.id, id);
  assert.equal(current.submission, null);
});

test('a valid full result is official immediately', async () => {
  const current = state();
  const accepted = await acceptSemanticResult(current, { summary: 'ready', result: { result: { draft: { title: 'kept' } } } }, validate);
  assert.equal(accepted.promoted, false);
  assert.equal(current.submission.result.result.draft.title, 'kept');
  assert.equal(current.staged, null);
});

test('a missing required result wrapper is lifted by the host without another submission', async () => {
  const current = state();
  const body = { files: [{ format: 'tex', path: 'sources/deck.tex' }], title: 'Deck', frameOutline: ['One'] };
  const accepted = await acceptSemanticResult(current, { summary: 'draft', result: body }, validate, schema);
  assert.equal(accepted.promoted, true);
  assert.equal(current.staged, null);
  assert.equal(current.submission.result.result.title, 'Deck');
  assert.equal(current.submission.result.result.files[0].path, 'sources/deck.tex');
  assert.deepEqual(hostLiftRequiredWrapper(body, schema), { value: { result: body }, lifted: true, key: 'result' });
});

test('a patch cannot smuggle the body back as its value', async () => {
  const current = state();
  await assert.rejects(acceptSemanticResult(current, { summary: 'draft', result: { draft: { title: 'x'.repeat(5000) } } }, validate));
  await assert.rejects(acceptSemanticResult(current, {
    summary: 'too big', stage_id: current.staged.id,
    patch: [{ op: 'set', path: '/note', value: 'y'.repeat(5000) }],
  }, validate), error => error.code === 'PI_RESULT_PATCH');
  assert.equal(current.submission, null);
});
