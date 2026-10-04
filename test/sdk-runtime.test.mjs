import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as sdk from '@earendil-works/pi-coding-agent';
import * as ai from '@earendil-works/pi-ai/compat';
import { resolveSdkRuntime, resolveNativeMcpModules, loadCapturedSdkRuntime, validateNodeArgs, runtimeProcessArgs } from '../lib/sdk-runtime.mjs';
import { loadNativeMcpCatalog } from '../lib/native-mcp.mjs';
import { sourceRuntimeFixture } from './sdk-runtime-fixtures.mjs';
import { PiSdkHost } from '../lib/pi-sdk-host.mjs';

const aiEntry = import.meta.resolve('@earendil-works/pi-ai/compat');
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'pi-caw-sdk-runtime-'));
  t.after(async () => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 }); });
  const agentDir = join(root, 'agent'), cwd = join(root, 'workspace');
  await mkdir(agentDir); await mkdir(cwd);
  return { root, agentDir, cwd };
}

test('distribution binding identifies the active SDK and AI even with nested duplicate peers', async () => {
  const runtime = await resolveSdkRuntime({ sdk, supportedThinking: ai.getSupportedThinkingLevels });
  assert.equal((await import(runtime.sdk_entry)).createAgentSession, sdk.createAgentSession);
  assert.equal((await import(runtime.ai_entry)).getSupportedThinkingLevels, ai.getSupportedThinkingLevels);
  assert.deepEqual(runtime.node_args, []);
});

for (const stale of [false, true]) test(`source SDK loads native MCP with ${stale ? 'stale dist beside src' : 'no dist files'}`, async t => {
  const f = await fixture(t), source = await sourceRuntimeFixture(f.root, { sdk, aiEntry, stale });
  const runtime = await resolveSdkRuntime({ sdk: source.sdk, supportedThinking: source.ai.getSupportedThinkingLevels });
  assert.ok(runtime.sdk_entry.endsWith('/src/index.ts'));
  assert.ok(runtime.ai_entry.endsWith('/src/compat.ts'));
  const catalog = await loadNativeMcpCatalog({ sdk: source.sdk, runtime, ...f, projectTrusted: false });
  assert.deepEqual(catalog.servers, []);
  const boot = { sdkPackageDir: source.directory, sdk_version: source.sdk.VERSION, sdk_runtime: runtime };
  const hook = join(f.root, 'source-hook.mjs');
  await writeFile(hook, 'globalThis.piCawSourceHook = true;');
  boot.sdk_runtime.node_args = [`--import=${pathToFileURL(hook).href}`];
  const script = join(f.root, 'source-child.mjs');
  await writeFile(script, `import assert from 'node:assert/strict';
import {loadCapturedSdkRuntime,resolveNativeMcpModules,resolveSdkRuntime} from ${JSON.stringify(new URL('../lib/sdk-runtime.mjs', import.meta.url).href)};
assert.equal(globalThis.piCawSourceHook,true);
const {sdk,ai,runtime}=await loadCapturedSdkRuntime(${JSON.stringify(boot)});
const observed=await resolveSdkRuntime({sdk,supportedThinking:ai.getSupportedThinkingLevels});
assert.deepEqual(observed.node_args,runtime.node_args);
const mcp=await resolveNativeMcpModules({sdk,runtime});
assert.equal(typeof mcp.loadMcpConfig,'function');console.log('source child verified');`);
  const child = await promisify(execFile)(process.execPath, [...runtimeProcessArgs(runtime.node_args), script], { cwd: f.cwd });
  assert.match(child.stdout, /source child verified/);
  await assert.rejects(loadCapturedSdkRuntime({ ...boot, sdk_version: 'changed' }), { code: 'PI_WORKER_SDK' });
});

test('public MCP exports need no SDK filesystem layout', async () => {
  const native = await resolveNativeMcpModules({ sdk });
  const publicSdk = { createMcpExtension: sdk.createMcpExtension, ...native };
  assert.equal(await resolveNativeMcpModules({ sdk: publicSdk }), publicSdk);
});

