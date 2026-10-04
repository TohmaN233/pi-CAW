# Pi execution and handoff

This preserves the portable handoff, item acceptance and identity rules of the
upstream native execution contract. Pi's Host owns native SDK session operations;
Codex-specific argumentless spawn/follow-up tools are not Pi tool names.

## Host-owned dispatch

`caw run` starts the selected immutable Workflow with an absolute workspace and
registered inputs. The Host pins the current Pi session identity and child
Provider bindings. It creates claims, leases, dispatch markers and task bundles;
the model does not copy or manufacture those fields. Every child launch uses the
exact selected model/thinking, fresh-context policy, workspace, access, grants
and result schema. Missing capabilities or bindings fail before model dispatch.

The Host materializes a bounded index plus exact input, immutable resource and
verified-file sidecars. Large files are read through their declared resource
interface, not concatenated into a single-read index. Projected object/list data
and path/hash file references are deterministic Host material. Do not transcribe
input records, source text, IDs, hashes or logs between conversations.

The real Pi adapter launches an independent Node owner through exact private IPC.
It captures the same SDK and Provider contracts, retains child sessions when the
parent Host closes, watches controller authority and publishes heartbeat and
quiescence evidence. Missing original-chat Main bridge produces `waiting_parent`;
reattachment preserves its exact actor without replay. Private owner/bridge
descriptors and bootstrap credentials never enter model packets or public status.

Provider nodes create focused native Pi sessions. Thread nodes retain their exact
session and declared one-to-one continuation lineage; an isolated worker or
fan-out does not imply a persistent task. An unresolved continuation occupies its
original dispatch lane until evidence proves termination or exact recovery.
Cooperative children retain their configured native tools. Strict children get
only their declared resource and bounded tool interfaces, without ambient context
or implicit Skills. A prompt is not an OS sandbox.

Each native child tool call, including native MCP/search/codemode, checks the
current exact lease before execution. A revoked claim cannot use a queued tool
to produce another effect while the owner watcher is stopping it. Function-based
native Providers require an explicit trusted Host module for an independent
process. An explicit `detached_host: false` chooses in-process execution; a failed
bootstrap must not silently change mode or model.

## Concurrency and deterministic item acceptance

`subagent_count: auto` without a list fan-out resolves to exactly one child.
With an explicit fan-out, the Host derives count from the runtime list and any
declared batch size. Fixed counts above one require real item assignments and
an all-required result join. Main cannot configure child count. These rules
apply at validation, startup admission and dispatch without rewriting the graph.

The Host launches the complete released concurrency window and owns the event
wait, release of free slots, result validation and deterministic dispatch-order
join. Main should not poll, resubmit the same packet or add a second wait while
that owner is active. Completion notifications or an exact `caw wait` action
provide the next actionable controller step.

Children write only assigned artifacts and use `caw_submit_result` for the
declared semantic result. The Host validates the exact completed child turn,
computes scope evidence and supplies the completion envelope. It journals valid
per-item results immediately. Internal positions, dispatch indexes, accepted
item identities and receipts remain Host-owned rather than model response fields.

For `result_mode: per_item`, repair uses the same child session with only its
unresolved items and exact diagnostic. Accepted items and siblings are retained
and never replayed. `item_delivery: incremental` releases one unresolved item at
a time and continues that same exact session only after accepting the previous
one. On interrupted delivery, the exact persisted content-addressed dispatch is
reconciled before any later item is released. Retry may not regenerate a whole
partition or substitute a helper to evade that lane.

## Logical Main context

Logical Main inherits this conversation's actual model and thinking at dispatch.
Each Main node selects `executor.mode: worker/orchestration`; absent mode defaults
to worker. Worker isolates focused work; orchestration keeps this chat and its
native Pi tools, including shell and configured helpers. Orchestration requires
Cooperative policy and the initiating workspace. `run.main_modes` may override
root Main nodes for this Run; Host validates and freezes each choice. Historical
Runs retain their saved legacy `main_context`, never a new implicit selection.
The Host owns fresh execution sessions, scope, journal and result evidence; no
child Provider binding is needed. A current-mode `PI_CAW_MAIN` follow-up opens one
exact granted packet. Inspect it with
`caw main_task`; read pinned bytes with `caw main_resource`; perform only declared
broker operations with `caw main_tool`. Orchestration may use the actual native
tool catalog and launch configured Roles without widening its node grant. Helpers
inherit revocable authority and finish before Host completion. Native workspace
effects are audited; this is not an OS sandbox. `caw main_result` submits the semantic
value, and finishing the turn lets the Host verify actual JSONL tool evidence and
completed-turn identity. The submission is not itself final human acceptance.

Main's `run_snapshot/pause/cancel` refer only to the active packet Run. A chat
switch fences new execution by the old Main. Abort/close still address the
original acquired task object, so its broker can settle without stopping the new
conversation. A child or Role terminal notification does not settle root ownership.

Do not manually supply another Main model/session, identity or receipt fields in
the result. Do not load the original Skill or treat existing chat history as
isolation. Strict Main is isolated by the Host and cannot be downgraded.
Authoring's final stage uses the pinned independent
reviewer Provider and exact human publication boundary, not a second Main.

## Completion, stopping and recovery

A model's stopped turn is necessary execution evidence, not proof that scope,
output, artifacts, approval, integration and final acceptance succeeded.
Inspect actual errors and effects. Stop and quiesce the exact owned session and
program unit before releasing its authority. Cancellation requested, timeout and
transport loss are uncertain states, not evidence of successful shutdown.
Read [recovery](recovery.md) before reattaching or retrying; a durable closed
result is consumed without a new model call or attempt charge.

Close every node's effect owners before recording successful completion. An
uncertain startup remains tracked even if task creation returned no task, or an
earlier fan-out child closed successfully. Preserve interrupted attempts and
cleanup errors; do not publish a false `session_state: closed` receipt.
