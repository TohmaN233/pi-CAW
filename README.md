# pi-CAW

English | [简体中文](README.zh-CN.md)

An independent Pi Agents Workflow plugin, adapted from Codex Agents Workflow 1.1.1 with Main worker/orchestration modes and Host-controlled bounded loops. Current package version: **0.3.0**. The Host adapter targets Pi SDK 1.0 and reads the actual SDK version from the running Host.

## Origin and purpose

pi-CAW is a separate adaptation of [TohmaN233/codex-agents-workflow](https://github.com/TohmaN233/codex-agents-workflow). It preserves reusable Workflow graphs, the Workbench, Roles, authoring, execution records and human acceptance, while adapting models, sessions, tools and Host integration to Pi. The original project remains independently maintained. Imported revisions are recorded in [upstream.json](docs/upstream.json); the original MIT license is retained in [LICENSE](LICENSE), with attribution in [NOTICE](NOTICE).

Long chats repeatedly carry history through tool calls and revisit materials that have already been read. Workflows split execution into nodes with explicit inputs, resources and outputs. The default Main worker inherits the initiating Pi chat's model and thinking level, then works in an isolated context. The Host passes exact results and executes deterministic tools.

### In use: course Beamer generation

In pi-own's Course Builder, task context isolation solved the repeated inclusion of the entire long chat during generation. As of **2026-10-03**, the user's feedback was that the model focused better on the selected course materials and teaching requirements, produced more developed content, and improved Beamer organization and quality.

Both records used `grok-4.7` through Pi. Costs below cover model usage for the selected generation steps, excluding other tasks, Host tools and compilation.

| Record | Model calls | Non-reasoning output tokens | Uncached input tokens | Cached input tokens | Model cost (USD) |
| --- | ---: | ---: | ---: | ---: | ---: |
| Earlier Beamer generation in the chat | 16 | 10,298 | 375,124 | 5,304,960 | 6.9653 |
| Workflow: initial isolated draft | 9 | 12,423 | 56,648 | 288,256 | 0.4626 |
| Workflow: draft plus one repair from compiler feedback | 17 | 19,431 | 156,042 | 675,200 | 0.9451 |

The initial draft produced about **21% more** non-reasoning output at **93% lower** model cost. Including the repair, cost was still about **86% lower**. The complete draft and repair took 17 calls, with substantially less context carried through them.

See the [Beamer use case](docs/CASE-STUDY-BEAMER.md).

## Recent capabilities

**0.2.27: bounded repair loops.** Add a repair loop in the Workflow inspector, selecting a closed DAG region, a read-only review exit, a finite round limit and an exit condition. The canvas shows the region; Runs show each round's state and feedback. Item mode repairs only failed items and reviews affected accepted items when their files or shared dependencies change. Exhausting the limit fails explicitly. Final human acceptance stays outside the loop. Authoring compiles repeated review required by the source into loops without adding score thresholds. See [Loops](docs/LOOPS.md).

**0.2.28:** optional empty semantic fields, isolated Main workers for repair review, and compiler diagnostics returned within the same node submission. Write scopes, loop limits and final human acceptance remain enforced. See [Validation](docs/VALIDATION.md).

**0.2.29:** expandable Workflow cards in the chat, showing node progress, execution models, actual tasks, tool calls, replies, loop attempts and execution sessions. The portable read-only `inspect_run` API loads details on demand; collapsing a card stops refreshes without adding model calls. See [Run Inspector](docs/RUN-INSPECTOR.md).

**0.2.30:** Host implementation fingerprints are separate from tool interfaces. A program update with an unchanged interface can run an existing Workflow without rebinding or republishing it. Receipts record the actual implementation identity; tasks, results and historical pins stay intact. Input types, operations and write-scope conflicts still block execution. See [Compatible updates](docs/VALIDATION.md#compatible-host-updates-0230).

## Main and model selection

**Logical Main inherits the initiating Pi chat's model and thinking level at dispatch.** Each Main node has two execution modes:

- `worker` (default): a fresh context containing only declared inputs and resources.
- `orchestration`: the current chat, using native Pi tools and coordinating helpers; requires Cooperative policy.

Main needs no separate model binding. Child nodes require explicit model and thinking selections. Pi manages authentication, model transport and native MCP.

Select the mode in the node editor, or propose per-Run choices through `run.main_modes`, keyed by root node ID, such as `{focused:"worker", final:"orchestration"}`. The Host validates and pins them before Run creation without changing the shared Workflow. Historical Runs retain their saved `main_context`. Authoring profiles `main_read/main_write` select Main workers; `orchestration_read/orchestration_write` select the current chat. Independent helpers using `worker_*` profiles use their bound Providers.

First initialization retains **seven portable Roles, two Host authoring Workflows, four logical Provider slots and generation routing**. Child model bindings start empty, with no preset or automatic selection of the first available model. Upgrades preserve user edits and deleted defaults. The removed fixed implementation/review composite is excluded from installed defaults.

## Installation and first use

Requires Node.js 22.19 or newer and a Pi Host providing compatible `@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai` interfaces.

SDK loading supports distribution and TypeScript source layouts. It identifies the active SDK/AI entries, keeps native MCP modules in the same tree, and carries those bindings into detached workers. Hosts can explicitly bind relocated modules and loader hooks. See [SDK runtime bindings](docs/SDK-RUNTIME.md).

```powershell
# Install from GitHub
pi install git:github.com/TohmaN233/pi-CAW

# From a local checkout: load the extension for this Pi launch
pi -e ./extensions/pi-caw.ts

# Or install the local package, including its Skill, into Pi settings
pi install .
```

Native Pi works without pi-own, Next.js, Mode Packs or course tools. pi-own supplies optional Host events for course capabilities and mode preferences. Without an adapter, the plugin uses the generic Workflow library and global switches. The package Skill in `skills/pi-caw/` defines automatic routing and Role selection for ordinary tasks.

Run `/caw` in Pi to open the session's loopback Workbench. Keep its access token within the session. The React/React Flow Workbench includes the canvas, node inspector, resource editor, history, import, authoring, execution, dependencies, cache and integration panels. Models are selected from Pi's provider/model/thinking catalog.

1. Bind the needed logical Provider slots to actual Pi models and supported thinking levels. Main has no such binding.
2. Review the default Roles and Workflows and configure the capabilities needed for the task. Roles or the task's own workflow arrange independent review.
3. Select a Ready Workflow and provide the workspace, declared inputs and read/write authorization. Use `inputs_path` for structured local inputs read by the Host.
4. Runs execute in the background. Pi sends completion or attention notifications. Main uses `caw` Main operations when it receives `PI_CAW_MAIN` to read grants/resources and submit semantic results.
5. Review approvals or final proposals in the Workbench and accept the exact displayed SHA-256. Authoring publication also verifies the source revision and independent reviewer result.

Workflow modes supply default preferences. All installed normal Workflows remain selectable in every mode. Optional Host preference hooks use per-session CAS; standalone Pi offers global switches. The library groups enabled and disabled entries. Switches preserve Draft status and existing Run pins, while actual capabilities enforce tool, task and source authority.

## Shipped defaults

| Role | Purpose |
| --- | --- |
| Bounded code change | Complete implementation within fixed interfaces and explicit file ownership |
| Heavy bounded change | Bounded implementation requiring more local judgment |
| Cross-review | Independent review of implementation and verification evidence |
| Review and repair | Review and repair within the authorized scope |
| Bounded brainstorm | Bounded exploration of alternatives |
| Repository analysis | Codebase analysis with traceable conclusions |
| Hard problem solver | Analysis and resolution of difficult problems |

GPT-specific web-review slots and reviewers are excluded. Roles retain prompts, direct instructions, descriptions, tags, access, enabled state and provenance. Builtin Role customizations retain the builtin identity; Drafts affect execution only after publication.

| Workflow | Behavior |
| --- | --- |
| `system.skill2workflow` | Full Skill snapshot → semantic planner → Host compiler → independent review → human publication |
| `system.build-workflow` | Brief snapshot, followed by the same authoring contract |

`pi-worker`, `pi-reviewer`, `pi-specialist` and `pi-cross-review` are logical slots with empty model bindings. Shared generation routing is template configuration; saving it preserves independently edited authoring planners, reviewers and repair budgets.

## Execution and records

| Object | Pi execution |
| --- | --- |
| Main | Current or isolated context; inherits the original chat model; verifies the session, dispatch, result tool call and completed turn |
| Provider / Role | Explicitly bound native Pi child session with the task and pinned resources |
| thread | `start` creates a persistent session; `continue` verifies and resumes the declared upstream session and binding |
| fan-out | Host allocates inputs, bounds concurrency and merges results in deterministic order; item delivery retains accepted items |
| SubWorkflow | Pins child revision and parent/child identity; parent collects successful outputs after child acceptance |
| deterministic tool | Executes the exact registered contract and records inputs, outputs, program and file effects |

Runs retain immutable pins, a hash-chained journal, dispatch intents/receipts, result proposals, session/turn evidence and a cost ledger. Models submit new semantic values only. The Host binds original records, paths, hashes, locations, leases and receipts. Missing billing data is recorded as unknown.

By default, an independent Node owner process receives exact Host bootstrap over IPC and retains authorized child work when the Pi Host closes. Main remains bound to the original Pi chat: if its bridge is unavailable, execution waits at `waiting_parent`; reconnection verifies the same actor. Owners observe journal authority, publish heartbeats and persist terminal records, confirming shutdown after all session/program effects settle.

Declarative Pi Providers can run under detached owners. Function-based native Providers require an explicitly trusted local provider module for transfer; untransferable bindings fail before dispatch. An explicit `detached_host: false` selects execution within the same Host. Execution mode and models never change automatically. Private bridge/RPC tokens and bootstrap credentials stay outside model output and public worker state.

Cooperative execution uses native Pi file tools and Host-discovered shell/Node programs. The shared broker records arguments, working directories, output, cancellation and file effects. Strict Main and child execution use scoped workspace/input/resource brokers with ambient Skills and context files disabled. Each isolated Main node has its own actual Pi JSONL and completion evidence.

Native MCP uses Pi's configured server names, exposure and authentication. Cooperative children may inherit the enabled catalog; Strict children use a declared subset. Missing servers, hidden tools, connection failures and required OAuth login fail visibly. The parent Pi session handles configuration and login through `/mcp`.

Read-only branches can run concurrently. Parallel writes use Git worktrees, Strict branches, Join integration proposals, full patch review, exact-hash acceptance and cleanup. Offline fixtures verify two Strict writers with real Git, human integration and cleanup. Programs run locally by default; an explicitly configured and verified WSL binding can be supplied through `constraints.execution_binding`. See [Host](docs/HOST.md) and [Parity](docs/PARITY.md).

## Management and recovery

Graph and resource edits use revision CAS. Publication validates structure and dependencies without starting a Run; deletion moves Packs into recoverable trash. Skill import retains full resources, provenance and pending questions. Converted Workflows own their assets and run without rereading the original Skill or private conversion history.

Portable packages can be installed from local files or HTTPS URLs. Installation verifies the original digest, object hashes, revision, schema and dependencies before atomic creation. Generic upstream envelopes retain their digest and immutable snapshot. Full Pack exports are diagnostic snapshots that may contain private source materials; they are separate from installable portable packages.

Pause stops new releases. Cancel revokes authority and waits for known executors to settle. Uncertain dispatches are never automatically replayed. Recovery uses the exact Run/attempt, closure evidence, original child identity and a new lease. Durable, closed successful results can be collected without another model call. Workbench adoption or `recover_control` authorized by an actual user message fences the old Run tree's authority without approving or completing nodes.

Adoption applies CAS and authority fencing at the observed sequence, then awaits exact old-owner shutdown. Cleanup errors are persisted and block resume. Confirmed recovery archives the old generation's evidence. Uncertain startup, abort or closure retains the original owner and interrupted attempt. Switching chats revokes new execution by the old Main while allowing exact old-task cleanup without aborting the new chat.

Cache cleanup starts with a preview and applies the exact plan hash to revisions/resource objects unreferenced by current versions, Run pins or transitive source chains, retaining a durable audit. Authoring's private-data cleanup is a separate retryable transaction that preserves caller-owned workspaces.

## Verification

```powershell
npm run check
npm run audit:publication
npm test
npm run check:web
npm run smoke:native
```

Smoke scripts resolve the project's Pi SDK peer dependency directly. The real SDK and extension loader use a faux Provider in isolated state to verify worker/orchestration modes, the current chat, native shell/file tools and offline MCP, with zero paid model calls. Evidence is stored in the ignored `.artifacts/` directory. Verification coverage, including detached owners, the original chat bridge and exact recovery, is recorded in [Parity](docs/PARITY.md). Strict execution is an application boundary; paid models, user OAuth, multiple Hosts and WSL require their own runtime verification.

Codex execution interfaces use Pi-native session/tool adapters. Cursor/Grok remote connectors are excluded in favor of Pi's model import. GPT-specific ChatGPT web reviewers and direct OpenAI advisory transport are excluded.

More details: [Migration](docs/MIGRATION.md), [Host interface](docs/HOST.md), [Parity](docs/PARITY.md), and [Authoring parity](docs/AUTHORING-PARITY.md).
