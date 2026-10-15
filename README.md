# Reusable, traceable workflows for Pi

English | [简体中文](README.zh-CN.md)

[![MIT Licensed](https://img.shields.io/badge/license-MIT-brightgreen.svg?style=flat-square)](LICENSE)

pi-CAW 0.6.0 turns repeatable multi-step work into reusable Workflows and journaled Runs for Pi. Its Workbench lets Pi users create, import, configure and execute workflows with declared inputs, resources and outputs, keeping reusable steps focused on the material they need.

## Requirements

- Node.js 22.19 or newer.
- A Pi Host with compatible `@earendil-works/pi-coding-agent` (1.0.0 or newer) and `@earendil-works/pi-ai` interfaces.

## Installation

Install the public GitHub package in Pi:

```powershell
pi install git:github.com/TohmaN233/pi-CAW
```

From a local checkout, load the extension for one Pi launch with `pi -e ./extensions/pi-caw.ts`, or install the local package and its Skill into Pi settings with `pi install .`.

## Configuration

In a Workflow's **Models** tab, choose a Pi model and supported thinking level for each child Provider slot it uses. Imported Workflows keep their own local bindings, which start empty even when the same slot ID is configured globally. Pi manages provider authentication and model transport.

Main has no separate model binding: it inherits the initiating chat's model and thinking level. Its default `worker` mode uses a fresh context with declared inputs and resources. `orchestration` continues the current chat and uses native Pi tools; it requires Cooperative execution.

## Quick start

In Pi, open the Workbench:

```text
/caw
```

1. Choose `system.build-workflow` for a task brief or `system.skill2workflow` for a Skill source, then provide its required inputs.
2. Bind any child Provider slots the selected authoring Workflow uses, then start it.
3. Review the resulting Draft and publish it through the human approval step.
4. Select the Ready Workflow, provide its workspace, declared inputs and read/write authorization, then start a Run.

## What it does

- Provides reusable Roles for focused helpers and a visual Workbench for Workflow graphs, model choices and Run inspection. Execution messages load when you expand their node details.
- Ships two authoring Workflows: `system.build-workflow` turns a brief into a reviewed Workflow Draft; `system.skill2workflow` starts from a Skill snapshot. Host compilation and validation, independent review and human publication are part of authoring.
- Imports `codex.workflow.package` and `pi-caw.workflow.package` while preserving the source graph, revision and original package envelope. Source integrity and local launch readiness are checked separately; unsupported dependencies, capabilities or missing local model bindings can prevent a Run.
- Supports semantic repair through declared Workflow loops and fan-out correction. Fresh-review loops use a finite `max_rounds`; an explicitly qualified, read-only current-chat Main review can use `max_rounds: null` and stop on acceptance. Fan-out workers correct unresolved items while accepted siblings are preserved, within the pinned worker-attempt budget.
- Gives authoring its own default of up to three automatic semantic repairs before it waits for user-guided continuation. This authoring budget is separate from Workflow execution repair.
- Corrects invalid current-chat Main submissions in the same chat within the pinned turn budget, retaining staged results and completed effects. Mechanical failures remain visible for diagnosis.

Optional external collection: [workflow-package](https://github.com/TohmaN233/workflow-package). Each imported Workflow still needs to pass pi-CAW's compatibility, binding and local-readiness checks; this link does not imply that every package runs unchanged in Pi.

## Documentation

- [Portable Workflow contracts](docs/PORTABLE-WORKFLOWS.md) cover package import, local model bindings and launch readiness.
- [Pi Host interface](docs/HOST.md), [SDK runtime bindings](docs/SDK-RUNTIME.md) and [execution materials](docs/EXECUTION-MATERIALS.md) describe integration and execution boundaries.
- [Run Inspector](docs/RUN-INSPECTOR.md) explains how to inspect execution records. Contributors can consult [Parity](docs/PARITY.md), [Authoring parity](docs/AUTHORING-PARITY.md) and [Migration](docs/MIGRATION.md) for compatibility and implementation evidence.
- The [2026-10-03 Beamer case study](docs/CASE-STUDY-BEAMER.md) records one historical workload and user feedback. It is not a 0.6.0 benchmark or a general savings estimate.

## Development

With the project dependencies installed, the repository defines these checks:

```powershell
npm test
npm run check
npm run check:web
npm run audit:publication
```

## Attribution and license

pi-CAW is an independent Pi adaptation of [Codex Agents Workflow](https://github.com/TohmaN233/codex-agents-workflow). See [NOTICE](NOTICE) for attribution and [LICENSE](LICENSE) for the MIT license.
