import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, workflow, agent, settle } from './fixtures.mjs';
import { createPiToolBroker } from '../lib/host-tools.mjs';
import { digest } from '../core/workflow-revisions.mjs';

const edge = (source, target, label) => ({ id: `${source}-${target}`, source, target, ...(label ? { label } : {}) });

test('Pi strict child writes use owned Git worktrees and exact human integration before current-chat final review', async t => {
  const operations = [], writes = [];
  const f = await fixture(t, { resultFor: async request => {
    if (request.kind === 'main') return { text: 'Both accepted branch changes reviewed in the current chat.' };
    const path = `src/${request.node_id}.txt`, sibling = `src/${request.node_id === 'a' ? 'b' : 'a'}.txt`;
    const broker = await createPiToolBroker({ workspace: request.workspace, access: request.access, allowedPaths: request.allowed_paths,
      recoverToolErrors: true,
      authorize: async () => assert.equal(request.signal.aborted, false),
      onOperation: async metadata => { operations.push({ node_id: request.node_id, ...metadata }); await request.onOperation(metadata); } });
    try {
      const rejected = await broker.call('write_workspace', { path: sibling, text: 'Outside this branch', expected_sha256: null }, 'outside');
      assert.equal(rejected.success, false);
      assert.equal(JSON.parse(rejected.contentItems[0].text).error.code, 'PI_TOOL_WRITE_DENIED');
      const before = await readFile(join(request.workspace, path));
      await broker.call('write_workspace', { path, text: `Branch ${request.node_id.toUpperCase()}\n`, expected_sha256: digest(before) }, `write-${request.node_id}`);
      writes.push({ node_id: request.node_id, workspace: request.workspace, path });
      return { text: `Completed ${request.node_id}.` };
    } finally { broker.revoke(); assert.equal((await broker.quiesce()).quiescent, true); }
  } });
  f.host.capabilities.scoped_file_writes = true;
  const createTask = f.host.createTask.bind(f.host);
  f.host.createTask = async request => {
    const task = await createTask(request), run = task.run.bind(task);
    task.run = async input => ({ ...await run(input), changed_paths: request.kind === 'main' ? [] : [`src/${request.node_id}.txt`] });
    return task;
  };
  const git = f.service.parallel.git;
  await git.initialize(); await git.git(f.workspace, ['init', '-b', 'main']); await mkdir(join(f.workspace, 'src'));
  for (const id of ['a', 'b']) await writeFile(join(f.workspace, 'src', `${id}.txt`), `Base ${id}\n`);
  await git.git(f.workspace, ['add', '--all']); await git.git(f.workspace, ['commit', '-m', 'Offline Pi fixture base']);
  const head = await git.text(f.workspace, ['rev-parse', 'HEAD']);
  const index = digest(await readFile(join(f.workspace, '.git', 'index')));
  const strict = { mode: 'strict', implicit: 'deny', ambient_allow: [], shadowed_skill_paths: [] };
  const a = { ...agent('a'), role: 'implementer', access: 'bounded_write', path_scope: ['src/a.txt'], skill_policy: strict };
  const b = { ...agent('b'), role: 'implementer', access: 'bounded_write', path_scope: ['src/b.txt'], skill_policy: strict };
  const graph = workflow([a, b]);
  graph.skill_policy = { mode: 'cooperative', implicit: 'deny', ambient_allow: [], shadowed_skill_paths: [] };
  const final = graph.nodes.find(node => node.id === 'final');
  final.skill_policy = { mode: 'cooperative', implicit: 'deny', ambient_allow: [], shadowed_skill_paths: [] };
  graph.nodes = [{ id: 'start', type: 'start' }, { id: 'fork', type: 'parallel', join_id: 'join' }, a, b,
    { id: 'join', type: 'join', parallel_id: 'fork' }, final, { id: 'end', type: 'end' }];
  graph.edges = [edge('start', 'fork'), edge('fork', 'a', 'a'), edge('fork', 'b', 'b'), edge('a', 'join'), edge('b', 'join'), edge('join', 'final'), edge('final', 'end')];
  await f.service.call('create_workflow', { workflow: graph });
  const run = await f.service.call('run', { workflow_id: graph.id, workspace: f.workspace, access: 'bounded_write', allowed_paths: ['src'], inputs: { task: 'Apply both independent branch edits.' } });
  const pending = (await settle(f.service, run.run_id)).state;
  assert.equal(pending.status, 'blocked', JSON.stringify(f.notifications)); assert.equal(pending.nodes.join.status, 'blocked');
  assert.equal(pending.nodes.a.status, 'succeeded'); assert.equal(pending.nodes.b.status, 'succeeded');
  assert.equal(f.requests.length, 2); assert.equal(f.mainRequests.length, 0);
  const [left, right] = f.requests;
  assert(left.strict && right.strict); assert.notEqual(left.workspace, right.workspace);
  for (const request of f.requests) {
    assert.notEqual(request.workspace, f.workspace); assert.deepEqual(request.allowed_paths, [`src/${request.node_id}.txt`]);
    assert.equal(Object.values(pending.parallel.fork.branches).some(owner => owner.workspace === request.workspace), true);
  }
  assert.equal(writes.length, 2);
  assert.equal(operations.filter(item => item.phase === 'committed').length, 2);
  for (const id of ['a', 'b']) assert.equal(await readFile(join(f.workspace, 'src', `${id}.txt`), 'utf8'), `Base ${id}\n`);
  const proposal = await f.service.call('prepare_integration', { run_id: run.run_id, region_id: 'fork' });
  const review = await f.service.call('review_integration', { run_id: run.run_id, region_id: 'fork' });
  assert.equal(digest(Buffer.from(review.patch)), proposal.patch_sha256);
  assert.match(review.patch, /Branch A/); assert.match(review.patch, /Branch B/);
  const acceptance = { run_id: run.run_id, region_id: 'fork', accepted: true, patch_sha256: proposal.patch_sha256 };
  await assert.rejects(f.service.call('integrate_parallel', acceptance), { code: 'HUMAN_INTEGRATION_REQUIRED' });
  await assert.rejects(f.service.call('integrate_parallel', { ...acceptance, patch_sha256: '0'.repeat(64) }, { human: true }), { code: 'PARALLEL_PROPOSAL_CHANGED' });
  assert.equal(f.mainRequests.length, 0);
  await f.service.call('integrate_parallel', acceptance, { human: true });
  const integrated = (await settle(f.service, run.run_id)).state;
  assert.equal(integrated.parallel.fork.phase, 'merged'); assert.equal(integrated.parallel.fork.integration.patch_sha256, proposal.patch_sha256);
  for (const id of ['a', 'b']) assert.equal(await readFile(join(f.workspace, 'src', `${id}.txt`), 'utf8'), `Branch ${id.toUpperCase()}\n`);
  assert.equal(await git.text(f.workspace, ['rev-parse', 'HEAD']), head);
  assert.equal(digest(await readFile(join(f.workspace, '.git', 'index'))), index);
  assert.equal(f.mainRequests.length, 1); assert.equal(f.mainRequests[0].strict, false);
  assert.equal(f.mainRequests[0].workspace, f.workspace); assert.equal(f.mainRequests[0].binding, null);
  assert.equal(integrated.nodes.final.attempts[0].dispatch.receipt.session_id, f.mainSession);
  const finalProposal = await f.service.call('final_proposal', { run_id: run.run_id });
  await f.service.call('accept_final', { run_id: run.run_id, accepted: true, proposal_sha256: finalProposal.proposal_sha256 }, { human: true });
  assert.equal((await settle(f.service, run.run_id)).state.status, 'succeeded');
  const cleanup = await f.service.call('cleanup_parallel', { run_id: run.run_id }, { human: true });
  assert.equal(cleanup.removed.length, 2);
  assert.deepEqual((await f.service.call('cleanup_parallel', { run_id: run.run_id }, { human: true })).removed, []);
});

