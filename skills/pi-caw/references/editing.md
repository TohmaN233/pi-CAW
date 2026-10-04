Adapted from upstream 1.1.1 control-plane editing instructions; provenance is in
[upstream.json](../../../docs/upstream.json). `caw operation` means the tool call
`{action: "operation", args: {...}}`, as defined by the entrypoint.

## Strict, imports and editing

New task Workflows default to Cooperative with task-scoped bounded writes. Accepted
conversions deny implicit Skill access; an ordinary custom Cooperative node retains
only its explicitly configured Skill policy. Strict is an explicit executor-isolation choice, not the default
permission level.

Strict requires a qualified executor catalog, explicit Skill input and bounded tool
broker. It is not an OS filesystem ACL. Read `caw capabilities` for the currently qualified executor. Never
change a failed Strict request to Cooperative. Cooperative external/provider
executors may retain their host behavior only when a Workflow explicitly declares
it. Converted child Workflows never inherit ambient Skills; current-chat Main
retains its existing chat context and cannot be qualified as Strict isolation. Missing external tools, executables or scripts remain
requirements; do not execute imported scripts to infer their behavior.

Use `caw skill_inventory` for default Pi-folder import discovery; pass
`discovery: folders` and an optional absolute `folder` for a custom source. This
is not a list of executor-enabled Skills. Explicit `discovery: host` with a
workspace retains qualified host discovery. Preserve the discovery selection
when importing. Skill authoring uses editable skill2workflow classification rules
pinned to the authoring Run; configured eligible Providers are assigned per node
by the compiler, never inherited from the planner. Read `caw routing_defaults`
for current rules; shared defaults are edited in the workbench. Import only the selected
entry through `caw import_skill`; the result is a full-resource Draft with
visible provenance and unresolved dependencies. Never modify the original Skill.

Both Skill conversion and brief building identify environment dependencies in the
shared semantic plan. Required execution dependencies become portable
`requirements.executables`: program names or
`{name,version?,python_modules?}`. Keep workspace paths and installed executable
locations out of reusable definitions. Host step 0 validates registered local
locations, searches other installations, and reports missing dependencies before
execution. The Execution page's local dependency fields verify and persist those
locations outside Workflow exports. Invalidated locations use the same discovery
path before subsequent effects; installation always requires user consent.
Keep conditional dependencies at their source-defined phase and distinguish tools
the Workflow executes from dependencies used only by its output artifact. Preserve
project initialization that changes task files. Do not add a model node solely for
tool discovery or registration, or make optional artifact dependencies mandatory.
`caw source_status` reports changed SKILL.md hashes without changing any pins.
SkillRef requires exact path/name/hash and explicit nested pins. Inline creates a
new reviewable Draft; a new source version never silently updates an old Run.

There are two built-in authoring Workflow configurations. Read them with
`caw authoring_workflows`: `system.skill2workflow` snapshots a selected Skill,
while `system.build-workflow` snapshots an ordinary brief created with
`caw build_workflow`. After that input adapter they use the same semantic
planner, deterministic WorkflowForge compiler, review contract and publication
boundary. Do not pretend a from-scratch code-check or other brief is a Skill import.

`caw build_workflow` accepts `template_kind: workflow | role` (default:
`workflow`). Choose `role` only when the brief describes one reusable agent
behavior; set its read-only or bounded-write access and optionally pin a native
Provider. This path creates a reviewable Role Draft directly from the brief;
it does not claim to have run the multi-step semantic compiler. Choose
`workflow` for an end-to-end sequence; it retains the shared Skill-conversion
compiler and independent review contract. If the user did not state a kind,
decide from whether they want one agent behavior or a full task process.

The Workbench exposes the actual authoring compiler pipeline: pinned source snapshot,
planner-filled semantic inventory, Host graph assembly, Host execution/permission
binding, Host deterministic validation, independent semantic review, and human
publication. The Run stores bounded counts, hashes, bindings and validation results
for the Host stages. A planner or reviewer marked `read_only` cannot mutate the task
workspace; it still produces the structured semantic result consumed by the Host.

The planner output is the closed, compact `workflow-semantic-blueprint/v6` contract.
It fills only semantic activities, approvals, named sequence/parallel/choice groups,
data relationships, exact Host SourceContract selections, logical approval subjects,
bounded source-defined retry conditions, source dispositions, runtime dependency
decisions and requirement assignments. Bundled authoring v21 and later requests require
an explicit dependency array, including `[]`; older pinned v6 plans can omit it.
The v24 planner and reviewer assess useful responsibility boundaries: a durable
artifact path and identity or compact typed evidence can hand analysis to
implementation or verification in a fresh context. Related work stays together
when it has no stable handoff. Node count and source headings are not split rules;
review checks the explicit producer output and successor input.

