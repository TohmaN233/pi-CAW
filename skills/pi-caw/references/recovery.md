# Recover a Run

1. Start from the exact Run/node/error in the notification or `caw wait` result. Use `caw get` for attempts, `caw events` for missing history, or `caw run_definition` for the pinned definition as needed.
2. `caw pause` stops new dispatches; `caw cancel` requests authority revocation and shutdown. Wait for confirmed termination before retrying or reporting cancellation.
3. If no dispatch occurred, use `caw recover_claim`. If a successful result is durable and closed, use `caw recover_result` to collect it without another model call.
4. For an interrupted child Workflow, use `caw reattach_subworkflow` and `caw child_control` with its recorded identity.
5. After restart, reconcile the owner and use `caw resume` with `after_restart: true`. `waiting_parent` needs the original Pi chat bridge.
6. If controller authority is lost, use Workbench adoption or `caw recover_control` after the user authorizes that exact Run. Supply the observed sequence, current actor, reason and actual user authorization. Wait for old-owner shutdown before resuming.
7. Use `caw retry_node` within the saved retry budget after effects are reconciled. Keep completed results and accepted items; leave uncertain dispatches pending for diagnosis.

For a cleaned Run, `caw get` returns its saved result. Use a new Run for new work. Open Workbench Run history to configure retention or clean finished Runs.
