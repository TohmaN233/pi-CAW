import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { requireValue } from '../core/workflow-paths.mjs';

const mcpContracts = ['loadMcpConfig', 'validateMcpServerConfig', 'mcpNamespace', 'McpOAuthCredentialStore', 'FileAuthStorageBackend'];
const legacyMcpPaths = ['extensions/mcp/config', 'core/mcp-servers', 'extensions/mcp/oauth', 'core/auth-storage'];

function validateBinding(binding) {
  requireValue(binding && typeof binding === 'object' && Object.keys(binding).every(key =>
    ['sdk_entry', 'ai_entry', 'mcp_entry', 'mcp_entries', 'node_args'].includes(key)), 'PI_SDK_RUNTIME_BINDING', 'Unknown SDK runtime binding field');
  requireValue(!binding.mcp_entries || (!binding.mcp_entry && Array.isArray(binding.mcp_entries) && binding.mcp_entries.length === 4),
    'PI_SDK_RUNTIME_BINDING', 'Declare one MCP adapter entry or all four native MCP entries');
}

function localUrl(value) {
  requireValue(typeof value === 'string' && (value.startsWith('file:') || isAbsolute(value)),
    'PI_SDK_MODULE_LOCATION', 'SDK modules require an absolute local path or file URL');
  const url = value.startsWith('file:') ? new URL(value) : pathToFileURL(value);
  requireValue(url.protocol === 'file:' && !url.search && !url.hash, 'PI_SDK_MODULE_LOCATION', 'SDK modules require plain local file URLs');
  requireValue(existsSync(fileURLToPath(url)), 'PI_SDK_MODULE_MISSING', `SDK module does not exist: ${url.href}`, { module: url.href });
  return url.href;
}

function packageEntry(directory, subpath = '.') {
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
  let target = manifest.exports?.[subpath] ?? (subpath === '.' ? manifest.exports : undefined);
  while (target && typeof target === 'object' && !Array.isArray(target)) target = target.import ?? target.node ?? target.default;
  if (!target && subpath === '.') target = manifest.main;
  requireValue(typeof target === 'string' && target.startsWith('./'), 'PI_SDK_PACKAGE_ENTRY', 'Pi package must declare its runtime entry');
  const path = resolve(directory, target);
  requireValue(path.startsWith(resolve(directory) + sep), 'PI_SDK_PACKAGE_ENTRY', 'Pi runtime entry must stay inside its package');
  return path;
}

function sourceEntry(entry, directory) {
  const relative = entry.slice(resolve(directory).length + 1).replaceAll('\\', '/');
  return relative.startsWith('dist/') && relative.endsWith('.js')
    ? join(directory, 'src', relative.slice(5, -3) + '.ts') : null;
}

async function matchingEntry(candidates, matches, importModule, kind) {
  const observed = [];
  for (const path of [...new Set(candidates.filter(Boolean))]) {
    if (!existsSync(path)) { observed.push({ module: pathToFileURL(path).href, status: 'missing' }); continue; }
    const url = localUrl(path);
    // A broken existing module is an error, not permission to load another version.
    const module = await importModule(url);
    if (matches(module)) return url;
    observed.push({ module: url, status: 'different_active_module' });
  }
  requireValue(false, 'PI_SDK_RUNTIME_BINDING', `Cannot identify the active ${kind} entry. Supply a trusted pi-caw:sdk-runtime binding.`, { candidates: observed });
}

function peerPackages(directory, name) {
  const require = createRequire(join(directory, 'package.json'));
  const found = require.resolve.paths(name)?.map(path => join(path, name, 'package.json')).filter(existsSync) ?? [];
  requireValue(found.length, 'PI_SDK_PEER_PACKAGE', `The active Pi SDK cannot resolve its peer package: ${name}`);
  return [...new Set(found.map(path => dirname(realpathSync(path))))];
}

export function validateNodeArgs(args = []) {
  requireValue(Array.isArray(args) && args.every(value => typeof value === 'string' &&
    (/^--(?:import|loader)=file:/.test(value) || /^--conditions=[A-Za-z0-9_,.-]+$/.test(value))),
  'PI_SDK_NODE_ARGS', 'Detached SDK arguments may contain only explicit local import/loader hooks and export conditions');
  for (const arg of args) if (!arg.startsWith('--conditions=')) localUrl(arg.slice(arg.indexOf('=') + 1));
  return [...args];
}

export function runtimeProcessArgs(args, bun = !!process.versions.bun) {
  return validateNodeArgs(args).flatMap(arg => {
    if (!bun || arg.startsWith('--conditions=')) return [arg];
    requireValue(arg.startsWith('--import='), 'PI_SDK_BUN_LOADER', 'Bun cannot execute a Node --loader hook; declare a Bun-compatible import preload');
    return ['--preload', fileURLToPath(arg.slice('--import='.length))];
  });
}

function currentNodeArgs() {
  const result = [], require = createRequire(pathToFileURL(join(process.cwd(), 'package.json')));
  for (let index = 0; index < process.execArgv.length; index++) {
    const match = /^(--import|--preload|--loader|--experimental-loader|--conditions)(?:=(.*))?$/.exec(process.execArgv[index]);
    if (!match) continue;
    const value = match[2] ?? process.execArgv[++index];
    requireValue(typeof value === 'string' && value, 'PI_SDK_NODE_ARGS', 'An active SDK loader argument has no value');
    if (match[1] === '--conditions') result.push(`${match[1]}=${value}`);
    else result.push(`${match[1] === '--preload' ? '--import' : match[1] === '--experimental-loader' ? '--loader' : match[1]}=${localUrl(value.startsWith('file:') || isAbsolute(value) ? value
      : existsSync(resolve(value)) ? resolve(value) : require.resolve(value))}`);
  }
  return validateNodeArgs(result);
}

