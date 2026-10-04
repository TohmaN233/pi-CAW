import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { PiSdkHost } from '../lib/pi-sdk-host.mjs';
import { resolveBinding } from '../lib/models.mjs';

const sdk = await import('@earendil-works/pi-coding-agent');
const ai = await import('@earendil-works/pi-ai/compat');
const root = resolve(import.meta.dirname, '../.artifacts', `pi-own-smoke-${randomUUID()}`);
const agentDir = join(root, 'agent'); const workspace = join(root, 'workspace'); const sessions = join(agentDir, 'sessions');
await mkdir(workspace, { recursive: true }); await mkdir(agentDir, { recursive: true });
await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ packages: [], retry: { enabled: false } }));
await writeFile(join(root, 'outside-secret.txt'), 'must remain outside the strict task');
await writeFile(join(workspace, 'declared.txt'), 'scoped fixture input');
const faux = ai.fauxProvider({ provider: `pi-caw-fixture-${randomUUID()}`, models: [{ id: 'fixture', reasoning: false }], tokensPerSecond: 0 });
const runtime = await sdk.ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null, refreshOnCreate: false });
runtime.registerNativeProvider(faux.provider); await runtime.refresh({ allowNetwork: false });
const registry = new sdk.ModelRegistry(runtime);
const parent = sdk.SessionManager.create(workspace, sessions); parent.appendSessionInfo('Offline Pi CAW parent');
const context = { cwd: workspace, modelRegistry: registry, scopedModels: [], sessionManager: parent, model: faux.getModel(), thinkingLevel: 'off' };
const host = new PiSdkHost({ sdk, Type: ai.Type, supportedThinking: ai.getSupportedThinkingLevels, agentDir,
  getContext: () => context, sessionDirectory: sessions });
const binding = resolveBinding({ provider: faux.getModel().provider, model_id: faux.getModel().id, thinking: 'off' }, host.catalog());
const resultSchema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
const request = { run_id: randomUUID(), node_id: 'test', name: 'Offline integration', kind: 'subagent', binding,
  workspace, access: 'read_only', allowed_paths: [], schema: resultSchema, resources: [], strict: true };
try {
  const loader = new sdk.DefaultResourceLoader({ cwd: workspace, agentDir, noSkills: true, noPromptTemplates: true,
    noThemes: true, noContextFiles: true, additionalExtensionPaths: [resolve(import.meta.dirname, '../extensions/pi-caw.ts')] });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, [], 'Pi must load the independent plugin through its actual extension loader');
  assert(loader.getExtensions().extensions.some(extension => extension.tools.has('caw')));
  faux.setResponses([
    ai.fauxAssistantMessage(ai.fauxToolCall('read', { path: join(root, 'outside-secret.txt') }), { stopReason: 'toolUse' }),
    ai.fauxAssistantMessage(ai.fauxToolCall('read_workspace', { path: 'declared.txt' }), { stopReason: 'toolUse' }),
    ai.fauxAssistantMessage(ai.fauxToolCall('caw_submit_result', { result: { ok: true }, summary: 'Offline task complete' }), { stopReason: 'toolUse' }), ai.fauxAssistantMessage('Done.')]);
  const task = await host.createTask(request);
  const output = await task.run({ prompt: 'Perform the scripted fixture task.', schema: resultSchema });
  assert.equal(output.result.ok, true); assert(output.turn_id); assert(output.user_entry_id);
  const sessionId = task.session_id, file = output.session_file;
  const entries = (await readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert(entries.some(entry => entry.id === output.turn_id && entry.message?.role === 'assistant'));
  assert(entries.some(entry => entry.message?.role === 'toolResult' && entry.message.toolName === 'read' && entry.message.isError), 'Strict tasks cannot use the native absolute-path read bypass');
  assert(entries.some(entry => entry.message?.role === 'toolResult' && entry.message.toolName === 'read_workspace' && !entry.message.isError));
  const mixed = await host.executionRequest({ ...request, strict: false,
    runtime_environment: { status: 'ready', requirements: { executables: [] }, tools: [{ name: 'explicit_program', path: process.execPath, status: 'found' }] } });
  assert.deepEqual(mixed.runtime_environment.tools.map(item => item.name), ['explicit_program', 'node', 'shell']);
  await host.releaseTask(task);
  faux.setResponses([ai.fauxAssistantMessage(ai.fauxToolCall('caw_submit_result', { result: { ok: true }, summary: 'Continuation complete' }), { stopReason: 'toolUse' }), ai.fauxAssistantMessage('Continued.')]);
  const continuation = await host.createTask({ ...request, kind: 'thread', session_id: sessionId, session_file: file });
  assert.equal(continuation.session_id, sessionId);
  const next = await continuation.run({ prompt: 'Continue the exact previous fixture session.', schema: resultSchema });
  assert.notEqual(next.turn_id, output.turn_id);
  assert.equal(next.session_id, sessionId);
  await host.releaseTask(continuation);
  const operations = [];
  faux.setResponses([
    ai.fauxAssistantMessage(ai.fauxToolCall('run_task_program', { program: 'node', args: ['-e', 'process.stdout.write("native program ok")'], cwd: 'workspace' }), { stopReason: 'toolUse' }),
    ai.fauxAssistantMessage(ai.fauxToolCall('caw_submit_result', { result: { ok: true }, summary: 'Cooperative native program complete' }), { stopReason: 'toolUse' }),
    ai.fauxAssistantMessage('Program done.')]);
  const programTask = await host.createTask({ ...request, run_id: randomUUID(), strict: false, onOperation: item => operations.push(item) });
  const programOutput = await programTask.run({ prompt: 'Run the scripted native program fixture.', schema: resultSchema });
  assert(programOutput.result.ok);
  assert(operations.some(item => item.tool === 'run_task_program' && item.phase === 'completed' && item.exit_code === 0));
  assert(operations.some(item => item.phase === 'effects' && item.outside_paths.length === 0));
  await host.releaseTask(programTask);
  const receipt = { host: 'native-pi', sdk_version: sdk.VERSION,
    offline: true, real_model_calls: 0, extension_loaded: true, session_id: sessionId, turn_ids: [output.turn_id, next.turn_id],
    checks: ['native-extension-loader', 'explicit-model-and-thinking', 'SDK-subagent', 'strict-read-scope', 'semantic-result-tool', 'JSONL-turn-correlation', 'persistent-session-continuation', 'cooperative-native-program', 'explicit-plus-general-programs', 'program-effect-observation', 'SDK-usage-metering'],
    evidence_directory: root };
  await writeFile(join(root, 'receipt.json'), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt, null, 2));
} finally { await host.close(); }
