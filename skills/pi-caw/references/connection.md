# Diagnose unavailable tools

- For extension loading or SDK errors, read the Pi startup output and use `caw local_clients` for active SDK metadata.
- For missing capabilities or bindings, call `caw capabilities` or `caw models` and inspect the returned error.
- For Workbench access, open `/caw` and check the actual loopback response and server log.
- For detached execution, inspect the recorded owner status/log and Run events. Reconnect the original chat bridge for `waiting_parent`.
- For MCP, inspect native startup/tool metadata and resolve trust, exposure or OAuth through Pi's `/mcp`.
- After an authorized update, reload through Pi's supported operations and verify a real tool call. Keep access tokens and bootstrap credentials out of diagnostic prompts and reports.

Use [recovery](recovery.md) when an existing Run needs reattachment or retry.
