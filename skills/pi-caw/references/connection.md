# Connection diagnosis

Inspect the failed Pi extension/tool call, actual Host startup output, Workbench
server error and exact Run events. `caw local_clients` reports active SDK metadata;
unknown version is unknown, not a hardcoded success. Use the currently registered
extension and available SDK entrypoint rather than an assumed installed package.

For an independent owner, inspect the exact owner status/log and its Run journal;
stale heartbeat, startup timeout and bridge loss have different recovery meanings.
`waiting_parent` requires the original Pi actor's bridge, not a replacement server
or model. Owner endpoint tokens and private bootstrap files are Host credentials;
do not copy them into diagnostic prompts or user-visible logs.

Distinguish extension loading, Workbench transport, model binding, dependency
qualification and native MCP startup. A graph validation blocker means the call
reached the control plane; it is not a connection failure. A configured MCP server
does not prove it started or exposes the declared tools. Read actual native
startup/metadata errors and follow Pi's existing trust/OAuth mechanism.

Open the requested Workbench through `/caw`. It creates no extra task or Run.
Report a failed UI/loopback connection; do not silently substitute an unrelated
page, browser server or JSON editor. Preserve token-protected loopback access and
keep bootstrap/auth metadata out of node context.

After an explicitly authorized package update, reload/restart through supported
Pi operations and verify the actual tool call and Workbench response. Do not
repeat an ineffective reload or retry a deterministic process exit by sleeping.
Do not install packages, rewrite model/MCP config, disclose tokens or run paid
models merely to diagnose a mechanical error.

Report the exact failed action and available diagnostic evidence. Never claim
connection recovery before an actual Host tool call succeeds, or start a substitute
server and claim the requested Workflow executed. An unavailable adapter blocks
that route; it does not authorize a model, permission or execution-mode fallback.
