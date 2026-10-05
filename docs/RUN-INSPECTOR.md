# Workflow execution cards (0.2.29)

Chat status is a compact per-Run snapshot of actual node state, executor kind,
pinned/observed model, latest operation and attempt count. Pi sends it only to
the initiating conversation, without triggering a model turn, and excludes it
from model context. Internal operation changes update cards even when the
top-level status text stays the same.

`PiCawService.call('inspect_run', {run_id, node_id?, attempt_id?, session_index?, before?})`
is a portable read-only inspector. It reads exact Host journals and native SDK
session receipts without contacting detached workers or admitting execution.
The calling actor must own the Run. It returns no controller tokens, leases or
Provider configuration. Clients cannot supply filesystem paths. Native headers
and `pi-caw:task` Run/node bindings are verified before reading messages.
Current-chat orchestration exposes its attempt operations and result, without
copying unrelated parent history.

Details load only on expansion. Reads are bounded to a 1 MiB window and 40
messages with byte cursors for earlier pages. Partial live JSONL lines wait for
the next refresh; malformed complete records and missing files surface as
explicit errors. Fan-out receipts retain each actual session identity, and
retention cleans those exact sessions with existing ownership checks. Continued
threads remain within the same Run.

Temporary execution JSONL lives in plugin-private `execution-sessions/<run_id>`
storage, outside Pi's chat session catalog. Retention uses the same exact receipts
and preserves explicit persistent threads. Independent Role results remain in
their durable Role journals after successful transcript cleanup; failed or
uncertain Role transcripts remain available for diagnosis.

Pi delays creating native JSONL until the first assistant reply finishes. Native
SDK stream phases and tool start/end events therefore journal compact metadata
while that first reply is pending. The inspector identifies this exact state
explicitly instead of reporting a false missing-file error. Missing files after
a completed reply still fail visibly. No streamed text is duplicated into the
Run journal.

pi-own keeps a card at the Run's first visible position, replacing facts without
remounting. Users can select nodes, attempts/loop rounds and execution sessions,
switch task/reply views, and read actual messages/tools with the existing shared
MessageView. Expanded active Runs refresh every three seconds; collapse stops
reads. Cleaned Runs explicitly identify removed process history and preserve
saved results. Every chat mode shares this UI; the plugin has no Next.js, Course
Builder or Mode Pack dependency.

Tests cover actor/receipt scope, malformed and partial JSONL, Unicode pagination,
fan-out selection, compact operation updates and cleaned results. The standalone
real Pi SDK smoke test verifies actual worker messages/tool results and absence
of parent context using an offline faux model, with zero paid calls.
