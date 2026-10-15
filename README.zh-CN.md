# 面向 Pi 的可复用、可追溯工作流

[English](README.md) | 简体中文

[![MIT Licensed](https://img.shields.io/badge/license-MIT-brightgreen.svg?style=flat-square)](LICENSE)

pi-CAW 0.6.0 将可重复的多步骤工作整理为 Pi 中可复用的 Workflow 和带日志的 Run。Workbench 让 Pi 用户创建、导入、配置并执行工作流，为步骤声明输入、资源和输出，使可复用的执行步骤聚焦于所需材料。

## 需求

- Node.js 22.19 或更新版本。
- 提供兼容接口的 Pi Host：`@earendil-works/pi-coding-agent` 1.0.0 或更新版本，以及 `@earendil-works/pi-ai`。

## 安装

在 Pi 中安装 GitHub 公开仓库：

```powershell
pi install git:github.com/TohmaN233/pi-CAW
```

从本地检出目录使用时，可通过 `pi -e ./extensions/pi-caw.ts` 仅在本次 Pi 启动中加载扩展；也可使用 `pi install .` 将本地包及其 Skill 安装到 Pi 设置中。

## 配置

在工作流的 **Models** 标签页，为其使用的每个子 Provider slot 选择 Pi 模型和受支持的 thinking level。导入的工作流使用各自独立的本地绑定；即使全局配置中存在同名 slot，导入后的绑定仍为空。模型认证和传输由 Pi 管理。

Main 没有独立模型绑定，会继承发起聊天的模型和 thinking level。默认的 `worker` 模式使用仅包含已声明输入和资源的新上下文。`orchestration` 模式继续当前聊天并使用 Pi 原生工具，需要 Cooperative 执行策略。

## 快速开始

在 Pi 中打开 Workbench：

```text
/caw
```

1. 任务说明选择 `system.build-workflow`，Skill 来源选择 `system.skill2workflow`，并提供所需输入。
2. 绑定所选 authoring Workflow 会使用的子 Provider slot，然后启动工作流。
3. 检查生成的 Draft，并通过人工审批步骤发布。
4. 选择 Ready Workflow，提供其工作目录、声明输入及读写授权，然后启动 Run。

## 功能

- 提供可复用的 Role 专注处理子任务，并通过可视化 Workbench 编辑工作流、选择模型和查看 Run。展开节点详情时才加载对应的执行消息。
- 随包提供两个 authoring Workflow：`system.build-workflow` 将任务说明整理为经过审阅的 Workflow Draft；`system.skill2workflow` 从 Skill 快照开始。Authoring 由 Host 编译和校验、独立审阅，并经过人工发布。
- 导入 `codex.workflow.package` 和 `pi-caw.workflow.package` 时保留源图、revision 和原始 package envelope。源完整性与本地启动就绪状态分别检查；不支持的依赖或能力、缺少的本地模型绑定都可能阻止 Run。
- 执行期间可通过工作流中声明的循环和 fan-out 校正进行语义返修。使用新会话独立审阅的循环设置有限的 `max_rounds`；明确限定、只读的当前聊天 Main 审阅可设为 `max_rounds: null`，并以接受作为停止条件。Fan-out worker 只校正尚未解决的条目，并在固定的 worker 尝试预算内保留已接受的同批条目。
- Authoring 有独立默认值：最多进行三次自动语义返修，之后等待用户引导继续。该预算与 Workflow 执行返修分开。
- 当前聊天 Main 的提交不合法时，会在固定轮次预算内于同一聊天中纠正，保留已暂存的结果与已完成的操作。底层执行故障保留错误，供后续诊断。

可选外部集合：[workflow-package](https://github.com/TohmaN233/workflow-package)。导入的每个 Workflow 仍须通过 pi-CAW 的兼容性、绑定和本地就绪检查；此链接不代表集合中的所有包都能在 Pi 中原样运行。

## 文档

- [可移植 Workflow 契约](docs/PORTABLE-WORKFLOWS.md)：package 导入、本地模型绑定和启动就绪状态。
- [Pi Host 接口](docs/HOST.md)、[SDK 运行时绑定](docs/SDK-RUNTIME.md)和[执行材料](docs/EXECUTION-MATERIALS.md)：集成方式与执行边界。
- [Run Inspector](docs/RUN-INSPECTOR.md)：查看执行记录。贡献者可参阅[功能对照](docs/PARITY.md)、[Authoring 对照](docs/AUTHORING-PARITY.md)和[迁移记录](docs/MIGRATION.md)中的兼容性与实现证据。
- [2026-10-03 Beamer 使用案例](docs/CASE-STUDY-BEAMER.zh-CN.md)记录了一项历史任务和用户反馈。它不是 0.6.0 的基准测试，也不代表普遍的节省幅度。

## 开发

安装项目依赖后，仓库提供以下检查命令：

```powershell
npm test
npm run check
npm run check:web
npm run audit:publication
```

## 来源与许可

pi-CAW 是 [Codex Agents Workflow](https://github.com/TohmaN233/codex-agents-workflow) 的独立 Pi 移植版本。出处见 [NOTICE](NOTICE)，MIT 许可见 [LICENSE](LICENSE)。
