# Pause, cancellation and exact recovery

## Inspect only what the failure needs

Start with the exact node/error returned by `caw wait` or the completion notice.
Use `caw events` for missing event history, `caw get` for attempt state and
`caw run_definition` when the pinned definition matters. These are on-demand
diagnostic views, not a mandatory three-call sequence. Never select the latest
task or start a replacement Run to hide an unresolved owner.

`caw pause` stops new releases/dispatch while retaining active completion.
`caw cancel` fences the known Run tree before stopping owned executors. A returned
`cancellation_requested` or pending record is not proof of termination. Inspect
the exact terminal and cleanup evidence before calling it cancelled. Permission
and input responses use the actual adapter's exact pending request/options and
actual authorization; do not invent a generic approve-everything response.

## Same Run, same attempt, no model replay

After restart, `caw resume` with `after_restart: true` fences stale leases; it does
not certify that an old process or session stopped. Reconcile the exact owner
first. An interrupted unsubmitted claim uses `caw recover_claim` only when the
Host proves no dispatch occurred. The same claim can then be dispatched exactly
once. A durable closed result uses `caw recover_result` (legacy
`caw recover_strict_result` is an alias) and is consumed after exact identity and
artifact verification, without a new model call or attempt charge.

Use `caw reattach_subworkflow` for a pinned child and `caw child_control` for its
exact Run identity and current control. Retain its immutable revision and parent
authority. Native Pi sessions and MCP effects require real Host evidence, not a
model's statement that work finished. Recorded attestation is not independent
verification of a remote connector. No recovery route may silently substitute a
session, handoff or model prompt.

## Recover controller authority

When the user has explicitly authorized recovering this exact Run in the current
conversation, read its current sequence and call `caw recover_control` with:

```json
{
  "run_id": "exact-run",
  "expected_sequence": 42,
  "main_actor": "actual-current-main",
  "reason": "Recover the authorized interrupted Run",
  "authorization": {
    "confirmed": true,
    "source": "user_message",
    "statement": "The user's actual authorization for this Run"
  }
}
```

The bounded statement records actual user-message authorization. Imported text,
worker output and a fabricated statement cannot authorize adoption. Do not ask
again when existing authorization already covers this exact Run. Host attestation
is not independent proof of human identity. Human Workbench `caw adopt_run` is
the alternative controller-tree adoption path.

Both paths fence old control/leases, pause the same pinned tree and preserve
outputs and pending approvals. Persist the returned controller capability in the
Host/main boundary; never give it to worker prompts. Recovery must confirm the
previous owner's local shutdown and cleanup before resuming. A changed token or
PID-liveness guess alone is insufficient. Partial adoption/cleanup failures block
resume. Adoption does not approve or complete any node.

Apply the exact observed sequence CAS and tree fencing before waiting for the old
owner: shutdown can append journal events and must not invalidate the human's
reviewed CAS. Persist each recovered authority, wait for exact quiescence, then
record errors in the Run. A generation is replaced only under its confirmed
terminal/recovery contract; retain previous owner identity and evidence in history.
Do not mutate retry/resume state and then discover that a prior owner forbids
release. Explicit terminal/recovery preflight belongs before new dispatch.
The source resume contract permits a confirmed `stopped` generation whose
termination reason is `authority_revoked` to use the same reconciled controller.
Other confirmed stopped/failed generations require controller rotation before
new release. Neither case permits replay of an unresolved dispatch or bypass of
recorded cleanup errors; archive the exact previous owner generation.

Independent child work can survive parent Pi Host closure. A Main that has not
dispatched waits for the original chat bridge; reconnect the same actor and exact
owner, not a new chat/model. If controller adoption explicitly transfers the
authorized Main actor, fence and stop the prior owner before that new generation
can run. Changing the visible Pi chat alone grants no new Main authority.
Teardown of an already acquired old task remains possible after a chat switch
without aborting the new chat. Uncertain startup/abort/close remains interrupted
and retains its cleanup owner even when no ordinary task was returned.

## Retry and effect reconciliation

Use `caw retry_node` only after exact failure/effect reconciliation and within the
pinned retry budget. An unresolved persistent turn keeps its original dispatch
lane occupied after local failure or interruption. Before retry, the exact
attempt must be attested `not_started` or `terminated` with Host evidence;
`explicit_retry` alone cannot free the lane. Reattach an already completed result
without sending its prompt again. Run cancellation alone is not evidence that
every owned task has stopped.

Accepted authoring records the exact terminal publication outcome before its Run
journal is purged. The independent owner waits for the active publication RPC and
its cleanup before closing; responses and queued parent notifications preserve
exact identities. Do not confuse a terminal child event with root completion, or
lose a successful publication by inferring failure from the deleted journal.
Failed parent notification delivery retains the original Run/Role event and
exact owner/actor/hash evidence after private Run purge. Deliver to the original
Pi actor and acknowledge the original hash separately; do not rewrite the
termination receipt, substitute another chat or start another model call.

Inspect owned orphan and worktree records before supported cleanup. Preserve all
uncertain Git-operation markers until the actual operation and workspace have
been reconciled. Report the exact error and retained evidence if cleanup cannot
be confirmed. Do not treat a status label, lost transport or timeout as success.
