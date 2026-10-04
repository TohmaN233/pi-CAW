---
name: pi-caw
description: Keep the Pi Workflow control plane available, route concrete execution tasks to matching Ready Workflows, and use enabled Workbench Roles for useful ordinary-task delegation. Manage Workflows when requested; do not start Runs for planning, discussion, comparison, audit, or experiment design.
---

# Pi Workflow control plane and Role orchestration

Host program updates with unchanged registered interfaces do not require
Workflow rebinding or republication. Treat implementation fingerprints as
receipt evidence. On a pre-creation refusal, inspect the exact admission phase;
a domain task explicitly marked retryable can reuse its user request. Unknown
dispatch failures and already-created Runs require their existing Run status.

The plugin Host is the persistent control plane, available without a matching
Workflow. A Workflow is an end-to-end graph for a task intent. A Role assigns one
helper during ordinary work. It does not start a Workflow Run and its instructions
do not enter a running Workflow node.

Use the `caw` tool with `{action: "operation", args: {...}}`. In the references,
`caw operation` is shorthand for that call, not a shell command or a separate tool.
Open `/caw` when the user requests the Workbench. Opening the Workbench creates no
Run or helper. Read only the reference relevant to the operation being performed.

A failed Run is an unfinished user task. Treat `completion_satisfied: false`,
`recovery_required: true`, failed nodes, and unresolved execution as recovery
signals. Inspect the exact node and retained evidence, repair the definition or
use an allowed targeted retry. Report Workflow completion only when the required
final node and acceptance make that exact Run `succeeded`.

Run status appears in the initiating chat without another model turn. Do not poll
or narrate each tool call. Process data for quiescent failed/cancelled Runs is
cleaned automatically; succeeded Runs retain it for 24 hours by default. The
Workbench Run history offers retention settings and “Clean finished runs now”.
Interrupted, paused, pending and uncertain Runs retain recovery evidence. Cleaned
Runs expose a compact saved result through `get`, but cannot execute again.
Deliverables and original chats are retained at their existing paths.

## Route the request

- **Execute:** for an unpinned concrete task, call `caw route` with the task. It
  returns compact, valid Ready candidates, not prompts or the whole library.
  Start the selected candidate automatically when one clear semantic match exists.
  Ask only when candidates differ materially in outcome, permissions or effects.
  Do not select by keyword overlap alone. If none fits, continue ordinary work
  and use an enabled Role when one helper would materially help.
- **Manage:** create, import, inspect, debug, edit, publish, install or export a
  Workflow. Read [editing](references/editing.md) and follow the requested path.
  Ordinary graph and resource edits are available to the task owner. Model
  configuration, approval, exact publication acceptance, integration and cleanup
  retain their explicit human boundaries.
- **Meta:** planning, comparing, auditing, evaluating or designing experiments
  about Skills or Workflows. Work directly. Mentioning the plugin alone does not
  authorize starting a Run.

When the Host supplies an exact Ready Workflow ID/revision or a node packet, do
not list, route, inspect or reload the Workflow. The Host has already selected it.
Only the current validated Ready revision may be automatically routed. Drafts,
retired Role graphs, previous revisions and conversion history are not execution
context. `caw list` is a management operation, not the startup routing path.

## Use Roles in ordinary work

Apply Role orchestration whenever the plugin is loaded. The user need not name a
Role. If no registered Workflow matches and a helper would materially help, call
`caw role_templates`, choose one enabled Role whose description fits, then call
`caw role_template` for that Role only. Supply the complete assignment, owned
files, constraints and verification. Do not load every Role's instructions.

Follow the returned adapter and actual available Host route. `caw launch_role`
uses the configured Pi child binding. A returned instruction profile can also be
used with an available native Pi delegation adapter that honors its exact model,
thinking, access, approval and fresh-context contract. Do not silently replace
any of those choices or invent an unavailable route. Report a blocked binding or
adapter and let the user configure it in the Workbench.

The primary agent remains responsible for user intent, splitting the task,
integration, verification and the final answer. A helper assignment has explicit
ownership; helpers sharing a checkout must preserve other agents' edits. After
launch, do useful work independent of the helper's result and owned files. When
the next action depends on the helper, use its actual lifecycle's event wait with
the longest supported bounded timeout, up to one hour. Completion or user input
wakes the wait. Do not poll, reread inputs or repeat planning while waiting.
Inspect actual changes and verification evidence after completion.

Use one Role for one clear assignment. Add another for independent parallel work
or requested independent review. Correct a failed local assignment with the same
helper where its adapter supports continuation. Never replay accepted work.
A generated Workflow may use Role suitability to select a Provider; a running
node receives only its pinned Provider and node task, without Role injection.

Modes supply editable saved defaults; they do not partition the installed Workflow library. All installed Workflows remain selectable. A user-enabled Workflow still needs its declared tools and bindings. Native Pi does not require a Mode Pack.

## Execute a selected Workflow

Call `caw run` with the exact selected Workflow, task and absolute workspace.
Pass existing structured local data with `inputs_path`, or the scalar local
address expected by a registered Host tool. Do not open a manifest and copy its
fields into `inputs`: nested model-transcribed inputs are rejected. Host step 0
verifies and registers dependencies before effects. Report missing dependencies
and obtain consent before installation. Discovery and local registration do not
need an invented model node.

Runs execute asynchronously under the Host. Provider nodes launch focused native
Pi child sessions. Thread nodes continue the exact pinned session lineage; fan-out
uses the declared release window, per-item grants and deterministic result join.
The default real Pi adapter owns execution in an independent Node process. Child
work can outlive the parent Host; Main still requires the original current-chat
bridge. An absent bridge produces `waiting_parent`, and reattachment preserves
the exact actor. Do not create a substitute Main or replay the pending dispatch.
The Host owns launch, claims, identities, leases, receipts, projection, results,
retry and continuation. Model output contains only newly produced semantic
values. Read [native execution](references/native-execution.md) for execution and
item-repair boundaries, and [providers](references/provider-contracts.md) when
binding or inspecting an executor.

