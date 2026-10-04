# Bounded repair loops

In the Workflow inspector, add a Repair loop with entry, exit, region members, finite `max_rounds` and a stop condition. Bind prior review feedback through `feedback_bindings`. Review exits use fresh read-only workers; place final human acceptance outside the loop.

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
