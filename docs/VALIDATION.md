# Validation audit: 0.2.28

The audit compares the portable loop baseline with Codex CAW commit
`8db71a32ef16f9ca3fb2dd671f985563e28e563e` (still upstream main on 2026-10-03).
It changes representation and correction timing, not artifact permissions or
publication authority. It introduces no quality scores or extra model review.

| Boundary | Removed restriction | Retained behavior |
| --- | --- | --- |
| Semantic plan | Unused records/lists/enums/approvals/sequences/parallels/choices must be emitted as empty arrays | Omitted values get their unique empty interpretation, recorded as `host_empty_semantic_field`; supplied wrong types and unknown meaning fail visibly |
| Activity/result declaration | Empty inputs/outputs/tool and unused values/type_ref placeholders must be written | Required instructions/profile/source evidence and real named types are checked by the shared compiler |
| Targeted repair | Every unchanged upsert/remove collection must be emitted empty | Only selected stable-key changes may affect the cumulative plan; other keys remain protected |
| Loop exit | A fresh read-only reviewer must use the review Provider profile | Fresh Main worker, isolated read-only worker and review Provider are eligible; writes, orchestration and continued tasks remain invalid |
| Main lowering | Valid `main_mode` was missing from the allowed IR field inventory | Schema, lowering and routing now agree; arbitrary executor/access/approval edits still fail |
| Authoring submission | Semantic errors surfaced after closing/persisting the planner node | Native submit uses the same qualified compiler as replay/apply; exact field diagnostics reach the same model turn before persistence |

Raw submitted artifacts retain their identity. Normalization works on a copy,
records its field paths in compiler evidence, and never fills in missing task
meaning. Initial and stable-key repair schemas accept sparse empty collections.
Runtime dependency assessment, source coverage and exact Host contracts remain
explicit. Valid reviewer rejection is repair data, not a malformed submission.
Final publication still requires the human's exact reviewed proposal receipt.

Codex's finite closed-region scheduler, typed stop conditions, round histories,
failed-item-only repair, accepted sibling preservation and dependency re-review
remain the shared loop implementation. Main worker may inherit the initiating
model without inheriting its chat context. Loop bounds and final human acceptance
are different from model-selection or formatting preferences.

Evidence: compact/full plan equivalence and raw hash preservation; full shared
compiler preflight and valid negative review data; Main worker loop lowering;
real native SDK detached authoring corrects an invalid handoff in the same node
turn; standalone native SDK performs two review rounds with actual file repair.
All native evidence uses faux transport, isolated temporary state and zero paid
calls. No pi-own, Mode Pack or domain-specific callback is required.

Pi startup now invokes authoring template migration for existing templates only. Historical v29/v30 contracts upgrade to v31; selected Providers, prompt suffixes and user names/tags survive. Deleted templates are not recreated and existing Run pins are untouched.

## Compatible Host updates: 0.2.30

An implementation hash changes when program source changes, even if the tool's
interface remains unchanged. Pi previously treated this as an unavailable tool,
requiring an unrelated Workflow republication. Host admission and local/detached
execution now share `hostToolContractsCompatible`: a trusted registration's
explicit contract must retain the tool ID, implementation name, input/output
validation, argv, effects/permissions and execution policy. Build version/hash
and schema `description`, `title`, `examples` are not execution requirements.
Property names such as `description` and enum/const data remain meaningful.

The Workflow and Run pins remain unchanged. `broker.implementation_identity`
records the actual loaded program in each new execution receipt. Attestation
matches that actual implementation; the private bridge fences changes during an
owned attempt. Implementations without an explicit registered interface still
need their exact identity. Incompatible interfaces report a concrete error;
there is no extra review, score, model invocation or automatic rewrite.

Pre-creation binding failures now include exact Run/phase evidence. pi-own
classifies these and known historical pre-Run refusals as `refused`, retains
diagnostics and permits retrying the same request with a new intent. Confirmed
Runs and unknown transport failures never become retryable merely from absence.
The shared launch state applies to Course and Study; the course pane exposes
`重试此任务`, retaining selected sources and user requirements.

Evidence: an actual native SDK detached domain-only Run starts after changing
the registered implementation's version/hash, finishes once, records the new
implementation and retains the original published revision. Offline launch
tests cover refusal → retry → confirmation, legacy classification and unknown
transport/confirmed Run protection. No paid calls or user test assets.
