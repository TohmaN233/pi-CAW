# State locations

- Plugin state lives in `pi-CAW` under Pi's agent directory. An absolute `PI_CAW_DIR` selects another state directory.
- Use Workbench configuration for Provider bindings and Roles; graph/resources use revision CAS.
- Use `caw get`, `events` or `run_definition` to inspect Run state, history and pinned definitions.
- Use `caw capabilities` for available Host tools and native MCP exposure. Pi owns model authentication and MCP configuration.
- Inspect published results before changing retained execution data; use Workbench cleanup for finished Runs.

For Host integration, see [Host interface](../../../docs/HOST.md).
