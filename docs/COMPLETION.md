# Embedded driver completion

## Native SDK semantic completion

`PiSdkHost({ ..., endOnSemanticSubmission: true })` explicitly enables completion
after a validated `caw_submit_result` tool batch in fresh SDK tasks, including
isolated Main. The default is `false` and still requires an actual assistant
`stop`. Current-chat orchestration uses its own completion protocol. Configure
the option on the executing Host; it is not implicitly transferred to detached
owners.

The option requires the public `session.agent.finishTurn` property. Startup fails
with `PI_FINISH_TURN_UNSUPPORTED` when that API is absent. The Host wraps the
existing hook after extension binding, awaits it and preserves an explicit
prior decision such as `continue`.

The Host ends a turn only after schema and Host validation accept the submission,
the accepted tool-call ID appears in the completed batch, every requested tool
has one matching successful result, and the assistant stop reason is `toolUse`.
Staged bodies, failed tools, truncation and cancellation do not qualify. Returned
results identify `completion_mode` as `semantic-submission` or `assistant-stop`
and retain the actual stop reason, persisted turn ID, usage and submission tool
evidence. Integrators should preserve these fields rather than infer a synthetic
assistant stop.

`test/native-semantic-completion.test.mjs` exercises the real SDK with its faux
provider, without paid calls.

## Embedded driver completion

`PiCawService.awaitCompletion(runId)` is a trusted, in-process embedding API.
Call it after `call('run', { ..., detached_host: false })` returns. It waits for
the latest local driver generation at the time of the call, including its
worker journal commit, parent collection and terminal notification. It returns
the driver's outcome; a returned `attention`, `paused` or acceptance outcome
does not mean that the Workflow succeeded. Existing waiters retain the exact
generation when the same Run is explicitly resumed.

The API retains settled outcomes for the service object's lifetime. It works
after the driver is removed from `active`; callers must not read that internal
map. Unknown Runs and detached owners return `PI_COMPLETION_UNAVAILABLE`.
It neither starts nor resumes execution, retries persistence, dispatches a
model, repairs a journal nor changes cancellation authority.

`wait` observes Workflow state and can report `completion_satisfied: true`
before the worker's final journal write or notification finishes. An embedding
must additionally await driver completion before treating that state as a
fully completed local invocation. For example:

```js
const run = await service.call('run', { ...request, detached_host: false });
const outcome = await service.awaitCompletion(run.run_id);
if (outcome.status !== 'succeeded') throw new Error(`Run stopped: ${outcome.status}`);
const state = await service.call('get', { run_id: run.run_id });
```

The Host still owns cancellation and must always await `service.close()` in
cleanup, preserving both an invocation error and any additional cleanup error.
Do not call `awaitCompletion` or `close` from the notification callback for the
same driver: that callback is part of the completion being awaited.

Initial or terminal worker journal failures, parent collection failures and
notification failures reject with the original error object. An ordinary
driver exception retains the existing durable `attention` behavior; failure
while writing or notifying that attention outcome rejects with an
`AggregateError` containing both original causes. This does not change the
core execution engine's existing handling of model/drive errors.

Shutdown fences new local drivers, aborts active controllers, attempts retention,
bridge and Host cleanup, then drains retained driver and current Role results.
A single failure is rethrown unchanged; multiple failures are aggregated.
Repeated `close()` calls share the same shutdown outcome. Observing an error
through `awaitCompletion` does not erase it from shutdown diagnostics.

## Verification and provenance

The embedded completion adapter and its regression coverage were developed in
the separate completion worktree and merged into the 0.7.0 release. The later
upstream SDK ownership and retention migration was inspected but is not part of
this change.

`node --test test/service-completion.test.mjs test/service.test.mjs test/notification-lifecycle.test.mjs test/service-recovery-binding.test.mjs`
checks exact error identity, terminal notification ordering, early/late shutdown,
secondary cleanup failures, explicit generations, and existing attention and
acceptance behavior. Windows additionally uses a real no-delete-share file
handle to deny the original durable writer's terminal rename, with zero model
calls. The fixture's lock holder is known; it does not identify the process
responsible for any earlier production EPERM. The fix propagates persistence
failures; it does not claim to eliminate Windows sharing violations.
