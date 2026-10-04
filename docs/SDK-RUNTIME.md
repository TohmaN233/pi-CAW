# SDK runtime bindings — 0.3.0

pi-CAW identifies the active SDK entry by its exported `createAgentSession` function and the active AI entry by `getSupportedThinkingLevels`. Package export metadata supplies distribution candidates; the legacy adapter also recognizes their corresponding `src/*.ts` entries. Existing candidates with different exports are rejected. An import failure remains an error. Source execution requires the Host's TypeScript-capable runtime or loader.

Native MCP prefers the SDK's public `loadMcpConfig`, `validateMcpServerConfig`, `mcpNamespace`, `McpOAuthCredentialStore` and `FileAuthStorageBackend` exports. SDKs without these public helpers use the legacy adapter, which loads all four modules relative to the verified entry. It never combines source and compiled helpers.

## Explicit Host binding

A trusted Host extension can register this event before pi-CAW's first session starts:

```ts
pi.events.on('pi-caw:sdk-runtime', request => {
  request.binding = {
    sdk_entry: 'file:///opt/pi/packages/coding-agent/src/index.ts',
    ai_entry: 'file:///opt/pi/packages/ai/src/compat.ts',
    mcp_entry: 'file:///opt/pi/adapters/native-mcp.mjs',
    node_args: ['--import=file:///opt/pi/loaders/source-runtime.mjs'],
  };
});
```

- `sdk_entry` and `ai_entry` must export the actual interfaces loaded by this Host.
- Optional `mcp_entry` exports the five MCP helpers above. Alternatively, `mcp_entries` pins four native modules in config/registry/OAuth/auth order. Declare only one form.
- All entries are existing absolute local paths or file URLs. HTTP modules, URL queries and fragments are rejected.
- Optional `node_args` carries local `--import`/`--loader` hooks and named `--conditions` into detached children. Without an override, these flags are captured from the current process; unrelated flags are excluded.
- Bun children translate import hooks to absolute-path preloads. Node loader hooks require Node; incompatible hooks fail before launch.
- Set `request.error` to refuse a binding explicitly. This private event does not grant models configuration authority.

Detached execution pins the resolved entries and loader hooks in its private bootstrap. The child verifies the SDK package directory and version before creating sessions. Unbound old bootstraps fail before dispatch; reload the Host and retry only the unexecuted bootstrap. Existing execution evidence remains intact.

## Verification

`test/sdk-runtime.test.mjs` covers distribution loading, source-only trees, stale compiled neighbors, public exports, relocated adapters, exact interface matching, child loader propagation and visible errors in Node and Bun. `test/detached-pi.test.mjs` runs actual offline Pi child sessions and original-chat Main through both distribution and source bindings in Node. Bun's full owner reattachment test times out in both the unchanged 0.2.30 baseline and 0.3.0; full Bun execution remains unverified. No paid model calls or user data are used.
