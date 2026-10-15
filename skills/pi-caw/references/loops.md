# Bounded repair loops

In the Workflow inspector, add a Repair loop with entry, exit, region members, a positive finite `max_rounds` and a stop condition. Bind prior review feedback through `feedback_bindings`. Ordinary review exits use fresh read-only Main workers, isolated workers or review Providers; place final human acceptance outside the loop.

```json
{"loops":[{
  "id":"review-repair", "entry_node":"repair", "exit_node":"review",
  "node_ids":["repair","review"], "max_rounds":3,
  "until":{"op":"eq","args":[{"path":"/nodes/review/output/accepted"},{"value":true}]},
  "feedback_bindings":{"findings":"/nodes/review/output/findings"}
}]}
```

The repair node reads `/loops/review-repair/feedback`, initially empty. Review returns new semantic verdicts. Use a closed DAG region with complete parallel/Join boundaries.

For item repair:

1. Set `item_scope.items`, `verdicts` and `paths_field`; add `dependencies_field` for shared files.
2. Bind review and repair tasks to `/loops/<id>/review_items` and `repair_items`. Bypass the empty first-round repair pool.
3. Return one `{accepted:boolean,findings?:newSemanticValue}` per reviewed item, in order; the Host keeps original identities.
4. Repair only failed items and review accepted items again when their files or dependencies change. Use `/loops/<id>/all_accepted` as the item stop condition.

Correct submit-time schema diagnostics in the current turn. On `LOOP_EXHAUSTED`, inspect the retained findings and ask for a revised task or budget before further work.

Semantic plans and imported graphs may explicitly declare `review_context: "current_main"` when the source asks to review in the active Main conversation. The exit must be read-only `orchestration_read` and the loop must stop only when its boolean `accepted` output is true. This explicit mode may use a positive finite `max_rounds` or `null`; ordinary fresh-review loops always stay finite. Unbounded repeated review is preserved only when the source explicitly names current Main and a covering loop has `max_rounds: null` with the required acceptance condition. Keep source-required independent review in a fresh review context.

This source declaration is the default execution context. A caller may explicitly freeze a `main_modes` worker override for the acceptance node without editing the imported graph. Preserve its initiating Main ownership, original inputs, read-only acceptance, feedback and round policy; record the actual isolated execution thread. Run workspace need not match the chat cwd.
