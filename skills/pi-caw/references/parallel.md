# Parallel writes

Use concurrent read-only branches for independent work. Use qualified Strict execution and owned Git worktrees for parallel writers. Declare each writer's paths and baseline; serialize continuations of the same task.

At the Join:

1. Call `caw prepare_integration` for the Run and Join.
2. Read `caw review_integration` and inspect the complete patch, checks, conflicts and pre-existing user changes.
3. Have the user accept the exact patch hash through Workbench integration.
4. Use Workbench cleanup after integration and confirmed executor shutdown.

For a conflict or cleanup failure, inspect the recorded operation and resume that operation after reconciliation. Retain accepted writer results.
