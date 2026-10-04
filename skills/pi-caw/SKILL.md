---
name: pi-caw
description: Route concrete Pi tasks to Ready Workflows, automatically delegate useful work in ordinary tasks through enabled, model-bound Roles without requiring users to name a Role, and create or manage Workflows with caw.
---

# Pi Workflows and Roles

Call the `caw` tool as `{action: "operation", args: {...}}`. Below, `caw operation` means this tool call. Use `/caw` to open the Workbench.

## Choose a route

When pi-CAW is enabled, proactively use enabled, model-bound Roles for useful delegation during ordinary tasks; the user need not mention Roles.

- For a concrete execution task, call `caw route` with `task`. Run a clear Ready match; ask when alternatives materially differ in outcome or permissions.
- If the Host already supplies a Workflow revision or node packet, use it directly.
- If no Workflow fits and a helper is useful, call `caw role_templates`, select one enabled Role, fetch it with `caw role_template`, then use `caw launch_role`. Give the helper its task, owned files, constraints and checks. Preserve its configured binding and inspect the returned work.
- For planning, comparison or audit, do not start a Workflow Run; you may still use a suitable Role.
- To create, import or edit a Workflow, follow [editing](references/editing.md).

## Run the task

1. Call `caw run` with the selected `workflow_id`, absolute `workspace`, access and declared inputs. Pass structured local data through `inputs_path`; bind existing records directly rather than copying them through model output.
2. Use the selected node's inputs, pinned resources and write scope. Submit newly created semantic values only; the Host supplies identities and receipts.
3. Continue independent work while the Host runs. Use its notifications or `caw wait` when the next action depends on the result.
4. On failure, inspect the exact Run/node and follow [recovery](references/recovery.md). Report completion after the Run is `succeeded`; approvals and final acceptance use the Workbench.

## Main and models

Main inherits this Pi chat's model and thinking. Child models and thinking must be explicitly bound in the Workbench.

- `worker`: default Main mode; a fresh context with declared inputs/resources.
- `orchestration`: current chat and native Pi tools; requires Cooperative policy.

Use `args.main_modes`, keyed by root node ID, for per-Run choices, for example `{focused:"worker", final:"orchestration"}`. Preserve the mode saved in an existing Run.

On `PI_CAW_MAIN`, read `caw main_task`, use `main_resource` and `main_tool` as needed, submit `main_result`, then finish the turn. Children submit their declared results with `caw_submit_result`.

## Operation guides

Read only the guide needed for the current operation:

- [Provider bindings](references/provider-contracts.md): models, Roles and MCP.
- [Execution](references/native-execution.md): sessions, continuation and item delivery.
- [Parallel writes](references/parallel.md): worktrees, patch review and integration.
- [Repair loops](references/loops.md): bounded review and failed-item repair.
- [Connection diagnosis](references/connection.md): unavailable tools or Workbench.
- [State locations](references/architecture.md): definitions, Run records and Host settings.
