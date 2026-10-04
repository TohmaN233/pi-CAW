import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import * as sdk from '@earendil-works/pi-coding-agent';
import { childMcpFactories, loadNativeMcpCatalog } from '../lib/native-mcp.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'pi-caw-native-mcp-'));
  const agentDir = join(root, 'agent'), cwd = join(root, 'workspace');
  await mkdir(agentDir); await mkdir(join(cwd, '.pi'), { recursive: true });
  t.after(async () => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); });
  return { root, agentDir, cwd };
}

function harness(factories, cwd) {
  const handlers = new Map(), tools = new Map(), notifications = [], active = new Set();
  const pi = {
    on(name, callback) { if (!handlers.has(name)) handlers.set(name, []); handlers.get(name).push(callback); },
    registerTool(tool) { tools.set(tool.name, tool); }, registerCommand() {},
    getMcpServers() { return [{ name: 'ambient', config: { command: 'must-not-start' }, extensionPath: 'ambient-extension' }]; },
    getAllTools() { return [...tools.values()]; }, getActiveTools() { return [...active]; },
    setActiveTools(names) { active.clear(); names.forEach(name => active.add(name)); },
    getSettings() { return {}; }, appendEntry() {},
  };
  for (const extension of factories) extension.factory(pi);
  const controller = new AbortController();
  const ctx = { cwd, signal: controller.signal, hasUI: false, modelRegistry: {}, isProjectTrusted: () => true };
  const ui = { notify(message, level) { notifications.push({ message, level }); } };
  // Real Pi exposes ui through a getter. Wrapping it must preserve that API.
  Object.defineProperty(ctx, 'ui', { get: () => ui });
  return { tools, active, notifications, controller,
    async emit(type, extra = {}) { for (const handler of handlers.get(type) ?? []) await handler({ type, ...extra }, ctx); },
  };
}

async function server(t, { unauthorized = false } = {}) {
  const calls = [];
  const http = createServer(async (request, response) => {
    if (request.method !== 'POST') { response.writeHead(405); response.end(); return; }
    if (unauthorized) { response.writeHead(401, { 'WWW-Authenticate': 'Bearer' }); response.end(); return; }
    let text = ''; for await (const chunk of request) text += chunk;
    const message = JSON.parse(text); calls.push(message.method);
    if (message.id === undefined) { response.writeHead(202); response.end(); return; }
    let result;
    if (message.method === 'initialize') result = { protocolVersion: message.params.protocolVersion,
      capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'offline-native-test', version: '1.0' } };
    else if (message.method === 'tools/list') result = { tools: [{ name: 'echo', description: 'Echo a supplied test value',
      inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] }, annotations: { readOnlyHint: true } }] };
    else if (message.method === 'tools/call') result = { content: [{ type: 'text', text: message.params.arguments.value }] };
    else if (message.method === 'resources/list') result = { resources: [{ uri: 'test://resource', name: 'Fixture resource', mimeType: 'text/plain' }] };
    else if (message.method === 'resources/templates/list') result = { resourceTemplates: [] };
    else if (message.method === 'resources/read') result = { contents: [{ uri: 'test://resource', mimeType: 'text/plain', text: 'Native MCP resource' }] };
    else result = {};
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => { http.closeAllConnections(); http.close(error => error ? reject(error) : resolve()); }));
  return { url: `http://127.0.0.1:${http.address().port}/mcp`, calls };
}

test('catalog uses native Pi trust, validation, namespace and configuration precedence without disclosing secrets', async t => {
  const f = await fixture(t);
  await writeFile(join(f.agentDir, 'mcp.json'), JSON.stringify({ mcpServers: {
    native_docs: { url: 'https://example.invalid/mcp', headers: { Authorization: 'Bearer private-credential' } },
    disabled: { command: 'disabled-command', enabled: false },
  } }));
  await writeFile(join(f.cwd, '.pi', 'mcp.json'), JSON.stringify({ mcpServers: {
    native_docs: { command: 'trusted-project-command', env: { PRIVATE: 'private-project-value' } },
    project_only: { command: 'project-command' },
  } }));
  const registeredServers = [
    { name: 'native-docs', config: { command: 'overridden-extension-command' }, extensionPath: 'registered-extension' },
    { name: 'extension_only', config: { command: 'extension-command' }, extensionPath: 'registered-extension' },
  ];
  const global = await loadNativeMcpCatalog({ sdk, ...f, projectTrusted: false, registeredServers });
  assert.deepEqual(global.servers.map(server => server.name), ['native_docs', 'disabled', 'extension_only']);
  assert.equal(global.servers[0].namespace, 'mcp__native_docs'); assert.equal(global.servers[0].scope, 'global');
  const trusted = await loadNativeMcpCatalog({ sdk, ...f, projectTrusted: true, registeredServers });
  assert.equal(trusted.servers[0].scope, 'project'); assert.ok(trusted.servers.some(server => server.name === 'project_only'));
  assert.doesNotMatch(JSON.stringify(trusted), /private-|command|Authorization|example\.invalid|registered-extension/);
  assert.equal(childMcpFactories({ sdk, catalog: trusted, requiredServers: [] }).length, 0);
  assert.throws(() => childMcpFactories({ sdk, catalog: trusted, requiredServers: ['missing'] }), { code: 'PI_MCP_REQUIRED' });
  assert.throws(() => childMcpFactories({ sdk, catalog: trusted, requiredServers: ['disabled'] }), { code: 'PI_MCP_REQUIRED' });
  assert.throws(() => childMcpFactories({ sdk, catalog: trusted, requiredServers: ['native_docs'], includeAll: true }), { code: 'PI_MCP_REQUIREMENTS' });
});

