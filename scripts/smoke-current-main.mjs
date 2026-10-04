import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { WorkflowStore } from '../core/workflow-store.mjs';
import { WorkflowRunStore } from '../core/workflow-run-store.mjs';
import { workflow } from '../test/fixtures.mjs';

const sdk = await import('@earendil-works/pi-coding-agent');
const ai = await import('@earendil-works/pi-ai/compat');
const root = resolve(import.meta.dirname, '../.artifacts', `current-main-smoke-${randomUUID()}`);
const agentDir = join(root, 'agent'), workspace = join(root, 'workspace'), state = join(root, 'state');
await mkdir(workspace, { recursive: true }); await mkdir(agentDir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir; process.env.PI_CAW_DIR = state;
await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ packages: [], retry: { enabled: false } }));
const store = await new WorkflowStore(join(state, 'workflows')).initialize(); const graph=workflow([]);graph.nodes.find(node=>node.id==='final').executor.mode='orchestration';await store.create(graph);
const faux = ai.fauxProvider({ provider: `current-main-fixture-${randomUUID()}`, models: [{ id: 'current-chat', reasoning: false }], tokensPerSecond: 0 });
const runtime = await sdk.ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null, refreshOnCreate: false });
runtime.registerNativeProvider(faux.provider); await runtime.refresh({ allowNetwork: false });
const manager = sdk.SessionManager.create(workspace, join(agentDir, 'sessions'));
const loader = new sdk.DefaultResourceLoader({ cwd: workspace, agentDir, noSkills: true, noPromptTemplates: true,
  noThemes: true, noContextFiles: true, additionalExtensionPaths: [resolve(import.meta.dirname, '../extensions/pi-caw.ts')] });
await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
const created = await sdk.createAgentSession({ cwd: workspace, agentDir, modelRuntime: runtime, model: faux.getModel(),
  thinkingLevel: 'off', sessionManager: manager, resourceLoader: loader, tools: ['caw'], noTools: 'all' });
const session = created.session, errors = [];
try {
  await session.bindExtensions({ mode: 'rpc', onError: error => errors.push(error), abortHandler: () => { void session.abort(); } });
  const tool = params => ai.fauxAssistantMessage(ai.fauxToolCall('caw', params), { stopReason: 'toolUse' });
  faux.setResponses([tool({ action: 'run', args: { workflow_id: 'example', access: 'read_only', inputs: { task: 'Execute Main in this exact chat' } } }),
    ai.fauxAssistantMessage('Run started.'), tool({ action: 'main_task' }),
    tool({ action: 'main_tool', args: { name: 'run_task_program', args: { program: 'node', args: ['-e', 'process.stdout.write("current-chat program ok")'], cwd: 'workspace' } } }),
    tool({ action: 'main_result', args: { result: { text: 'Current Pi chat completed Main' }, summary: 'Verified Main proposal' } }),
    ai.fauxAssistantMessage('Main proposal ready.'), ai.fauxAssistantMessage('Waiting for human acceptance.')]);
  await session.prompt('Start the fixture workflow now.');
  const runs = await new WorkflowRunStore(join(state, 'runs')).initialize();
  let record;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const list = await runs.list();
    if (list.length) { record = await runs.read(list[0].run_id); if (record.state.nodes.final.attempts.at(-1)?.result_proposal || record.state.status === 'failed') break; }
    await new Promise(resolveWait => setTimeout(resolveWait, 25));
  }
  assert.deepEqual(errors, [], 'Actual Pi extension events must report no errors');
  assert(record?.state.nodes.final.attempts.at(-1)?.result_proposal, JSON.stringify(record?.state));
  const attempt = record.state.nodes.final.attempts.at(-1);
  assert.equal(record.state.main_actor, manager.getSessionId());
  assert.equal(attempt.dispatch.receipt.executor, 'pi-current-chat-main');
  assert.equal(attempt.dispatch.receipt.session_id, manager.getSessionId());
  const proposal = await runs.readExecutorResult(record.state.run_id, attempt.id, attempt.result_proposal.sha256);
  assert.equal(proposal.structured_output.text, 'Current Pi chat completed Main');
  const turn = proposal.evidence[0].turn_id;
  assert(manager.getEntries().some(entry => entry.id === turn && entry.message?.role === 'assistant'));
  const receipt = { host: 'native-pi', offline: true, real_model_calls: 0, main_is_current_chat: true,
    parent_session_id: manager.getSessionId(), main_session_id: attempt.dispatch.receipt.session_id, main_turn_id: turn,
    final_human_acceptance_pending: true, checks: ['native-extension-events', 'follow-up-message-dispatch', 'current-chat-Main', 'no-Main-model-binding', 'exact-turn-result-proof'], evidence_directory: root };
  await writeFile(join(root, 'receipt.json'), JSON.stringify(receipt, null, 2)); console.log(JSON.stringify(receipt, null, 2));
} finally { await session.extensionRunner.emit({ type: 'session_shutdown' }); await session.abort(); session.dispose(); }
