# Host-controlled bounded repair loops

Pi-CAW 0.2.27 ports Codex CAW commit `8db71a32ef16f9ca3fb2dd671f985563e28e563e`.
It runs in native Pi SDK 1.0 without pi-own, Mode Packs, course data or GPT services.

## Edit a loop

Click the canvas background to select the Workflow inspector, then **Repair loops**.
Choose entry, exit, all region members, finite positive `max_rounds`, and a stop
condition. Rounds include the first review. Feedback bindings pass prior review
values to the next round. Advanced fields use existing JSON Pointer/condition DSL.
The canvas displays a region, not a graph back edge. Run view shows round/status,
feedback and history. Ordinary Workflows without loops keep their behavior.

```json
{"loops":[{
  "id":"review-repair", "entry_node":"repair", "exit_node":"review",
  "node_ids":["repair","review"], "max_rounds":3,
  "until":{"op":"eq","args":[{"path":"/nodes/review/output/accepted"},{"value":true}]},
  "feedback_bindings":{"findings":"/nodes/review/output/findings"}
}]}
```

`repair` can bind `/loops/review-repair/feedback`, initially empty. Review returns
new semantic values such as `{accepted:false,findings:...}`. Members lie on a
single-entry/single-exit DAG region. Nested and disjoint regions are supported;
overlap and incomplete parallel/join boundaries are rejected. The Agent exit is
fresh and read-only; Main exits must remain worker even after Run overrides.
Final acceptance stays outside. Review rejection is semantic data, not a local
retry or `fail_on_false` error.

## Item repair

Add `item_scope`: `items` selects originals from Run inputs/upstream Host output;
`verdicts` selects current review output; `paths_field` names the string-array
artifact field; optional `dependencies_field` tracks shared files. Return one
closed `{accepted:boolean,findings?:newSemanticValue}` per review item, in order.
Agents never copy original IDs, paths, positions, hashes or revisions into verdicts.
Host binds identity and projects `/loops/<id>/review_items` and `repair_items`.

First-round repair is empty; a condition bypasses it and review checks all originals.
Review must not require skipped repair output. Later repair gets only failed items.
Accepted siblings are retained. Changed artifact/dependency bytes require fresh
review of affected items; missing required artifacts become repair work. Host hashes
actual effective-workspace files, rejects escapes/symlinks, and distinguishes I/O
errors from missing files. `/loops/<id>/all_accepted` supplies the item stop condition.

## Execute and recover

Host resets only the closed region, preserving immutable round outputs, attempts,
verdicts and exact parallel/worktree ownership. Active/unresolved owners prevent
reset. Local attempt budgets count only the current round, and accepted results
from earlier rounds cannot leak into later repairs. Duplicate completion is
idempotent. Exhaustion reports `LOOP_EXHAUSTED` and blocks outgoing acceptance.
The model cannot extend pinned bounds or report successful delivery prematurely.

Pi preflights schema, verdict cardinality and source bindings before accepting a
result tool submission. Invalid output returns to the same live turn for correction.
Detached Main forwards validation via its authenticated attempt callback; private
Run state stays on Host. Completion validates again before committing. Build
Workflow and Skill2Workflow share loop-aware inventory/repair/Forge checking.
Future human feedback remains a continuation/new Run when not source-bounded.
No additional scoring gate, elapsed-time limit or default model is introduced.

## Evidence

The four `test/*loops*.test.mjs` / `workflow-loop-editor.test.mjs` modules cover
partial repair, dependency invalidation, nested boundaries, exhaustion, recovery,
source safety and editor binding preservation. `scripts/smoke-native-loops.mjs`
uses real native Pi extension/SDK with fake model transport: rejects malformed
verdicts in the same turn, repairs a rejected file, reads actual source in a second
fresh review session, and stops at human acceptance. No paid model call is made.