test('native invalid project auth and namespace collisions fail visibly instead of dropping declarations', async t => {
  const f = await fixture(t);
  await writeFile(join(f.cwd, '.pi', 'mcp.json'), JSON.stringify({ mcpServers: { docs: { url: 'https://example.invalid/mcp', auth: { provider: 'private-provider' } } } }));
  await assert.rejects(loadNativeMcpCatalog({ sdk, ...f, projectTrusted: true }), { code: 'PI_MCP_CONFIG' });
  const untrusted = await loadNativeMcpCatalog({ sdk, ...f, projectTrusted: false }); assert.equal(untrusted.servers.length, 0);
  await assert.rejects(loadNativeMcpCatalog({ sdk, ...f, projectTrusted: false, registeredServers: [
    { name: 'a-b', config: { command: 'first' }, extensionPath: 'first' },
    { name: 'a_b', config: { command: 'second' }, extensionPath: 'second' },
  ] }), { code: 'PI_MCP_NAMESPACE' });
});

test('actual Pi native MCP factory connects only declared servers and executes tools and resources offline', async t => {
  const f = await fixture(t), local = await server(t);
  const catalog = await loadNativeMcpCatalog({ sdk, ...f, projectTrusted: false, registeredServers: [
    { name: 'wanted', config: { url: local.url, exposure: 'direct', timeout: 3 }, extensionPath: 'offline-fixture' },
    { name: 'unwanted', config: { command: 'must-not-start' }, extensionPath: 'offline-fixture' },
  ] });
  const factories = childMcpFactories({ sdk, catalog, requiredServers: ['wanted'] });
  const runtime = harness(factories, f.cwd); t.after(() => runtime.emit('session_shutdown'));
  await runtime.emit('session_start');
  assert.deepEqual(await factories.at(-1).ready, { servers: ['wanted'], source: 'active-pi-native-mcp' });
  assert.ok(runtime.tools.has('mcp__wanted__echo')); assert.ok(runtime.active.has('mcp__wanted__echo'));
  assert.ok(![...runtime.tools.keys()].some(name => name.includes('unwanted') || name.includes('ambient')));
  const result = await runtime.tools.get('mcp__wanted__echo').execute('call-1', { value: 'Native tool succeeded' }, runtime.controller.signal);
  assert.equal(result.content[0].text, 'Native tool succeeded');
  const resources = await runtime.tools.get('list_mcp_resources').execute('resources-1', {}, runtime.controller.signal);
  assert.match(JSON.stringify(resources), /test:\/\/resource/);
  assert.ok(local.calls.includes('initialize')); assert.ok(local.calls.includes('tools/call'));
  assert.deepEqual(runtime.notifications, []);
});

test('default codemode MCP exposes native discovery and a 401 produces a visible login error without a browser', async t => {
  const f = await fixture(t), local = await server(t, { unauthorized: true });
  const catalog = await loadNativeMcpCatalog({ sdk, ...f, projectTrusted: false,
    registeredServers: [{ name: 'auth_needed', config: { url: local.url, timeout: 2 }, extensionPath: 'offline-fixture' }] });
  const factories = childMcpFactories({ sdk, catalog, requiredServers: ['auth_needed'] });
  assert.ok(factories.some(factory => factory.name === 'pi-caw-native-mcp-codemode'));
  const runtime = harness(factories, f.cwd); t.after(() => runtime.emit('session_shutdown'));
  await assert.rejects(runtime.emit('session_start'), { code: 'PI_MCP_LOGIN_REQUIRED' });
  await assert.rejects(factories.at(-1).ready, { code: 'PI_MCP_LOGIN_REQUIRED' });
  assert.ok(runtime.active.has('codemode')); assert.ok(runtime.notifications.some(notification => /parent Pi conversation/.test(notification.message)));
  assert.doesNotMatch(JSON.stringify(runtime.notifications), /127\.0\.0\.1/);
});

test('Pi autoEnableCodemode=false retains native tool search and the host can close MCP without disposing a session', async t => {
  const f = await fixture(t), local = await server(t);
  await writeFile(join(f.agentDir, 'mcp.json'), JSON.stringify({ autoEnableCodemode: false,
    mcpServers: { searchable: { url: local.url, timeout: 3 } } }));
  const catalog = await loadNativeMcpCatalog({ sdk, ...f, projectTrusted: false });
  const factories = childMcpFactories({ sdk, catalog, includeAll: true });
  const runtime = harness(factories, f.cwd); t.after(() => factories.at(-1).close());
  await runtime.emit('session_start'); await factories.at(-1).ready;
  assert.ok(runtime.active.has('tool_search')); assert.ok(!runtime.active.has('codemode'));
  assert.ok(runtime.tools.has('mcp__searchable__echo'));
  await factories.at(-1).close();
  await assert.rejects(runtime.tools.get('mcp__searchable__echo').execute('closed-call', { value: 'must fail' }, runtime.controller.signal), /shut down/);
});
