# Parallel execution and integration

Ready read-only nodes for independent tasks may run concurrently. Continuations
of the same task, including indirect source aliases, must be serialized across
parallel branches. Mutually exclusive alternatives may share a task. The runtime
also fences unresolved dispatches in historical graphs; a changed graph does
not erase an active lane.

Parallel writes require the backend's owned isolated Git worktrees and qualified
Strict execution. Cooperative writers must fail before worktree provisioning or
model dispatch. Each writer gets its own workspace, pinned baseline and declared
paths. Do not turn those branches into multiple writers in the original checkout,
give a child Git metadata permission or bypass the integration manager.

At the declared Join:

1. Use `caw prepare_integration` for the exact Run/join identity. The Host prepares
   the complete deterministic candidate patch from the recorded writer branches.
2. Read `caw review_integration` and inspect the whole patch, branch evidence,
   actual checks and any unresolved effects. Preserve pre-existing user changes.
3. A human accepts the exact reviewed patch hash through
   `caw integrate_parallel`. A model's favorable review does not supply that
   acceptance or authorize a different/newer patch.
4. Use `caw cleanup_parallel` only after supported integration/reconciliation and
   its exact human cleanup gate. Preserve owned uncertain Git-operation markers
   until their recorded operation and workspace are reconciled.

Reopening a review, retrying cleanup or recovering the controller does not replay
accepted writers. Inspect the exact recorded state and resume only the unresolved
operation. Report conflict, changed baseline, unsupported Strict capability,
hash mismatch or cleanup failure visibly.

`test/parallel-pi.test.mjs` covers two Strict Pi child writers in real Git
worktrees, exact human integration and cleanup, and rejection of Cooperative
parallel writers. It uses offline child execution, so it does not prove every
real Provider model, Git setup or remote integration environment.
