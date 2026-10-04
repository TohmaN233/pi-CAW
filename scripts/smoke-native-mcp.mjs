import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { childMcpFactories, loadNativeMcpCatalog } from '../lib/native-mcp.mjs';
import { PiSdkHost } from '../lib/pi-sdk-host.mjs';
import { resolveBinding } from '../lib/models.mjs';

const sdk = await import('@earendil-works/pi-coding-agent');
const ai = await import('@earendil-works/pi-ai/compat');
const root = resolve(import.meta.dirname, '../.artifacts', `native-mcp-smoke-${randomUUID()}`);
const agentDir = join(root, 'agent'), cwd = join(root, 'workspace');
await mkdir(agentDir, { recursive: true }); await mkdir(cwd);
await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ packages: [], retry: { enabled: false } }));
const calls = [], errors = [];
const http = createServer(async (request, response) => {
  if (request.method !== 'POST') { response.writeHead(405); response.end(); return; }
  let text = ''; for await (const chunk of request) text += chunk;
  const message = JSON.parse(text); calls.push(message.method);
  if (message.id === undefined) { response.writeHead(202); response.end(); return; }
  let result;
  if (message.method === 'initialize') result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'native-offline-smoke', version: '1.0' } };
  else if (message.method === 'tools/list') result = { tools: [{ name: 'echo', description: 'Echo fixture input',
    inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] }, annotations: { readOnlyHint: true } }] };
  else if (message.method === 'tools/call') result = { content: [{ type: 'text', text: message.params.arguments.value }] };
  else if (message.method === 'resources/list') result = { resources: [{ uri: 'fixture://resource', name: 'Fixture resource', mimeType: 'text/plain' }] };
  else if (message.method === 'resources/templates/list') result = { resourceTemplates: [] };
  else if (message.method === 'resources/read') result = { contents: [{ uri: 'fixture://resource', mimeType: 'text/plain', text: 'Native resource verified' }] };
  else result = {};
  response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
});
await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
let session, host, factories = [];
try {
  const catalog = await loadNativeMcpCatalog({ sdk, agentDir, cwd, projectTrusted: false, registeredServers: [
    { name: 'fixture', config: { url: `http://127.0.0.1:${http.address().port}/mcp`, exposure: 'direct', timeout: 5 }, extensionPath: 'offline-native-fixture' },
    { name: 'unselected', config: { command: 'must-not-launch' }, extensionPath: 'offline-native-fixture' },
  ] });
  factories = childMcpFactories({ sdk, catalog, requiredServers: ['fixture'] });
  const faux = ai.fauxProvider({ provider: `pi-caw-mcp-fixture-${randomUUID()}`, models: [{ id: 'fixture', reasoning: false }], tokensPerSecond: 0 });
  const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider); await modelRuntime.refresh({ allowNetwork: false });
  const manager = sdk.SessionManager.create(cwd, join(agentDir, 'sessions'));
  const loader = new sdk.DefaultResourceLoader({ cwd, agentDir, noExtensions: true, extensionFactories: factories,
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    systemPrompt: 'Execute the scripted offline fixture using the declared native MCP tools.' });
  await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
  const created = await sdk.createAgentSession({ cwd, agentDir, modelRuntime, model: faux.getModel(), thinkingLevel: 'off',
    sessionManager: manager, resourceLoader: loader, noTools: 'builtin' });
  session = created.session;
  await session.bindExtensions({ mode: 'rpc', onError: error => errors.push({ event: error.event, message: error.error }) });
  await Promise.all(factories.map(factory => factory.ready).filter(Boolean));
  assert.ok(session.getActiveToolNames().includes('mcp__fixture__echo'));
  assert.ok(!session.getActiveToolNames().some(name => ['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls'].includes(name)));
  assert.ok(!session.getActiveToolNames().some(name => name.includes('unselected')));
  faux.setResponses([
    ai.fauxAssistantMessage(ai.fauxToolCall('mcp__fixture__echo', { value: 'Native Pi MCP tool verified' }), { stopReason: 'toolUse' }),
    ai.fauxAssistantMessage(ai.fauxToolCall('list_mcp_resources', { server: 'fixture' }), { stopReason: 'toolUse' }),
    ai.fauxAssistantMessage(ai.fauxToolCall('read_mcp_resource', { server: 'fixture', uri: 'fixture://resource' }), { stopReason: 'toolUse' }),
    ai.fauxAssistantMessage('Offline native MCP session completed.'),
  ]);
  await session.prompt('Run the scripted native MCP fixture.');
  const messages = manager.getEntries().filter(entry => entry.type === 'message').map(entry => entry.message);
  assert.ok(messages.some(message => message.role === 'toolResult' && message.toolName === 'mcp__fixture__echo' && !message.isError));
  assert.ok(messages.some(message => message.role === 'toolResult' && message.toolName === 'read_mcp_resource' && !message.isError));
  assert.deepEqual(errors, []); assert.ok(calls.includes('tools/call')); assert.ok(calls.includes('resources/read'));
  await factories.at(-1).close(); await session.abort(); session.dispose(); session = null;
  const registry = new sdk.ModelRegistry(modelRuntime), parent = sdk.SessionManager.create(cwd, join(agentDir, 'sessions'));
  const context = { cwd, modelRegistry: registry, scopedModels: [], sessionManager: parent, model: faux.getModel(), thinkingLevel: 'off', isProjectTrusted: () => false };
  let exposure = 'direct';
  host = new PiSdkHost({ sdk, Type: ai.Type, supportedThinking: ai.getSupportedThinkingLevels, agentDir,
    getContext: () => context, getMcpServers: () => [
      { name: 'fixture', config: { url: `http://127.0.0.1:${http.address().port}/mcp`, exposure, timeout: 5 }, extensionPath: 'offline-native-fixture' },
      { name: 'unselected', config: { command: 'must-not-launch' }, extensionPath: 'offline-native-fixture' },
    ], sessionDirectory: join(agentDir, 'sessions') });
  const binding = resolveBinding({ provider: faux.getModel().provider, model_id: faux.getModel().id, thinking: 'off' }, host.catalog());
  const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
  const hostTasks = [];
  for (exposure of ['direct', 'codemode', 'deferred']) {
    const scripted = exposure === 'codemode' ? [ai.fauxAssistantMessage(ai.fauxToolCall('codemode', {
      code: 'if (ALL_TOOLS.some(t => ["read","write","edit","bash","grep","find","ls"].includes(t.name))) throw new Error("Unsafe builtin tool escaped strict scope"); text(await tools.mcp__fixture__echo({value:"Native codemode verified"})); text(await tools.read_mcp_resource({server:"fixture",uri:"fixture://resource"}));',
    }), { stopReason: 'toolUse' })] : [
      ...(exposure === 'deferred' ? [ai.fauxAssistantMessage(ai.fauxToolCall('tool_search', { query: 'fixture echo resource', limit: 8 }), { stopReason: 'toolUse' })] : []),
      ai.fauxAssistantMessage(ai.fauxToolCall('mcp__fixture__echo', { value: `Native ${exposure} Host verified` }), { stopReason: 'toolUse' }),
      ai.fauxAssistantMessage(ai.fauxToolCall('read_mcp_resource', { server: 'fixture', uri: 'fixture://resource' }), { stopReason: 'toolUse' }),
    ];
    faux.setResponses([...scripted,
      ai.fauxAssistantMessage(ai.fauxToolCall('caw_submit_result', { result: { ok: true }, summary: `Native ${exposure} MCP complete` }), { stopReason: 'toolUse' }),
      ai.fauxAssistantMessage('Native MCP Host task completed.'),
    ]);
    const task = await host.createTask({ run_id: randomUUID(), node_id: 'native-mcp', name: 'Offline native MCP integration', kind: 'subagent',
      binding, workspace: cwd, access: 'read_only', allowed_paths: [], schema, resources: [], strict: true, required_mcp_servers: ['fixture'] });
    const output = await task.run({ prompt: 'Execute the scripted native MCP tools, then submit the semantic result.', schema });
    assert.equal(output.result.ok, true); assert.deepEqual(output.changed_paths, []);
    const entries = sdk.SessionManager.open(task.session_file, undefined, cwd).getEntries();
    const toolResults = entries.filter(entry => entry.type === 'message' && entry.message.role === 'toolResult').map(entry => entry.message);
    assert.ok(toolResults.some(message => message.toolName === (exposure === 'codemode' ? 'codemode' : 'mcp__fixture__echo')));
    assert.ok(toolResults.every(message => !message.isError), JSON.stringify(toolResults));
    assert.ok(!toolResults.some(message => message.toolName.includes('unselected')));
    hostTasks.push({ exposure, session_id: task.session_id, session_file: task.session_file, turn_id: output.turn_id, changed_paths: output.changed_paths });
    await host.releaseTask(task); assert.equal(host.tasks.size, 0);
  }
  // A native MCP call uses the same exact lease fence as broker tools.
  exposure = 'direct';
  const effectsBeforeRevocation = calls.filter(method => method === 'tools/call').length;
  faux.setResponses([
    ai.fauxAssistantMessage(ai.fauxToolCall('mcp__fixture__echo', { value: 'Must never reach the server' }), { stopReason: 'toolUse' }),
    ai.fauxAssistantMessage('Revoked fixture turn ended.'),
  ]);
  const revoked = await host.createTask({ run_id: randomUUID(), node_id: 'revoked-native-mcp', name: 'Revoked MCP authority', kind: 'subagent',
    binding, workspace: cwd, access: 'read_only', allowed_paths: [], schema, resources: [], strict: true, required_mcp_servers: ['fixture'],
    authorize: async () => { throw Object.assign(new Error('Exact controller lease was revoked'), { code: 'LEASE_REVOKED' }); } });
  await assert.rejects(revoked.run({ prompt: 'Exercise the revoked native MCP lease.', schema }), { code: 'PI_RESULT_MISSING' });
  assert.equal(calls.filter(method => method === 'tools/call').length, effectsBeforeRevocation);
  const revokedEntries = sdk.SessionManager.open(revoked.session_file, undefined, cwd).getEntries();
  assert.ok(revokedEntries.some(entry => entry.message?.role === 'toolResult' && entry.message.isError
    && JSON.stringify(entry.message.content).includes('LEASE_REVOKED')));
  await host.releaseTask(revoked); assert.equal(host.tasks.size, 0);
  const evidence = { sdk_version: sdk.VERSION, session_id: manager.getSessionId(), session_file: manager.getSessionFile(),
    required_servers: catalog.servers.filter(server => server.name === 'fixture'), host_tasks: hostTasks, tool_calls: calls,
    model_transport: 'offline-native-faux-provider', native_lease_revocation_verified: true, real_model_calls: 0, passed: true };
  await writeFile(join(root, 'evidence.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ ...evidence, evidence_path: join(root, 'evidence.json') }, null, 2));
} finally {
  await host?.close();
  if (session) await session.abort();
  await Promise.all(factories.map(factory => factory.close?.()));
  session?.dispose();
  await new Promise((resolve, reject) => { http.closeAllConnections(); http.close(error => error ? reject(error) : resolve()); });
}