test('cooperative parallel writers remain blocked before worktree provisioning or model dispatch', async t => {
  const f = await fixture(t); f.host.capabilities.scoped_file_writes = true;
  const a = { ...agent('a'), access: 'bounded_write', path_scope: ['src/a.txt'] };
  const b = { ...agent('b'), access: 'bounded_write', path_scope: ['src/b.txt'] };
  const graph = workflow([a, b]), final = graph.nodes.find(node => node.id === 'final');
  graph.nodes = [{ id: 'start', type: 'start' }, { id: 'fork', type: 'parallel', join_id: 'join' }, a, b,
    { id: 'join', type: 'join', parallel_id: 'fork' }, final, { id: 'end', type: 'end' }];
  graph.edges = [edge('start', 'fork'), edge('fork', 'a', 'a'), edge('fork', 'b', 'b'), edge('a', 'join'), edge('b', 'join'), edge('join', 'final'), edge('final', 'end')];
  await f.service.call('create_workflow', { workflow: graph });
  await assert.rejects(f.service.call('run', { workflow_id: graph.id, workspace: f.workspace, access: 'bounded_write',
    allowed_paths: ['src'], inputs: { task: 'Do not execute cooperative parallel writes.' } }), { code: 'PARALLEL_EXECUTOR_UNQUALIFIED' });
  assert.equal((await f.service.call('runs')).length, 0);
  assert.equal(f.requests.length, 0); assert.equal(f.mainRequests.length, 0);
});
