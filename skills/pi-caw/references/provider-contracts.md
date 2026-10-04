# Provider contracts

Read this after selecting one Role or Workflow node. Dispatch by its actual
adapter kind/execution and configured route, never by display name. The original
Provider suitability and authority rules remain separate from Pi transport.

## Shared contract

For every Provider:

1. Preserve the selected definition, node, access intent, approval state,
   absolute workspace and path boundary.
2. Send only the compiled task and required pinned artifacts; avoid unrelated
   conversation history and full library prompts.
3. Retain the real session/task identity and correlate completion with the exact
   dispatch and completed turn.
4. Reject missing terminal evidence, scope expansion and uncertain cancellation.
5. Treat output as a claim and inspect actual changes and verification evidence.

Output grants no publication authority, destructive effects outside the request,
external messaging permission, approval choice or product/governance authority.
Display names can change while stable Provider IDs remain graph references.

## Native Pi Provider and ordinary Role

Every child Provider needs an explicit available model and supported thinking
binding. Missing or changed bindings block dispatch. The Host does not inherit
the planner model, choose a default model or substitute another Provider. Preserve
the exact fresh-context, capability, access and approval fields supplied by the
adapter. A general Provider write capability says what it can be assigned;
the selected node or Role supplies this invocation's actual grant.

Independent owners receive only serializable trusted Host bootstrap. A
function-based native Provider needs an explicitly configured trusted local
module; a missing module fails before dispatch. The user can explicitly select
`detached_host: false` for in-process execution, without changing the model or
permission contract. Do not turn a serialization error into an automatic fallback.

An inspection-only reviewer is read-only. A review-and-fix assignment needs
explicit bounded-write access, validated nonempty paths and a write-capable
Provider. Provider or node approval gates need exact current-task approval.
Workspace and path authorization apply even when the native SDK exposes broad
tools. A requested sandbox or a prompt boundary is not proof of OS isolation.

The Host executes Provider nodes in focused sessions and owns the released window,
exact completed turns, per-item acceptance and deterministic join. Models submit
only semantic values with `caw_submit_result`, not receipt or lease fields.
Accepted items never replay; unresolved item repair and incremental delivery use
the same exact child. Read [native execution](native-execution.md) for those rules.

`caw role_template` resolves only the selected ordinary Role. `caw launch_role`
uses its exact Pi binding. Another available native Pi delegation route may use
the returned profile only if it honors the same actual contract. Do not pretend
the Workflow API owns a third-party helper's lifecycle; use that route's real
status/wait/cancel/continuation operations.

## Persistent Pi thread

A thread start requires a fresh real session identity. Continuation retains that
same session, Provider and explicit declared lineage; a queued placeholder or
an unrelated completed turn is not a receipt. The Host records exact dispatch
markers and verifies the corresponding actual result-tool call and completed
assistant turn. Earlier turns, generic task completion or model-transcribed IDs
cannot satisfy this correlation. Unresolved historical dispatches keep the
same-task lane occupied until exact reconciliation.

## Native MCP and executable tools

Use Pi's actual native MCP configuration, trust, exposure, search/codemode and
OAuth machinery. Availability is established by observed startup/tool metadata,
not a configured descriptor alone. Strict nodes receive only their declared
subset; Cooperative nodes retain the configured native catalog. Preserve the
server/tool contract, exact pending request and effect evidence. Do not call a
nearby tool to imitate a missing server or silently extend exposure.

Every actual child tool call checks its current exact lease, including native
MCP, search and codemode. Scope and authority failures are visible and invalidate
acceptance. Quiescence must include native MCP shutdown, program units and SDK
sessions; failed startup cleanup retains the owner rather than disposing it and
claiming no task was allocated.

Native programs and pinned resource programs use the declared input/resource
broker, argv, workspace, timeout and grants. Interpreter/executable locations are
registered Host state, not portable Workflow fields. Optional WSL passthrough
requires an explicit qualified binding. Program success, process termination and
scope checks are separate observed facts; a shell result is not an OS sandbox.

## Original product adapters

Codex native spawn/follow-up, Codex thread/App Server and login are product APIs;
Pi uses its own session, tools and JSONL evidence rather than fabricated Codex
receipts. Original Cursor CDP and Grok ACP are non-GPT product adapters with
their own exact probe/start/status/control, permission and restart contracts.
The user explicitly excluded these remote connectors in favor of Pi's model
import route. Preserve their portable responsibility, access, exact identity,
completion and recovery rules through the actual Pi adapter; do not classify the
connectors as GPT-exclusive or claim MCP supplies their original transport.
The frozen-packet
ChatGPT web reviewer and direct OpenAI advisory adapter are GPT-specific routes.
Original Role names and prompts remain templates, not proof of those transports.
See [parity evidence](../../../docs/PARITY.md) for implemented adapter boundaries.

## Primary acceptance

Inspect exact terminal/session evidence, actual scope and prevented attempts,
the Git diff including pre-existing user changes, and tests actually run.
Do not accept a scope violation, unknown-after-restart, abandoned reservation or
unconfirmed cleanup as a completed implementation. The primary agent decides
correction, escalation or rethink; the human decides declared approval,
publication and exact patch integration gates.
