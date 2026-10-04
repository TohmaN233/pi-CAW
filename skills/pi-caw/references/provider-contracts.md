# Models, Roles and MCP

1. Use `caw models` to inspect the active Pi catalog. Configure child Provider/model/thinking bindings in the Workbench; Main inherits the initiating chat's model and thinking.
2. For one helper, read `caw role_templates`, select an enabled Role and fetch only that profile with `caw role_template`. Pass its `role_id` and bounded assignment to `caw launch_role`.
3. Preserve the selected access, workspace, paths and approval requirements. Use read-only access for inspection and bounded-write access for repair.
4. If binding or capability validation fails, show the error and have the user correct the setting. Keep the selected model and execution mode.
5. For function-based Providers, configure a trusted local module for detached execution, or explicitly select `detached_host: false` for in-process execution.
6. Configure MCP and authentication through Pi's `/mcp`. Cooperative children can use the enabled catalog; Strict children need an explicit server/tool subset. Resolve startup, exposure or OAuth errors before dispatch.

Use [execution](native-execution.md) for session continuation and result submission.
