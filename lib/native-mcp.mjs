import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { requireValue } from '../core/workflow-paths.mjs';

// Credentials, commands and server URLs remain private. The public catalog can
// enter validation context and diagnostics without transporting native secrets.
const privateCatalogs = new WeakMap();

async function nativeModules(sdk) {
  requireValue(typeof sdk?.getPackageDir === 'function' && typeof sdk.createMcpExtension === 'function',
    'PI_MCP_UNAVAILABLE', 'The active Pi SDK must provide its native MCP extension');
  const directory = sdk.getPackageDir();
  requireValue(isAbsolute(directory), 'PI_MCP_PACKAGE', 'Pi returned an invalid native SDK package directory');
  const [config, registry, oauth, auth] = await Promise.all([
    import(pathToFileURL(join(directory, 'dist/extensions/mcp/config.js')).href),
    import(pathToFileURL(join(directory, 'dist/core/mcp-servers.js')).href),
    import(pathToFileURL(join(directory, 'dist/extensions/mcp/oauth.js')).href),
    import(pathToFileURL(join(directory, 'dist/core/auth-storage.js')).href),
  ]);
  requireValue(typeof config.loadMcpConfig === 'function' && typeof registry.validateMcpServerConfig === 'function'
    && typeof registry.mcpNamespace === 'function' && typeof oauth.McpOAuthCredentialStore === 'function'
    && typeof auth.FileAuthStorageBackend === 'function', 'PI_MCP_UNAVAILABLE', 'The active Pi native MCP module contract is unavailable');
  return { ...config, ...registry, McpOAuthCredentialStore: oauth.McpOAuthCredentialStore, FileAuthStorageBackend: auth.FileAuthStorageBackend };
}

export async function loadNativeMcpCatalog({ sdk, agentDir, cwd, projectTrusted, registeredServers = [] }) {
  requireValue(isAbsolute(agentDir) && isAbsolute(cwd) && typeof projectTrusted === 'boolean',
    'PI_MCP_CONTEXT', 'Native MCP discovery needs the active Pi agent directory, workspace and explicit project trust');
  requireValue(Array.isArray(registeredServers), 'PI_MCP_REGISTRY', 'Pi MCP registrations must be an array');
  const native = await nativeModules(sdk);
  const loaded = native.loadMcpConfig({ agentDir, cwd, projectTrusted });
  requireValue(loaded.errors.length === 0, 'PI_MCP_CONFIG',
    `Pi native MCP configuration has ${loaded.errors.length} error(s). Inspect /mcp in the parent Pi conversation.`,
    { global_config: join(agentDir, 'mcp.json'), ...(projectTrusted ? { project_config: join(cwd, '.pi/mcp.json') } : {}), error_count: loaded.errors.length });
  const entries = loaded.servers.map(entry => structuredClone(entry));
  const configuredNamespaces = new Set(entries.map(entry => native.mcpNamespace(entry.name)));
  const namespaces = new Set(configuredNamespaces);
  for (const registered of registeredServers) {
    requireValue(registered && typeof registered.name === 'string' && typeof registered.extensionPath === 'string',
      'PI_MCP_REGISTRY', 'A native Pi MCP registration lacks its name or owning extension');
    const config = native.validateMcpServerConfig(registered.name, registered.config);
    requireValue(typeof config !== 'string', 'PI_MCP_REGISTRY', 'A native Pi MCP registration has invalid configuration', { server: registered.name });
    const namespace = native.mcpNamespace(registered.name);
    // Pi file configuration has the same precedence as its built-in extension.
    if (configuredNamespaces.has(namespace)) continue;
    requireValue(!namespaces.has(namespace), 'PI_MCP_NAMESPACE', 'Native Pi MCP registrations share a tool namespace', { server: registered.name });
    namespaces.add(namespace);
    entries.push({ name: registered.name, config: structuredClone(config), source: registered.extensionPath, scope: 'extension' });
  }
  const catalog = Object.freeze({ source: 'active-pi-native-mcp', sdk_version: sdk.VERSION ?? null,
    servers: Object.freeze(entries.map(entry => Object.freeze({ name: entry.name, namespace: native.mcpNamespace(entry.name),
      enabled: entry.config.enabled !== false, exposure: entry.config.exposure ?? 'codemode', scope: entry.scope,
      tool_exposure: Object.freeze({ ...(entry.config.toolExposure ?? {}) }) }))) });
  privateCatalogs.set(catalog, { sdk, native, entries, agentDir, autoEnableCodemode: loaded.autoEnableCodemode });
  return catalog;
}

function loginRequired() {
  return Object.assign(new Error('Sign in to the required MCP server with /mcp in the parent Pi conversation, then retry explicitly.'), { code: 'PI_MCP_LOGIN_REQUIRED' });
}

