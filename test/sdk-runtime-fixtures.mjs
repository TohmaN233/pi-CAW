import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Exercise a source-only package layout over the real, offline SDK interfaces.
export async function sourceRuntimeFixture(root, { sdk, aiEntry, stale = false }) {
  const directory = join(root, 'source-sdk'), aiDirectory = join(root, 'source-ai');
  const put = async (path, body) => { await mkdir(new URL('.', pathToFileURL(path)), { recursive: true }); await writeFile(path, body); };
  await put(join(directory, 'package.json'), JSON.stringify({ type: 'module', exports: { '.': { import: './dist/index.js' } } }));
  await put(join(aiDirectory, 'package.json'), JSON.stringify({ type: 'module', exports: { './compat': { import: './dist/compat.js' } } }));
  await mkdir(join(directory, 'node_modules/@earendil-works'), { recursive: true });
  await symlink(aiDirectory, join(directory, 'node_modules/@earendil-works/pi-ai'), process.platform === 'win32' ? 'junction' : 'dir');
  const sdkUrl = pathToFileURL(join(sdk.getPackageDir(), 'dist/index.js')).href;
  await put(join(directory, 'src/index.ts'), `export * from ${JSON.stringify(sdkUrl)}; export function getPackageDir(): string { return ${JSON.stringify(directory)}; }`);
  await put(join(aiDirectory, 'src/compat.ts'), `export * from ${JSON.stringify(aiEntry)}; export const sourceFixture: boolean = true;`);
  for (const relative of ['extensions/mcp/config', 'core/mcp-servers', 'extensions/mcp/oauth', 'core/auth-storage']) {
    await put(join(directory, 'src', relative + '.ts'), `export * from ${JSON.stringify(pathToFileURL(join(sdk.getPackageDir(), 'dist', relative + '.js')).href)};`);
    if (stale) await put(join(directory, 'dist', relative + '.js'), "throw new Error('STALE_MCP_MODULE_WAS_LOADED');");
  }
  if (stale) {
    await put(join(directory, 'dist/index.js'), `export * from ${JSON.stringify(sdkUrl)}; export function createAgentSession() { throw new Error('STALE_SESSION_FACTORY'); }`);
    await put(join(aiDirectory, 'dist/compat.js'), `export * from ${JSON.stringify(aiEntry)}; export function getSupportedThinkingLevels() { throw new Error('STALE_AI_MODULE'); }`);
  }
  return { directory, sdk: await import(pathToFileURL(join(directory, 'src/index.ts')).href),
    ai: await import(pathToFileURL(join(aiDirectory, 'src/compat.ts')).href) };
}