export async function resolveSdkRuntime({ sdk, supportedThinking, binding = {}, importModule = url => import(url) }) {
  requireValue(typeof sdk?.getPackageDir === 'function' && typeof sdk.createAgentSession === 'function',
    'PI_SDK_RUNTIME_CONTRACT', 'The active Pi SDK must expose its package and session factory');
  const directory = sdk.getPackageDir();
  requireValue(typeof directory === 'string' && isAbsolute(directory), 'PI_SDK_PACKAGE', 'Pi returned an invalid SDK package directory');
  validateBinding(binding);
  const matchesSdk = active => active.createAgentSession === sdk.createAgentSession && typeof active.getPackageDir === 'function'
    && resolve(active.getPackageDir()) === resolve(directory) && active.VERSION === sdk.VERSION;
  let sdkEntry;
  if (binding.sdk_entry) {
    sdkEntry = localUrl(binding.sdk_entry);
    const active = await importModule(sdkEntry);
    requireValue(matchesSdk(active), 'PI_SDK_RUNTIME_MISMATCH', 'The supplied SDK entry is not the active Pi SDK');
  } else {
    const entry = packageEntry(directory);
    sdkEntry = await matchingEntry([entry, sourceEntry(entry, directory)],
      matchesSdk, importModule, 'Pi SDK');
  }
  let aiEntry;
  if (binding.ai_entry) aiEntry = localUrl(binding.ai_entry);
  else {
    const candidates = peerPackages(directory, '@earendil-works/pi-ai').flatMap(peer => {
      const entry = packageEntry(peer, './compat'); return [entry, sourceEntry(entry, peer)];
    });
    aiEntry = await matchingEntry(candidates,
      active => typeof active.getSupportedThinkingLevels === 'function' && (!supportedThinking || active.getSupportedThinkingLevels === supportedThinking),
      importModule, 'Pi AI');
  }
  const ai = await importModule(aiEntry);
  requireValue(typeof ai.getSupportedThinkingLevels === 'function' && ai.Type && (!supportedThinking || ai.getSupportedThinkingLevels === supportedThinking),
    'PI_SDK_RUNTIME_MISMATCH', 'The supplied AI entry is not the active Pi AI interface');
  const result = { sdk_entry: sdkEntry, ai_entry: aiEntry, node_args: validateNodeArgs(binding.node_args ?? currentNodeArgs()) };
  if (binding.mcp_entry) result.mcp_entry = localUrl(binding.mcp_entry);
  if (binding.mcp_entries) {
    result.mcp_entries = binding.mcp_entries.map(localUrl);
  }
  return result;
}

export async function resolveNativeMcpModules({ sdk, runtime, importModule = url => import(url) }) {
  validateBinding(runtime ?? {});
  requireValue(typeof sdk?.createMcpExtension === 'function', 'PI_MCP_UNAVAILABLE', 'The active Pi SDK must provide its native MCP extension');
  let modules;
  if (runtime?.mcp_entry) modules = await importModule(localUrl(runtime.mcp_entry));
  else if (!runtime?.mcp_entries && mcpContracts.every(name => typeof sdk[name] === 'function')) modules = sdk;
  else {
    let entries = runtime?.mcp_entries;
    if (!entries) {
      const bound = await resolveSdkRuntime({ sdk, binding: runtime, importModule });
      const entry = fileURLToPath(bound.sdk_entry), extension = extname(entry);
      // Compatibility adapter for SDKs that do not yet export the MCP helpers.
      // Every helper comes from the verified active entry's tree; never mix src/dist.
      entries = legacyMcpPaths.map(path => localUrl(join(dirname(entry), path + extension)));
    }
    modules = Object.assign({}, ...await Promise.all(entries.map(url => importModule(localUrl(url)))));
  }
  requireValue(mcpContracts.every(name => typeof modules[name] === 'function'), 'PI_MCP_UNAVAILABLE',
    'The selected Pi native MCP adapter is missing required exports', { missing_exports: mcpContracts.filter(name => typeof modules[name] !== 'function') });
  return modules;
}

export async function loadCapturedSdkRuntime(boot) {
  requireValue(boot.sdk_runtime?.sdk_entry && boot.sdk_runtime?.ai_entry, 'PI_WORKER_SDK_BINDING',
    'Detached Pi execution requires a captured SDK runtime binding; restart the Host before retrying this unexecuted bootstrap');
  const sdk = await import(localUrl(boot.sdk_runtime.sdk_entry)), ai = await import(localUrl(boot.sdk_runtime.ai_entry));
  requireValue(typeof sdk.getPackageDir === 'function' && resolve(sdk.getPackageDir()) === resolve(boot.sdkPackageDir),
    'PI_WORKER_SDK', 'The worker loaded a different Pi SDK installation');
  requireValue((sdk.VERSION ?? null) === boot.sdk_version, 'PI_WORKER_SDK', 'The captured Pi SDK version changed before worker startup');
  const runtime = await resolveSdkRuntime({ sdk, supportedThinking: ai.getSupportedThinkingLevels, binding: boot.sdk_runtime });
  return { sdk, ai, runtime };
}