Agent outputs contain only values the Agent creates through semantic work.
When downstream work needs unchanged fields from an earlier record, bind that
record separately and keep the Agent result ordered against it, or select an
exact registered Host tool for deterministic copying, transformation or join.
This ownership rule is field-name independent: titles, labels, names, source
text and metadata cannot be routed through an Agent merely because they are not
IDs or paths. The compiler rejects positive copy-through instructions and
Host-owned identity or location fields in Agent output contracts.
Activity instructions have a separate 10,000-character schema bound; short
descriptions retain their 2,000-character bound. After Host interface and retry
appendices, the generated node prompt must fit the 12,000-character proposal
limit. Oversize plans and repairs fail validation rather than losing their ends.
Each dependency names its portable executable, applicability, responsible activities
and exact pinned source evidence. Host validation derives spans and startup
requirements; the planner does not supply local executable addresses. An explicit
`host_preparation_observation_ids` list can assign source instructions for missing
tool discovery or installation consent to this Host lifecycle. The compiler checks
the exact clause and preserves its evidence; task-specific approvals remain
semantic gates, including when the source mixes both kinds on one line. It does not
choose a root. The Host owns all
nodes, edges, IDs, schemas, pointers, bindings, executor/provider fields, permissions,
retry fields, evidence spans and packaging. Static SourceContracts preserve exact
script argv and artifact constraints without executing source code. Nodes keep exact
disjoint evidence spans, and approval gates bind the current logical activity output.
Requirement assignments may name only
exact observed requirement IDs supplied by the Host. WorkflowForge
normalizes the semantic reference graph as a DAG: repeated choice bodies converge,
nested mutually exclusive exits remain exclusive, approval mappings retain only the
unique source-grounded gate and post-gate operations. Worker profiles compile to
one-off Provider sub-Agents; a durable Pi session is not inferred from an isolated
worker, fan-out, or project-memory artifact. Explicit `task_continues` lineage
is compiled only for direct one-to-one same-Provider worker successors; an
incompatible lineage receives a semantic diagnostic. The selected Provider
determines the actual model and remains editable on the compiled node.
Brief-built task Workflows
default to Cooperative with implicit Skill access denied. An imported source policy
is private conversion input, not a runtime entitlement; every accepted conversion is
deployed with implicit Skill access denied. Named
data types describe nested object/list interfaces while the Host generates JSON Schema
and rejects duplicate, cyclic or contradictory definitions. An activity that explicitly
cites a pinned executable resource must type each structured output through a named
type, and the Host binds that cited resource to the activity. Persisted v2/v3
blueprints are upgraded mechanically without consuming a planner repair. Authoring
uses one initial plan plus at most three automatic `workflow-semantic-repair/v1`
stable-key patches for genuine semantic omissions, contradictions, distortions or
misassignments. Each patch builds on the exact current plan and never regenerates the
whole plan. If findings remain after the third patch, the Host retains the plan and
findings and waits for explicit user guidance before another targeted patch.
Mechanical output/schema errors and reviewer protocol errors stop visibly and never
spend the semantic repair budget. Coverage failures carry the exact requirement ID,
semantic keys, editable fields, source spans and current mapping so a repair never has
to guess which stable keys to change.

Both authoring routes should use Host preparation for mechanical source extraction
and consistency checks. Hand consumers their assigned verified facts, complete
relevant rules and explicit decisions, retaining full packet references for deeper
reads. Do not require model-written hash literals or repeated raw-packet extraction.

For code analysis whose consumers need exact source locations, both authoring
routes may mark a compact output with
`host_validation: workspace_source_locations`. The Host compiles its shared
record schema and checks paths relative to the Run workspace or absolute paths
inside it, exact file hashes, existing inclusive line ranges and optional literal
symbol anchors. Empty `symbol` is valid when a line range and hash suffice;
descriptive labels belong in `usage`. Verified absolute paths are handed off as
relative paths. The hash identifies the file when analysis produced the
location. The Host rejects stale locations before a new consumer dispatch;
once dispatched, a writer may legitimately change that file without turning
the old analysis record into a current-file invariant. Keep the historical
record readable. A later activity that needs current locations after edits
uses updated locations produced by the writer. This does not add a model stage
or carry whole source files between nodes. Unmarked outputs remain compatible.

