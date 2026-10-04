# Sessions and results

- Start with `caw run` using the selected Workflow, absolute workspace and declared inputs. Resolve reported dependency requirements before execution.
- Provider nodes use focused child sessions. Thread `start` creates a persistent session; `continue` follows its declared upstream session and Provider. Keep that lineage when resuming.
- Main `worker` uses isolated context. Main `orchestration` uses the original chat and native tools under Cooperative policy. Use the grants returned by `main_task`; helpers remain within that grant and finish before Main completion.
- Read large inputs through their declared resource interfaces. Bind unchanged records and file references directly between nodes.
- Write only assigned artifacts and submit new semantic values through `caw_submit_result`. For current-chat Main, submit through `caw main_result` and finish the turn.
- For `result_mode: per_item`, repair only unresolved items in the same child session. With `item_delivery: incremental`, wait for acceptance before releasing the next item. Retain accepted items.
- Use Host notifications or `caw wait` for progress. For interrupted dispatch or uncertain shutdown, follow [recovery](recovery.md) before retrying.
