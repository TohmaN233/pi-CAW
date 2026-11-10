// Runnable offline SDK example. All model output uses Pi's native faux provider;
// execution, sessions, tools, journals and proposal receipts use the real SDK.
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as sdk from '@earendil-works/pi-coding-agent';
import * as ai from '@earendil-works/pi-ai/compat';
import { PiSdkHost } from '../lib/pi-sdk-host.mjs';
import { PiCawService } from '../lib/service.mjs';
import { createDraft } from '../core/workflow-schema.mjs';
import { digest } from '../core/workflow-revisions.mjs';

const provider = 'caw-evolution-offline';
export function offlineImplementationFiles() {
  const sdkEntry = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'));
  const sdkRoot = dirname(sdkEntry);
  const requireFromSdk = createRequire(sdkEntry);
  const agentCorePackage = requireFromSdk.resolve('@earendil-works/pi-agent-core/package.json');
  const agentCoreRoot = join(dirname(agentCorePackage), 'dist');
  const aiRoot = dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-ai/compat')));
  // Explicit bounded implementation manifest for this installed offline SDK.
  // Production adapters must name their actual SDK/backend implementation files.
  return [
    ...['index.js', 'core/sdk.js', 'core/agent-session.js', 'core/agent-session-runtime.js', 'core/agent-session-services.js', 'core/model-runtime.js', 'core/resource-loader.js', 'core/session-manager.js', 'core/settings-manager.js', 'core/extensions/runner.js'].map(path => join(sdkRoot, path)),
    ...['index.js', 'agent.js', 'agent-loop.js', 'stream-fn.js'].map(path => join(agentCoreRoot, path)),
    ...['index.js', 'compat.js', 'models.js', 'providers/faux.js'].map(path => join(aiRoot, path)),
  ];
}
async function offlineHost({ directory, workspace }) {
  await mkdir(directory, { recursive: true }); await mkdir(workspace, { recursive: true });
  await writeFile(join(directory, 'settings.json'), JSON.stringify({ packages: [], retry: { enabled: false } }));
  const faux = ai.fauxProvider({ provider, api: 'caw-evolution-offline-api', models: [{ id: 'offline', reasoning: false }], tokensPerSecond: 0 });
  faux.setResponses([
    context => {
      const improved = JSON.stringify(context).includes('Return the improved value');
      return ai.fauxAssistantMessage(ai.fauxToolCall('caw_submit_result', { result: { text: improved ? 'new' : 'old' }, summary: 'Offline objective fixture' }), { stopReason: 'toolUse' });
    },
    ai.fauxAssistantMessage('Submitted exact values.'),
  ]);
  const runtime = await sdk.ModelRuntime.create({ authPath: join(directory, 'auth.json'), modelsPath: null, refreshOnCreate: false });
  runtime.registerNativeProvider(faux.provider); await runtime.refresh({ allowNetwork: false });
  const sessionManager = sdk.SessionManager.create(workspace, join(directory, 'sessions'));
  const context = { cwd: workspace, sessionManager, modelRegistry: new sdk.ModelRegistry(runtime), model: faux.getModel(), thinkingLevel: 'off', isProjectTrusted: () => false };
  const host = new PiSdkHost({ sdk, Type: ai.Type, supportedThinking: ai.getSupportedThinkingLevels, agentDir: directory, getContext: () => context });
  host.modelRuntimes.set(provider, runtime); return host;
}

export async function createEvolutionContext({ root = resolve(process.env.PI_CAW_EVOLUTION_HOME ?? '.test-tmp/evolution-offline') } = {}) {
  root = resolve(root);
  const sourceDirectory = join(root, 'source'), workspace = join(root, 'source-workspace');
  const host = await offlineHost({ directory: join(root, 'source-agent'), workspace });
  const sourceService = await new PiCawService({ directory: sourceDirectory, host, workerMode: true }).initialize();
  const id = 'evolution-offline-example';
  let pack;
  try { pack = await sourceService.store.snapshot(id); }
  catch (error) {
    if (error.code !== 'ENOENT') { await sourceService.close(); throw error; }
    const schema = { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false };
    const graph = { ...createDraft(id, 'Offline Workflow evolution example'), status: 'ready', inputs_schema: { type: 'object', properties: { task: { type: 'string' } }, required: ['task'] }, outputs_schema: schema,
      finalization: { required: true, node_id: 'final' },
      nodes: [{ id: 'start', type: 'start' }, { id: 'final', type: 'agent', executor: { kind: 'main', mode: 'worker' }, role: 'finalizer', access: 'read_only', prompt_template: 'Return the old value.', approval: { required: false }, retry: { max_attempts: 1 }, input_bindings: { task: '/inputs/task' }, outputs_schema: schema }, { id: 'end', type: 'end' }],
      edges: [{ id: 'first', source: 'start', target: 'final' }, { id: 'last', source: 'final', target: 'end' }] };
    await sourceService.store.create(graph); pack = await sourceService.store.snapshot(id);
  }
  return { sourceService, directory: join(root, 'evaluation'), createHost: offlineHost,
    implementationIdentity: { sdk_files: offlineImplementationFiles(), host_files: [fileURLToPath(import.meta.url)] },
    examplePack: pack, root };
}

export async function prepareExample(options) {
  const context = await createEvolutionContext(options);
  try {
    const workflow = structuredClone(context.examplePack.workflow);
    workflow.nodes.find(node => node.id === 'final').prompt_template = 'Return the improved value.';
    const packet = { workflow_id: workflow.id, expected_revision: context.examplePack.revision_hash, workflow,
      cause: 'The exact-text fixture should return the new value.', evidence_refs: [{ source_ref: 'offline-fixture:expected-text', sha256: digest('new') }],
      suite: { id: 'offline-exact-text', repetitions: 1, samples: [{ id: 'text', inputs: { task: 'Produce the declared text.' }, assertions: [{ pointer: '/text', equals: 'new' }] }] } };
    const path = join(context.root, 'capture.json'); await writeFile(path, JSON.stringify(packet, null, 2)); return path;
  } finally { await context.sourceService.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] !== 'prepare') throw new Error('Usage: node examples/evolution-offline.mjs prepare');
  console.log(await prepareExample());
}