export function childMcpFactories({ sdk, catalog, requiredServers = [], includeAll = false }) {
  const privateCatalog = privateCatalogs.get(catalog);
  requireValue(privateCatalog && privateCatalog.sdk === sdk, 'PI_MCP_CATALOG', 'Use the native MCP catalog from this active Pi SDK');
  requireValue(Array.isArray(requiredServers) && requiredServers.every(name => typeof name === 'string' && name)
    && new Set(requiredServers).size === requiredServers.length && typeof includeAll === 'boolean',
    'PI_MCP_REQUIREMENTS', 'Declare exact native MCP server names or explicitly request the cooperative catalog');
  requireValue(!includeAll || requiredServers.length === 0, 'PI_MCP_REQUIREMENTS', 'Choose a required MCP subset or the explicit cooperative catalog');
  const { native, entries, agentDir } = privateCatalog;
  const selected = includeAll ? entries.filter(entry => entry.config.enabled !== false) : requiredServers.map(name => {
    const entry = entries.find(candidate => candidate.name === name);
    requireValue(entry && entry.config.enabled !== false, 'PI_MCP_REQUIRED', 'A required native Pi MCP server is missing or disabled', { server: name });
    return entry;
  });
  if (selected.length === 0) return [];
  for (const entry of selected) {
    requireValue((entry.config.exposure ?? 'codemode') !== 'hidden' || Object.values(entry.config.toolExposure ?? {}).some(value => value !== 'hidden'),
      'PI_MCP_HIDDEN', 'A required native Pi MCP server has no exposed tool capability', { server: entry.name });
  }
  requireValue(typeof sdk.createToolSearchExtension === 'function' && typeof sdk.createCodemodeExtension === 'function',
    'PI_MCP_DISCOVERY', 'The active Pi SDK must provide its native MCP discovery tools');
  const credentials = new native.McpOAuthCredentialStore(new native.FileAuthStorageBackend(join(agentDir, 'mcp-auth.json')), agentDir);
  const selectedNamespaces = new Set(selected.map(entry => native.mcpNamespace(entry.name)));
  const exposures = new Set(selected.flatMap(entry => [entry.config.exposure ?? 'codemode', ...Object.values(entry.config.toolExposure ?? {})]));
  let resolveReady, rejectReady, nativeShutdown;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  // A native extension runner reports hook errors separately. Retain the same
  // rejected promise for the host to await before submitting the model prompt.
  void ready.catch(() => {});
  const nativeFactory = sdk.createMcpExtension({
    loadConfig: () => ({ servers: selected.map(entry => structuredClone(entry)), errors: [],
      ...(privateCatalog.autoEnableCodemode === undefined ? {} : { autoEnableCodemode: privateCatalog.autoEnableCodemode }) }),
    credentials, logPath: join(agentDir, 'mcp.log'), openUrl: () => { throw loginRequired(); },
    updateConfig: () => { throw Object.assign(new Error('Configure native MCP servers in the parent Pi conversation.'), { code: 'PI_MCP_CONFIGURATION_AUTHORITY' }); },
  });
  const factory = pi => {
    let nativeWait, startupFailure = null, started = false;
    const context = ctx => {
      const wrapped = Object.create(ctx);
      const ui = Object.create(ctx.ui);
      Object.defineProperty(wrapped, 'ui', { value: ui });
      Object.defineProperty(ui, 'notify', { value: (message, level) => {
        if (/^MCP servers need attention:|^MCP failed to load:/.test(message)) {
          startupFailure = /sign.?in|auth|401/i.test(message) ? loginRequired() : Object.assign(
            new Error('A required native Pi MCP server failed to connect. Inspect /mcp in the parent Pi conversation.'), { code: 'PI_MCP_CONNECTION', servers: selected.map(entry => entry.name) });
          ctx.ui.notify(startupFailure.message, level);
          return;
        }
        ctx.ui.notify(message, level);
      } });
      return wrapped;
    };
    const scopedApi = new Proxy(pi, { get(target, key) {
      if (key === 'getMcpServers') return () => []; // The pinned subset replaces ambient registrations.
      if (key === 'registerTool') return definition => {
        if (definition.name.startsWith('mcp__')) requireValue(selectedNamespaces.has(definition.namespace?.name),
          'PI_MCP_TOOL_SCOPE', 'Native MCP registered a tool outside the declared server subset');
        target.registerTool(definition);
        if ((definition.name.startsWith('mcp__') || ['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'].includes(definition.name))
          && definition.exposure === 'direct')
          target.setActiveTools([...new Set([...target.getActiveTools(), definition.name])]);
      };
      if (key === 'on') return (event, handler) => {
        if (event === 'tool_call') nativeWait = handler;
        if (event === 'session_shutdown') nativeShutdown = handler;
        target.on(event, (payload, ctx) => handler(payload, context(ctx)));
      };
      return Reflect.get(target, key);
    } });
    if (privateCatalog.autoEnableCodemode === false && exposures.has('codemode'))
      pi.on('session_start', () => pi.setActiveTools([...new Set([...pi.getActiveTools(), 'tool_search'])]));
    nativeFactory(scopedApi);
    pi.on('session_start', async (_event, ctx) => {
      try {
        requireValue(!started, 'PI_MCP_SESSION_RELOAD', 'A pinned MCP child session cannot reload its execution environment');
        started = true;
        requireValue(typeof nativeWait === 'function', 'PI_MCP_STARTUP', 'Native Pi MCP startup wait hook is unavailable');
        // The native tool-search wait hook reaches all selected servers, even
        // when their tools use default codemode exposure and load lazily.
        await nativeWait({ toolName: 'tool_search', input: { query: 'native MCP startup' } }, context(ctx));
        await new Promise(resolve => setImmediate(resolve));
        requireValue(!ctx.signal?.aborted, 'PI_TASK_ABORTED', 'Task authority was revoked during native MCP startup');
        if (startupFailure) throw startupFailure;
        resolveReady({ servers: selected.map(entry => entry.name), source: 'active-pi-native-mcp' });
      } catch (error) { rejectReady(error); throw error; }
    });
  };
  const factories = [{ name: 'pi-caw-native-mcp-search', factory: sdk.createToolSearchExtension() }];
  if (exposures.has('codemode')) factories.push({ name: 'pi-caw-native-mcp-codemode', factory: sdk.createCodemodeExtension({ models: false }) });
  factories.push({ name: 'pi-caw-native-mcp', factory, ready,
    close: async () => { if (nativeShutdown) await nativeShutdown({ type: 'session_shutdown', reason: 'exit' }); } });
  return factories;
}