Logical Main belongs to this Pi conversation and inherits its current model and
thinking. Each Main node uses `executor.mode: "worker"` (default, fresh context
with only declared inputs/resources) or `"orchestration"` (current chat and native
Pi tools, Cooperative only). Propose a per-node Run selection with `args.main_modes`,
for example `{focused:"worker", final:"orchestration"}`; the Host validates and
pins the choices before Run creation. Choose worker for bounded production;
choose orchestration when current-chat decisions or helper coordination matter.
Old Runs retain their saved context. Orchestration cannot weaken Strict. The Host creates
fresh isolated execution sessions without another Provider/model binding; their
actual journals remain bound to the original actor. On `PI_CAW_MAIN` dispatch, call
`caw main_task` for the exact node grant; use `caw main_resource` for pinned bytes
and `caw main_tool` for an authorized broker action. Orchestration can also use
native Pi tools and configured helper Roles within its grant. Submit only the declared
semantic value with `caw main_result`, then finish the turn. The Host validates
actual entries and completed turns in this chat; a model-written identity or
receipt is not execution evidence. Independent authoring review is a Provider
child at the Host publication boundary, not another Main.

Every child requires an explicit available Pi model and supported thinking
binding. Defaults leave the five logical slots unbound. Missing, changed or
unsupported bindings block dispatch; do not inherit the planner model, the
current-chat model or a fallback. Pi owns model transport and authentication.
Function-based native Providers need an explicit trusted Host module for an
independent owner. The user may explicitly select `detached_host: false` for
in-process execution; serialization failure does not authorize an automatic mode
change. Keep private RPC credentials and Host bootstrap outside model context.

Do useful independent work while a Run proceeds. The Host notifies this chat of
completion or actionable attention. When an exact controller needs a wait, use
`caw wait` with its bounded event wait and follow the returned action. Avoid tight
polling or a second Main wait. A stopped model turn alone is not completion.
Workflow approvals and the current Pi final-proposal publication gate require a
human Workbench decision on the exact persisted proposal hash.

## Preserve data, resource and permission boundaries

Do not make any agent hand-copy unchanged input or resource values. This applies
to arbitrary records, labels, names, source text and metadata, as well as IDs,
paths and hashes. Bind the original value separately beside the newly created
semantic result, or use an exact registered Host tool to transform or join it.
Per-item writer task packets must come directly from Workflow inputs or an exact
Host tool; wrapping an upstream agent-produced packet in a Host join does not
make that packet Host-owned.

When a pinned resource explicitly names a `*.schema.json` contract, select its
Host-indexed full or property `contract_ref`; preserve the exact bounds and
optional fields instead of rebuilding them. Ordinary JSON and Python artifact
observations are not exact schema authority. Missing projections may be omitted
only for optional arguments of the exact registered Host tool. Required inputs
must remain bound and visible failures; do not replace absence with null or an
Agent-generated identity.

Host admission, compilation and the later machine gate must use that same exact
schema authority. A compiler/schema mismatch is a mechanical Host error; retain
the completed planner artifact and recheck it after repair instead of asking a
model to invent a different interface. A settled owner error is actionable
attention even when its recoverable Run has not reached a terminal state.

The Host materializes bounded indexes and exact input/resource/file sidecars;
large file contents do not share a single-read index. Children submit only
semantic values through `caw_submit_result`; the Host supplies completion
identities, envelopes and evidence. Preserve declared input bindings, immutable
resources, explicit access and path grants. Follow [parallel work](references/parallel.md)
for writing branches and exact human patch integration.

A converted Workflow is a self-contained replacement for its source Skill.
Runtime must not read the original Skill, a copied `SKILL.md`, conversion history
or undeclared ambient Skill instructions. Required scripts and references are
Workflow-owned assets. A runtime request for the old source Skill is a defective
package. Current-chat Main retains its existing chat history; isolated Main sees
only its supplied prompt, inputs and resources, not that chat or ambient context.

## Recovery and Host availability

Read [recovery](references/recovery.md) for pause, cancellation, restart,
reattachment, durable result consumption or controller adoption. Recover the
exact Run and attempt; never search for a latest task or launch a replacement Run
to conceal an unresolved owner. Do not release a continuation lane until actual
termination and cleanup are confirmed. Keep control tokens out of child context.

Read [connection diagnosis](references/connection.md) when tools or Workbench
transport are unavailable. Report observed errors; do not invent receipts,
server state or a substitute execution mode. `caw capabilities` describes the
actual qualified Host. A portable tool broker is not an OS filesystem sandbox.
Strict execution must use its declared resource/tool boundary, including isolated
logical Main. A request for current context cannot downgrade Strict to Cooperative.
Optional WSL execution requires an explicit qualified Host binding.

For system ownership and store boundaries, read [architecture](references/architecture.md).
For migration provenance, tested scope and remaining capability differences, see
[parity evidence](../../docs/PARITY.md) and [Host contract](../../docs/HOST.md).

## Bounded repair loops

Use structured Workflow loops when downstream review must send work back for source-bounded repair. Host controls rounds, feedback, failed-item selection and immutable evidence. Review only assigned current items and return new semantic verdicts in supplied order; never copy IDs/paths/hashes. An empty first repair pool is skipped. Changed accepted artifacts or dependencies require fresh review rather than rewriting accepted siblings. Exhaustion is unfinished delivery, not success; final human acceptance stays outside. Read [loop contracts](references/loops.md) when authoring or diagnosing a loop.