test('trusted adapters support relocated MCP modules and fail on broken or missing exports', async t => {
  const f = await fixture(t), native = await resolveNativeMcpModules({ sdk });
  const entry = join(f.root, 'relocated-adapter.mjs');
  const names = ['loadMcpConfig', 'validateMcpServerConfig', 'mcpNamespace', 'McpOAuthCredentialStore', 'FileAuthStorageBackend'];
  await writeFile(entry, `export {${names.slice(0, 1)}} from ${JSON.stringify(pathToFileURL(join(sdk.getPackageDir(), 'dist/extensions/mcp/config.js')).href)};
export {validateMcpServerConfig,mcpNamespace} from ${JSON.stringify(pathToFileURL(join(sdk.getPackageDir(), 'dist/core/mcp-servers.js')).href)};
export {McpOAuthCredentialStore} from ${JSON.stringify(pathToFileURL(join(sdk.getPackageDir(), 'dist/extensions/mcp/oauth.js')).href)};
export {FileAuthStorageBackend} from ${JSON.stringify(pathToFileURL(join(sdk.getPackageDir(), 'dist/core/auth-storage.js')).href)};`);
  const binding = { sdk_entry: import.meta.resolve('@earendil-works/pi-coding-agent'), ai_entry: aiEntry, mcp_entry: entry };
  const runtime = await resolveSdkRuntime({ sdk, supportedThinking: ai.getSupportedThinkingLevels, binding });
  assert.equal((await resolveNativeMcpModules({ sdk, runtime })).loadMcpConfig, native.loadMcpConfig);
  await writeFile(join(f.root, 'bad.mjs'), 'export const loadMcpConfig = false;');
  await assert.rejects(resolveNativeMcpModules({ sdk, runtime: { mcp_entry: join(f.root, 'bad.mjs') } }), error =>
    error.code === 'PI_MCP_UNAVAILABLE' && error.missing_exports.includes('loadMcpConfig'));
  await writeFile(join(f.root, 'broken.mjs'), "throw Object.assign(new Error('BROKEN_ADAPTER'),{code:'FIXTURE_IMPORT_ERROR'});");
  await assert.rejects(resolveNativeMcpModules({ sdk, runtime: { mcp_entry: join(f.root, 'broken.mjs') } }), { code: 'FIXTURE_IMPORT_ERROR' });
  await assert.rejects(resolveSdkRuntime({ sdk, binding: { ...binding, sdk_entry: entry } }), { code: 'PI_SDK_RUNTIME_MISMATCH' });
});

test('runtime locations and child loader arguments reject remote URLs and arbitrary flags', async () => {
  await assert.rejects(resolveSdkRuntime({ sdk, binding: { sdk_entry: 'https://example.invalid/sdk.js' } }), { code: 'PI_SDK_MODULE_LOCATION' });
  assert.throws(() => validateNodeArgs(['--eval=process.exit()']), { code: 'PI_SDK_NODE_ARGS' });
  assert.throws(() => validateNodeArgs(['--import=https://example.invalid/loader.js']), { code: 'PI_SDK_NODE_ARGS' });
  assert.throws(() => validateNodeArgs(['--conditions=bad=value']), { code: 'PI_SDK_NODE_ARGS' });
  const hook = new URL('./sdk-runtime-fixtures.mjs', import.meta.url).href;
  assert.throws(() => runtimeProcessArgs([`--loader=${hook}`], true), { code: 'PI_SDK_BUN_LOADER' });
});

test('a session switch during asynchronous SDK resolution cannot mix two actors in bootstrap', async t => {
  const f = await fixture(t); let actor = 'original';
  const host = new PiSdkHost({ sdk, Type: ai.Type, supportedThinking: ai.getSupportedThinkingLevels, agentDir: f.agentDir,
    getContext: () => ({ cwd: f.cwd, modelRegistry: {} }) });
  host.mainIdentity = () => ({ session_id: actor });
  host.sdkRuntime = async () => { actor = 'different'; return {}; };
  await assert.rejects(host.detachedBootstrap([]), { code: 'PI_MAIN_SESSION_CHANGED' });
});
