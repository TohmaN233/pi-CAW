# Control-plane architecture

Adapted from upstream 1.1.1 ownership, privacy, permission and evidence policy;
source provenance is in [upstream.json](../../../docs/upstream.json). The original
Task Type/Stage terminology is represented by Roles and Workflow graphs here.

## Ownership and layers

The primary agent owns the user's requirements, task split, integration,
verification and final answer. The control plane is a policy, prompt, transport
and evidence boundary. It cannot grant itself acceptance or external authority.

1. The current Pi conversation is logical Main. It sees sanitized descriptors,
   selects a suitable Role or a valid Ready Workflow, and performs the exact Main
   nodes delivered by the Host.
2. The human configuration plane stores policy outside the package installation,
   owns model bindings, approvals and exact publication/integration decisions,
   and exposes the original Workbench through a token-protected loopback server.
3. Pi adapters own real child sessions, persistent thread continuation, native
   tools and native MCP. Portable graph/store/runtime contracts remain separate
   from the model transport.
4. The evidence layer verifies exact dispatch, session and completed-turn
   identities, declared output, file scope, actual effects and acceptance.

Provider text is a claim. Model names, stopped output or a JSON receipt typed by a
model do not prove a dispatch completed. Only real Host observations can supply
dispatch identities, metering, receipt fields and terminal evidence.

## Prompt and credential minimization

Library and routing descriptors expose public descriptions, mappings,
capabilities, enabled/approval state and fingerprints. Resolve only the selected
Role or node's instructions. Do not load all templates, credentials, endpoints or
UI tokens into model context. A Role profile interpolates only its declared task,
context, constraints and verification; the Host retains identity and provenance.

Native MCP uses Pi's actual config, exposure, trust and OAuth machinery. Private
server configuration stays in the Host and only actual public tool metadata is
projected to a node. Workbench authorization is UI transport metadata rather
than model execution authority. No connector authentication belongs in a Pack,
portable export or copied model prompt.

This is context minimization and application authorization, not secrecy against a
local agent with broad OS access. Stronger isolation requires a qualified Host
boundary. Current-mode Main keeps its history. Isolated-mode Main uses a fresh
Host-owned SDK context with the calling chat's current model and thinking;
changing a prompt alone never establishes isolation.

## Durable state and shutdown

The default state directory is `pi-CAW` under Pi's actual agent directory. An
explicit absolute `PI_CAW_DIR` selects isolated/override state. Definitions, immutable
revisions and content objects are separate from Run journals, controller
capabilities, actual Pi session files and local dependency registrations.
Validate and atomically save policy; edit graph/resources under exact revision
CAS. Mutable paths and installed executable locations stay out of reusable
definitions. Deletion uses recoverable Pack trash.

After restart, an unresolved attempt remains unresolved. Do not automatically
resubmit a prompt, free a continuation lane or discard uncertain effects.
Recovery uses the same Run, pinned graph, exact attempt and persisted evidence.
Shutdown stops intake/dispatch, revokes broker authority and waits for owned
sessions, processes and effects to settle before reporting successful cleanup.

Independent Node ownership implements the original portable responsibilities:
journal-authority watching, heartbeat and terminal records, cancellation of
owned sessions and cross-process stop confirmation. Actual spawned-process and
Pi SDK fixtures verify child work after parent exit/Host close. Main remains the
original chat bridge and waits for exact reattachment; no replacement Main is
launched. Private IPC/RPC bootstrap credentials remain outside model context.
Read the [Host contract](../../../docs/HOST.md) and [parity evidence](../../../docs/PARITY.md)
for tested adapter scope, native Provider modules and remaining environment checks.

Recovery first applies reviewed sequence CAS and authority fencing, then confirms
old-owner shutdown and records cleanup errors. Those errors block resume.
Confirmed generation history remains readable. Unknown startup or effects retain
their exact cleanup owner; a stopped PID or an empty list of returned tasks is not
proof. Each node closes its owners before completion. Child/Role terminal events
cannot terminate root ownership, and authoring records publication before purge.

## Effective permission gate

A route is usable only when global policy, the selected Role/Workflow, pinned
Providers and environment switches permit it. A writing assignment requires a
write-capable Provider, `bounded_write` node intent and a nonempty validated path
boundary. If a Provider or node requires approval, the exact current assignment
must have actual approval; a model cannot infer approval from a previous task.
When the configured gates are off, do not invent another confirmation prompt.

Allowed paths are workspace-relative, non-glob and non-escaping. Resolve existing
or nearest existing parents to reject symlink escape. Read-only grants permit no
writes. Preserve pre-existing user changes in inspection and integration.
Observed effects outside the grant invalidate the result and retain diagnostic
evidence. Final scope checks supplement tool authorization and runtime effect
observation; neither is an OS sandbox claim.

Strict is an explicit qualified executor choice. Cooperative execution retains
only its configured Host behavior and scope; Strict must not fall back to it.
Parallel writers require qualified Strict execution in owned Git worktrees and
human acceptance of the exact integration patch. A Provider's general write
capability describes suitability, not authority for this invocation.
