# Portable Workflow contracts (0.4.1)

Pi accepts `codex.workflow.package` and `pi-caw.workflow.package`, format/API/schema version 1. Envelope compatibility does not guarantee that every Host can execute every graph. Import validates source integrity, stores the original package and exposes local validation separately. Unsupported schema, capability, model or dependency requirements must remain visible.

## Source and local configuration

Stored-revision inspection and source Role admission validate the exact requested revision and its local bindings. Package installation responses remain pinned to the revision committed by that request even if another update changes the head before response inspection.

The immutable snapshot retains Provider IDs, graph, provenance/certificate and exact resource bytes. `installations/<source-revision>/source-package.json` preserves the original envelope and digest; adjacent `installation.json` records its local source/version/digest/time. Adjacent `local-bindings.json` is receiving-Host configuration, initially null for every referenced Provider slot, even if a same-named global Provider exists. Readers use the requested revision's records first and support legacy root records. Model and thinking choices use the active Pi catalog with fingerprint checks. Main has no independent binding.

Human Workbench operations `workflow_bindings` and `save_workflow_bindings` use both the exact Workflow revision and local-config hash. Graph revision changes invalidate existing local selections. Global settings and other Workflows are unaffected. Runs pin `workflow_providers` and `workflow_binding_revisions`; historical Runs without those fields retain their original global Provider pins. Different Workflows may reuse the same source slot ID without collision. Conflicting revisions of one Workflow in one closure fail explicitly.

Unchanged imports export the retained original package. Graph edits or an explicit new package version produce a Pi package. Local bindings are never exported. Full Pack diagnostic snapshots remain distinct from installable packages. A Pi-created or edited package is not claimed to be accepted by an unchanged CAW importer.

## Updating an installed package

`install_workflow_package` accepts `expected_revision`, the previously read exact current-head SHA-256. The core helper has the same option: `installWorkflowPackage(store, bundle, { source, expected_revision })`. Omitting it retains create-only behavior and an existing ID fails with `WORKFLOW_EXISTS`. An update verifies package identity/digest/resources, the current stored resources and source envelope, and exact head CAS before committing. A stale head fails with `REVISION_CONFLICT`; a same or already retained source revision fails with `WORKFLOW_PACKAGE_REVISION_EXISTS`, preserving human bindings.

An update keeps the Pack, all prior immutable revisions/objects and historical Run pins. It retains the incoming original revision number/hash and never renumbers or rewrites the source graph. New revision records and resource objects are staged before one atomic `workflow.json` replacement. Source/installation records stay with their revision; new child model slots start empty. It imports no model selections or global settings. Reads and exports of an old revision still retrieve that exact original package and its local bindings.

The head-only `workflow_local_bindings:true` marker is outside the immutable source hash. It commits with the head and survives local graph saves, keeping an edited imported Workflow in local-binding scope while its new revision awaits explicit human selection. This avoids inferring scope from uncommitted staged records. Legacy root metadata/bindings remain intact during updates, so an interruption before head replacement leaves the old head usable. Uncommitted records may remain for inspection; retries that encounter an already staged target revision reject explicitly instead of resetting bindings. Windows file fsync and atomic rename provide process-crash consistency; power-loss durability is not claimed.

## Authoring

Skill2Workflow and Build Workflow use v32 templates with concise current prompts and preserved historical prompt bases for migration. Updates preserve selected Providers, custom prompt suffixes, names/tags and user-deleted templates. Both paths retain exact schema resources, optional projections, semantic coalesce, retained replay, review facts, source spans, domain finalizer contracts and human publication.

Callable inventory records the original script/tool interface, literal arguments, stdin/file behavior and conditional dependency trigger. Resource classification is occurrence-based: a historical mention cannot suppress a later runtime requirement. Reconciliation keeps unresolved and opaque diagnostics until evidence resolves them. Mixed Host and semantic review findings stop at the Host boundary before spending a semantic repair attempt.

`authoring_preview` and `authoring_discover` read retained state without advancing scheduling, changing journals or calling models. Proposal/artifact hashes and attempt IDs identify the preview selected for acceptance. They are separate from `authoring_prompt_preview`.

## Execution boundaries

- Node-scoped executable dependencies are checked when their branch activates; skipped branches do not impose startup requirements.
- Main worker and orchestration completion checks run through pinned Host tool contracts. Intent precedes effects, receipt precedes acceptance, and unresolved intent blocks replay. Corrections and text amendments are bounded and retain their original scope.
- Main worker `one_per_item` fan-out can use each item's workspace and destinations. Shared-prefix declarations project common inputs/resources into isolated item sessions; Pi does not claim upstream transport cache reuse. Directory isolation with partition distribution remains unsupported and fails before a Run starts.
- Explicit `current_main` loops admit a read-only Cooperative Main orchestration reviewer and explicit `max_rounds:null`. Existing fresh-review loops retain finite limits and independent review. Final publication and required human gates remain unchanged.

## Evidence

Regression suites: `workflow-portability.test.mjs`, `portable-runtime.test.mjs`, `authoring-upgrade-source.test.mjs`, `authoring-upgrade-contracts.test.mjs`, existing service/authoring/recovery suites and frontend presentation tests. They exercise synthetic sources and offline providers; they do not establish paid model quality, live OAuth, every external program branch or all Host versions. Native SDK smoke provides separate session/transport evidence.

Metadata-only library reads avoid decoding resource objects. Full reads verify each unique object once and expose bounded scan counts/bytes/timing; corruption reports the Workflow and exact revision and fails visibly. No cross-request resource cache can hide changed bytes.

The Host integration also checks uncached plugin loads against one shared store. Same-process writers queue by canonical root, recursive acquisition rejects promptly, and on-disk locks retain authority for other processes and interrupted transactions. Thrown falsy values and compound cleanup failures remain observable.
