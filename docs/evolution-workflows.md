# Local Workflow evolution evaluation

pi-own owns learning, accumulated evidence and strategy selection. CAW's separate
Workflow layer captures a proposed graph/resource change, runs a bounded paired
suite through the real `PiCawService`, scores exact outputs, and lets an explicitly
authorized human adopt a qualified change as a **Draft**. This runner does not
install or restart pi-own, publish a Workflow, or change a running Host.

`lib/evolution-evaluation.mjs` exports `WorkflowEvolution` and a local CLI. It is
deliberately not a model tool. There is no callback that can replace service-owned
Runs with a claimed successful execution.

## Offline example with the actual Pi SDK

From the repository root, use the installed Pi SDK and its native faux model:

```powershell
node examples/evolution-offline.mjs prepare
node lib/evolution-evaluation.mjs capture examples/evolution-offline.mjs .test-tmp/evolution-offline/capture.json
```

Capture prints a `candidate_id`. Put that ID in
`.test-tmp/evolution-offline/evaluate.json`:

```json
{"candidate_id":"<candidate SHA-256>"}
```

```powershell
node lib/evolution-evaluation.mjs evaluate examples/evolution-offline.mjs .test-tmp/evolution-offline/evaluate.json
```

The baseline prompt returns `old`; the candidate prompt returns `new`. Both run
through real SDK sessions, submission tools, execution owners and CAW journals.
The suite expects `new`, so the printed receipt records baseline 0/1 and candidate
1/1. No paid model or network model call is involved.

Inspect the printed `evaluation_id`, scores and referenced private Run/session
files. To adopt that exact reviewed result, create
`.test-tmp/evolution-offline/adopt.json`:

```json
{"evaluation_id":"<evaluation SHA-256>"}
```

```powershell
node lib/evolution-evaluation.mjs adopt examples/evolution-offline.mjs .test-tmp/evolution-offline/adopt.json --human-authorized
```

The last flag represents the human caller's explicit adoption authorization. A
model-supplied evidence note does not supply that authority. Adoption creates a
Draft through the existing store's revision CAS. The original Ready revision and
its resources remain readable. Existing Runs retain their old pins. Repeating
adoption after the head changes fails with `REVISION_CONFLICT`.

Set `PI_CAW_EVOLUTION_HOME` to use another private example directory. Each example
Host and trial has its own state, workspace, parent session and worker sessions.

## Candidate and suite packets

Capture requires an exact Ready baseline revision, the full proposed Workflow,
an optional complete resource map, a causal explanation, supplied evidence
references, and a suite. Omitted resources retain the baseline root's bytes.
Capture writes only a content-addressed private candidate record. Its evidence
references are supplied proposal provenance, not a verified human decision or an
automatic quality verdict.

```json
{
  "workflow_id":"example",
  "expected_revision":"<Ready revision SHA-256>",
  "workflow": {"id":"example","status":"draft","...":"full Workflow graph"},
  "cause":"The registered fixture exposes an incorrect final value.",
  "evidence_refs":[{"source_ref":"pi-caw://runs/.../terminal/...","sha256":"<exact evidence digest>"}],
  "suite":{
    "id":"exact-output-v1",
    "repetitions":2,
    "trial_timeout_ms":120000,
    "samples":[{
      "id":"one",
      "inputs":{"task":"Produce the declared value."},
      "files":{"input.txt":"The same initial UTF-8 bytes for both trials."},
      "assertions":[{"pointer":"/text","equals":"new"}]
    }]
  }
}
```

The scorer supports exact JSON Pointer equality, including the empty pointer for
the entire final value. Missing values fail. Every sample must have assertions;
there are no model judges or inferred scores. Limits are 1–32 samples, 1–5
repetitions, and 1–128 assertions per sample. Every trial has a frozen deadline
(default two minutes, maximum one hour); unbounded Workflow loops are rejected.
The runner executes one candidate against one baseline, serially, with at most
320 real Runs. Repetition measures only these declared objective checks; it does
not establish general quality or statistical superiority.

Qualification requires all candidate assertions to pass, no paired assertion to
regress, and at least one assertion to improve. Negative and regression results
are retained as scored evaluation receipts. Missing, corrupt, unsettled or
incomplete execution evidence fails visibly and retains a failure record and
the private execution material.

Normal agent finalizers stop at their settled final proposal. Receipts label this
`awaiting_human_acceptance`; the evaluator never forges final human acceptance.
Deterministic Host finalizers use their exact successful tool output receipt and
completion hash. Midrun human gates remain incomplete and cannot qualify.

## Production Host adapters

A trusted local adapter exports `createEvolutionContext()` and returns:

```javascript
{
  sourceService, // initialized PiCawService for the authorized source library
  directory,     // private evaluation root, separate from source Host storage
  createHost,    // async ({directory, workspace, main}) => a new private Host
  implementationIdentity: {
    sdk_files: [/* exact absolute SDK/backend implementation file paths */],
    host_files: [/* exact absolute adapter/broker implementation file paths */]
  }
}
```

Each `createHost` invocation must construct a distinct Host and parent session for
the supplied private workspace, with the captured inherited Main model. Use real
SDK/backend implementations. The offline adapter shows the full lifecycle.
Replace only its faux backend when evaluating an explicitly authorized production
model. A production model suite consumes its normal provider budget.

The runner reads and hashes actual implementation files and registered tool
functions, rather than trusting a caller's claimed implementation hash. The
adapter manifest must cover the actual installed SDK, model backend and custom
Host implementations; an export-only SDK entry file is insufficient. Treat
mutable adapter closure state as part of the trusted adapter contract. The
offline example supplies a bounded explicit execution-module manifest for its
installed SDK layout. A different SDK layout must provide its own exact paths.
This is an explicit implementation contract, not a hermetic proof of every
runtime dependency. The runner reads only declared implementation paths; it does
not recursively scan SDK packages, the source tree or task workspaces.

Workflow-local Provider slots must already be explicitly bound. Global Provider
fallback is rejected. The candidate must retain the baseline's Provider slots;
the runner preserves the source closure, resource bytes, conversion identity and
certificates in private stores. Each private candidate becomes Ready only in its
own store to exercise normal runtime validation/preflight. The source Ready head
is untouched until human Draft adoption. Main's actual model/fingerprint and
thinking level are checked at each task dispatch and against the retained
isolated Main receipt. Source settings, local bindings and implementation drift
invalidate evaluation/adoption.

The current closure boundary allows one exact revision per Workflow identity.
Candidate references must resolve within that captured closure. A candidate that
adds a new external subworkflow revision requires a new qualified capture path;
it cannot silently resolve a newer source head.

Candidate/evaluation/failure JSON records are content addressed and written
exclusively. They live beside retained private Run stores, not in the source
Workflow library. Human adoption reloads the exact candidate and evaluation,
strictly reads the actual Run journals/pins/final bytes, recomputes scores and
qualification, and then executes the existing atomic Draft-save CAS. Local
content hashes detect mutation; this is not a signature system against an actor
who can rewrite the implementation and all private storage.