User-requested graph/resource edits use `caw read`, `caw save` and
`caw write_resource` under exact revision CAS. Publish the saved Draft with
`caw publish`; it validates graph and resource closure before
Ready and never starts a Run. Converted Drafts retain their original source,
proposal and requirement identity. Publication refreshes content hashes for the
edited graph and resources, records a direct editor-publication identity, and keeps
the historical review contract version, including v12. It does not claim a new AI
semantic review. Authoring uses separately selected, explicitly bound Pi planner and reviewer
Providers in `caw start_authoring`. The Host advances that exact Run in the
background; `caw advance_authoring` observes its progress and retained artifacts.
The Host routes it through the pinned planner, deterministic
compiler and fixed `authoring_reviewer`; it must not treat the authoring `final`
stage as a current-main packet or replace the reviewer with the controller model.
Stop at `review_required`; explicit human acceptance using the observed exact `proposal_sha256` precedes
`caw apply_authoring_result`. `caw accept_authoring` provides that publication
boundary. A saved closed reviewer result rejected only by changed Host checks may
be revalidated with `caw accept_rechecked_authoring_review`; it cannot fabricate
review or replay the planner. Journalled cleanup can be retried with
`caw purge_authoring_artifacts` after exact human authorization. Historical expansion operation names remain only
for persisted-client compatibility. Review dispatch, result, human acceptance and
Draft application must retain one exact proposal hash, source revision and planner
attempt ID. Generic completion and model-side Strict collection cannot accept an
authoring finalizer. The inferred graph still requires human review.
The host owns deterministic source anchors, typed requirement fields, graph-envelope
formatting and validation. A planner maps those stable IDs and supplies only semantic
decisions; echoed host fields are discarded and replaced by the canonical projection.
The shared planning/review packet includes the imported Draft's host-owned baseline
requirements and static import observations. Every selected supporting resource must
be reconciled against those facts before submission; neither planner nor reviewer
should rediscover or ask the proposal to echo them.
Automatic semantic correction is evidence-driven and bounded to three stable-key
repairs. Final review uses the pinned review packet plus the hashed dynamic
`__authoring__/review-proposal.json` resource; the full canonical proposal is never
inlined into the prompt or duplicated through stale repair feedback. When host projection or compiler rules change after a
planner proposal has completed, recheck that exact persisted artifact by verifying its
source Run, attempt, artifact hash and source revision; rerun deterministic compilation
and independent review without spending another planner call.
Every automatic semantic repair must name current stable semantic keys and editable
field families. Edge-only findings map to both endpoints. Unmappable feedback stops at
the Host as `semantic_diagnostic_error` instead of asking the planner to guess.
After changing conversion, projection, validation or review code, validate in this
order before any real Provider call: focused contract tests, affected cross-module
tests, offline validation of stored Workflow definitions, then deterministic preflight
of the exact persisted proposal. A Provider Run is acceptance evidence, never a way to
discover holes that these host checks could have found first.
Static relocation proves pinned resource access only, not functional portability.

Use `caw export_workflow_package` to create an installable, content-addressed
package for one immutable revision. When the user asks to import a local file, call
`caw install_workflow_package` with `package_path`; let the Host read the file
instead of copying its JSON through model context. Absolute paths work directly;
relative paths require the absolute `workspace` that contains them. HTTPS package
URLs are also supported. The installer verifies format/API compatibility,
Workflow schema, package digest, resource hashes, revision identity and the exact
Provider/tool/MCP/executable dependency manifest before atomic creation. Remote bytes
may be pinned with SHA-256. Installation never downloads dependencies or silently
substitutes local Providers; it preserves the package's exact pinned Workflow status.
The editor's full Pack snapshot is a diagnostic snapshot and
may include private conversion material, so it is not accepted by this portable
package installer.

The ordinary `caw create`, `caw save`, `caw write_resource`,
`caw publish`, and `caw delete` operations are available for explicit user
Workflow management requests. Publishing still runs the deterministic structure and
dependency checks; deletion uses the recoverable Pack trash path and exact revision CAS.



The Workflow inspector has **Repair loops** for bounded regions, stop conditions, feedback and item scope. See [loop contracts](loops.md). Loop IDs are renamed together with their exact binding references; prompts and literal input values are not rewritten.

## Semantic authoring validation

Unused empty collections and activity/output placeholders may be omitted; the Host records explicit empty-field normalization without changing raw artifact identity. Stable-key patches need only changed collections. Correct submit-time compiler diagnostics within the current node turn. A valid negative review remains repair feedback. Fresh Main worker can review a loop independently without switching Provider. Writes, current-chat orchestration and continued tasks cannot be loop review exits.
