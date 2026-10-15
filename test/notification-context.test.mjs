import assert from 'node:assert/strict';
import test from 'node:test';
import { projectWorkflowContext } from '../lib/notification-context.mjs';

const card = event => ({ role: 'custom', customType: 'pi-caw:completion', content: JSON.stringify(event),
  details: { privateTranscript: 'DETAILS_SENTINEL' }, display: true, timestamp: 123 });

test('UI cards and node history stay on disk while model context gets one brief result and artifact paths', () => {
  const event = { run_id: 'run-example', delivery_id: 'delivery-example', status: 'succeeded',
    feedback: { workflow_name: 'Example', files: ['/workspace/result.pdf'], nodes: [{ instruction: 'NODE_SENTINEL' }] },
    result: { summary: 'Saved PDF; human review pending.', body: 'BODY_SENTINEL' }, approvals: [{ prompt: 'APPROVAL_SENTINEL' }] };
  const original = card(event), status = { ...original, customType: 'pi-caw:status' }, messages = [status, original, structuredClone(original)];
  const before = JSON.stringify(messages);
  const projected = projectWorkflowContext(messages);
  assert.equal(JSON.stringify(messages), before);
  assert.equal(projected.length, 1);
  assert.equal(projected[0].customType, 'pi-caw:notification');
  assert.equal(projected[0].display, false);
  const notice = JSON.parse(projected[0].content);
  assert.equal(notice.summary, 'Saved PDF; human review pending.');
  assert.deepEqual(notice.files, ['/workspace/result.pdf']);
  assert.doesNotMatch(JSON.stringify(projected), /NODE_SENTINEL|BODY_SENTINEL|DETAILS_SENTINEL|APPROVAL_SENTINEL/);
});

test('failures remain actionable, large summaries are brief, and independent Role replies retain their result', () => {
  const role = card({ role_run_id: 'role-example', status: 'completed', result: { answer: 'Actual delegated answer' } });
  const projected = projectWorkflowContext([role, card({ run_id: 'run-example', status: 'failed', error: { code: 'COMPILE_FAILED', message: 'Missing package', stack: 'STACK_SENTINEL' }, summary: 's'.repeat(5000) })]);
  assert.strictEqual(projected[0], role);
  const notice = JSON.parse(projected[1].content);
  assert.deepEqual(notice.error, { code: 'COMPILE_FAILED', message: 'Missing package' });
  assert.equal(notice.summary.length, 600);
  assert.doesNotMatch(projected[1].content, /STACK_SENTINEL/);
  assert.throws(() => projectWorkflowContext([{ ...role, content: '{broken' }]), SyntaxError);
});
