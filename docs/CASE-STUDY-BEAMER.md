# Course Builder: context isolation and Beamer generation

English | [简体中文](CASE-STUDY-BEAMER.zh-CN.md)

Recorded on 2026-10-03 using pi-own Course Builder and pi-CAW 0.2.30, with `grok-4.7` selected through Pi.

## Results in use

The original long chat handled coordination, material reading, source generation and compiler feedback together. Tool calls repeatedly carried the history and materials that had already been read.

The Workflow places generation in an isolated worker with only selected course materials, current requirements and the necessary revision baseline. Main workers inherit the initiating Pi chat's model and thinking level; repair nodes receive the exact source and compiler logs.

User feedback: context isolation solved repeated rereading of the long chat. The model focused better on the current task, developed more content, and improved Beamer organization and quality.

## Generation records

| Metric | Earlier chat generation | Workflow: initial draft | Workflow: draft and repair |
| --- | ---: | ---: | ---: |
| Model calls | 16 | 9 | 17 |
| Total output tokens, including reasoning | 13,321 | 34,203 | 49,231 |
| Reasoning tokens | 3,023 | 21,780 | 29,800 |
| Non-reasoning output tokens | 10,298 | 12,423 | 19,431 |
| Uncached input tokens | 375,124 | 56,648 | 156,042 |
| Cached input tokens | 5,304,960 | 288,256 | 675,200 |
| Model cost (USD) | 6.9653 | 0.4626 | 0.9451 |

The initial isolated draft produced **20.6% more** non-reasoning output at **93.4% lower** cost. Including one repair from compiler feedback, cost was **86.4% lower**. Substantially less context was carried through the calls, with more output devoted to the current task.

Non-reasoning output includes generated source and tool arguments. Costs come from model usage for the selected generation and repair steps.
