# pi-CAW

[English](README.md) | 简体中文

独立的 Pi Agents Workflow 插件，迁移基线为 Codex Agents Workflow 1.1.1，并吸收其最新 Main worker/orchestration 和 Host 有界循环设计。当前版本为 **0.3.1**，Host 适配基线为 Pi SDK 1.0；包版本以 manifest 为准，运行时 SDK 版本从实际 Host 读取。

## 出处与用途

pi-CAW 由 [TohmaN233/codex-agents-workflow](https://github.com/TohmaN233/codex-agents-workflow) 独立移植而来，保留可复用的 Workflow 图、Workbench、Roles、authoring、运行证据与人工验收，并将模型、session、工具与 Host 集成适配到 Pi。原项目继续独立维护。导入 commit 和后续来源记录在 [upstream.json](docs/upstream.json)；原 MIT 授权保留在 [LICENSE](LICENSE)，出处说明见 [NOTICE](NOTICE)。

这个插件首先用于解决长对话中的执行问题：多轮工具调用反复携带历史、重新定位已经读过的材料，生成任务的注意力也容易被无关上下文分散。Workflow 将任务拆成有明确输入、资源与输出的节点；默认 Main worker 沿用发起聊天的模型和 thinking，在独立上下文中完成该节点，Host 则负责传递准确结果与调用确定性工具。

### 实际使用：课程 Beamer 生成

截至 **2026-10-03**，在 pi-own 的 Course Builder 实际使用中，任务级上下文隔离解决了生成步骤反复带入整段长对话的问题。作者的使用感受是：模型更专注于当前课程素材和教学要求，内容展开更多，Beamer 的组织与质量也更好。

同为通过 Pi 接入的 `grok-4.7`，历史聊天生成与这次隔离写稿的记录对比如下。费用只统计选定生成步骤的模型 usage，不计其他任务、Host 工具和编译。

| 记录 | 模型调用 | 非推理输出 token | 未缓存输入 token | 缓存输入 token | 模型费用（USD） |
| --- | ---: | ---: | ---: | ---: | ---: |
| 历史聊天生成 Beamer | 16 | 10,298 | 375,124 | 5,304,960 | 6.9653 |
| Workflow 首次隔离写稿 | 9 | 12,423 | 56,648 | 288,256 | 0.4626 |
| Workflow 写稿与一次编译反馈修复合计 | 17 | 19,431 | 156,042 | 675,200 | 0.9451 |

首次写稿的非推理输出约多 **21%**，模型费用约少 **93%**；把修复算进去，费用仍约少 **86%**。修复后共 17 次调用，上下文携带量明显下降。

详见 [Beamer 使用案例](docs/CASE-STUDY-BEAMER.zh-CN.md)。

**0.2.27 支持有界返修循环。** 在 Workflow 编辑器的「工作流」检查器中添加「返修循环」，选择闭合 DAG 区域、只读审阅出口、有限轮数和结束条件；画布显示区域，Run 显示逐轮状态与反馈。逐项模式只返修失败项，已接受文件或共同依赖改变时重新审阅受影响项。达到上限仍未通过会明确失败，最终人工验收在循环之外。生成器会把来源明确要求的反复审阅编译为循环，不额外引入评分门槛。详见 [循环契约](docs/LOOPS.md)。

0.2.28 放宽无意义的空字段要求，返修审阅可使用隔离的 Main worker；生成器的编译错误会在同一节点提交时反馈。写入范围、循环上限与最终人工验收保留。详见 [校验审阅](docs/VALIDATION.md)。

0.2.29 提供会话内 Workflow 可展开卡片：节点进度、执行模型、实际任务、工具调用与回复、循环尝试和多执行会话。使用可移植的只读 `inspect_run` 接口按需读取，收起即停止刷新，不增加模型调用。详见 [执行记录接口](docs/RUN-INSPECTOR.md)。

0.2.30 将 Host 程序指纹与工具接口分开：更新程序而接口不变时，原 Workflow 直接运行，无需重新绑定或发布。收据记录实际程序身份，任务、结果和历史 pins 保持原样。真正的输入类型、操作和写入范围冲突才阻止执行。详见 [兼容升级](docs/VALIDATION.md#compatible-host-updates-0230)。

**逻辑 Main 继承发起 Run 的 Pi 聊天在 dispatch 时的模型与 thinking。** 每个 Main 节点有两种执行方式：`worker`（默认）使用独立上下文，仅载入声明的输入与资源；`orchestration` 继续当前聊天，使用 Pi 原生工具并协调 helpers，需要 Cooperative 策略。无需配置另一个 Main 模型。子节点的模型和 thinking 必须显式选择，Pi 管理认证、模型传输和原生 MCP。

节点编辑器可直接选择这两种方式。发起 Agent 也能在 `run` 的 `main_modes` 中按根节点 ID 提出本次选择，例如 `{focused:"worker", final:"orchestration"}`；Host 在创建 Run 前检查并固定选择，不更改共享 Workflow。旧 Run 继续使用已保存的 `main_context`，升级不改变其执行方式。生成器的 `main_read/main_write` 对应 Main worker，`orchestration_read/orchestration_write` 对应当前聊天；独立 helper 的 `worker_*` profile 仍使用绑定的 Provider。

首次初始化保留原版 **7 个通用 Roles、2 个 Host 生成 Workflows、4 个逻辑 Provider slots 和生成路由**；清空的是模型绑定。不会默认选择 GPT、其他模型或第一个可用模型。已有配置升级保留用户编辑，删除过的默认项不会被自动恢复。用户已删除的固定实施/审阅组合不随仓库旧模板重新安装。

## 加载与首次使用

需要提供 `@earendil-works/pi-coding-agent`、`@earendil-works/pi-ai` 兼容接口的 Pi Host，以及 Node.js 22.19 或更新版本。在本仓库目录中：

SDK 加载支持发行包和 TypeScript 源码布局，校验当前 SDK/AI 入口，让原生 MCP 模块来自同一份目录，并将绑定传入 detached 子进程。特殊 Host 可显式绑定重定位的模块和加载器。详见 [SDK 运行时绑定](docs/SDK-RUNTIME.md)。

```powershell
# 只为本次 Pi 启动加载扩展
pi -e ./extensions/pi-caw.ts

# 用户选择持久安装整个包时使用；包含 Skill，并写入 Pi 设置
pi install .

# 从这个公开仓库安装
pi install git:github.com/TohmaN233/pi-CAW
```

原生 Pi 即可使用，不需要 pi-own、Next.js、Mode Pack、课程数据或课程工具。pi-own 通过可选 Host 事件接入课程能力和模式默认开关；没有适配器时使用通用 Workflow 库和全局开关。整个包的 Skill 位于 `skills/pi-caw/`，它定义普通任务的自动路由与 Role 选择规则。

在 Pi 中执行 `/caw` 打开本次服务的 loopback Workbench。随机访问令牌应留在当前会话。Workbench 保留原版 React/React Flow 画布、节点 inspector、资源编辑、历史、导入、生成、执行、依赖、缓存及集成面板；模型配置改为 Pi 的准确 provider/model/thinking 选择。

1. 在 Provider 设置中，为需要的逻辑 slots 选择实际 Pi 模型及支持的 thinking。Main 没有这项设置。
2. 查看默认 Roles 和 Workflows，按任务配置所需能力；独立审阅由 Role 或任务自身的流程安排。
3. 为具体任务选择 Ready Workflow，填写工作目录、声明输入及读写授权。结构化本地输入通过 `inputs_path` 交给 Host 读取。
4. Run 在后台执行，Pi 发出完成或需处理的通知。Main 收到 `PI_CAW_MAIN` 时用 `caw` 的 Main 操作读取授权和资源，提交语义结果。
5. 在 Workbench 查看审批或最终提案，验收展示的准确 SHA-256。Authoring 发布还会检查源 revision 和独立 reviewer 结果。

## 默认内容

| Role | 原版用途 |
| --- | --- |
| Bounded code change | 固定接口和明确文件所有权下的完整实施 |
| Heavy bounded change | 需要较多局部判断的有界实施 |
| Cross-review | 独立检查实现与验证证据 |
| Review and repair | 在授权范围内检查并修复 |
| Bounded brainstorm | 有界方案推演 |
| Repository analysis | 仓库分析与可追溯结论 |
| Hard problem solver | 难题分析与解决 |

GPT 专用的 web-review slot 和 GPT reviewer 不纳入 Pi 默认内容。Roles 保留 prompt、direct role instructions、描述、tags、access、enabled 状态及来源 metadata。内置 Role 的定制属于同一个内置身份；Draft 不影响执行，发布后的定制才替换有效配置。

| Workflow | 行为 |
| --- | --- |
| `system.skill2workflow` | 完整 Skill 快照 → 语义 planner → Host compiler → 独立 review → 人工发布 |
| `system.build-workflow` | 普通 brief 快照，随后使用相同 authoring 契约 |

`pi-worker`、`pi-reviewer`、`pi-specialist`、`pi-cross-review` 是逻辑 slots，模型绑定全部为空。共享生成路由是模板配置；保存它不会覆盖已经独立编辑的 authoring planner、reviewer 和修复预算。

## 执行与证据

| 对象 | Pi 执行方式 |
| --- | --- |
| Main | current 或 isolated 上下文；继承原聊天模型；验证真实 session、dispatch、结果工具调用及完成 turn |
| Provider / Role | 显式绑定的 native Pi child session，接收该任务与固定资源 |
| thread | `start` 创建持久 session；`continue` 验证并续接声明的上游 session 和 binding |
| fan-out | Host 分配输入、限制并发、按确定顺序合并结果，逐项 delivery 保留已接受项 |
| SubWorkflow | 固定 child revision 和父子身份；child 验收后 parent 收集成功输出 |
| deterministic tool | 执行准确注册的契约，记录输入、输出、程序及文件效果证据 |

Run 保存不可变 pins、哈希链 journal、dispatch intent/receipt、结果提案、真实 session/turn 证据及费用 ledger。模型只提交新语义值；原始记录、路径、哈希、位置、leases 和 receipt 由 Host 绑定。缺失计费信息记为 unknown，不等于零费用。

临时 worker、规划、审核和 Role 的会话记录存入 `PI_CAW_DIR/execution-sessions` 私有目录，不进入 Pi 聊天历史。Run 会话遵循 Run 保留策略，成功后默认保留 24 小时。独立 Role 成功后先保存结果、关闭任务，再清理会话；失败或未确认关闭的 Role 保留证据。显式 `thread` 和发起聊天继续持久保存。

默认 Run 由独立 Node owner process 执行，以 IPC 接收准确 Host bootstrap；Pi Host 关闭后，已授权 child 工作仍由该 owner 持有。Main 始终是原 Pi 聊天：原聊天 bridge 不在时停在 `waiting_parent`，重连验证同一 actor，不创建替代 Main。Owner 监视 journal authority、发布 heartbeat 和持久终止记录，并在所有 session/program effects 确认收敛后才证明停止。

普通声明式 Pi Provider 配置可交付独立 owner。函数形式的 native Provider 需要 Host 显式提供可信本地 provider module；无法移交的绑定会在 dispatch 前失败。用户可明确选择 `detached_host: false` 使用同一 Host 内执行，不会自动回退或更换模型。Private bridge/RPC tokens 和 bootstrap 凭证不进入模型输出或公开 worker 状态。

Cooperative 执行使用 Pi 原生文件工具及 Host 探测的 shell/Node 程序；共享 broker 记录程序参数、cwd、输出、取消和文件效果。Strict Main 和 child 使用限定的 workspace/input/resource broker，关闭 ambient Skills 和上下文文件；这是应用边界，不是 OS sandbox。逻辑 Main 的模型来自原聊天，每个隔离节点拥有真实的独立 Pi JSONL 和完成凭据。

原生 MCP 使用 Pi 已配置的 server 名称、exposure 和认证。Cooperative child 可继承启用的 catalog；Strict child 使用明确声明的 subset。缺少 server、隐藏工具、连接失败或需要 OAuth 登录都明确报错；登录和配置由父 Pi 会话的 `/mcp` 处理。

并行只读分支可以并发。并行写保留 Git worktree、Strict 分支、Join 集成提案、完整 patch review、准确 hash 接受和清理流程；离线 fixture 已使用真实 Git 验证两个 Strict writers 的隔离、人工集成和清理。默认程序执行走本机 Pi。已配置且验证的 WSL binding 可通过 `constraints.execution_binding` 明确传入；插件不会自动安装 WSL 或悄悄切换执行模式。资格、接口与验证范围见 [Host](docs/HOST.md) 和 [功能对照](docs/PARITY.md)。

## 管理与恢复

图和资源编辑使用 revision CAS；发布验证结构及依赖但不会启动 Run；删除进入可恢复的 Pack trash。Skill import 保留完整资源、来源及待确认问题。转换发布的 Workflow 使用自己的资产，运行时不再读取原 Skill 或私有 conversion history。

Portable package 安装可读取本地文件或 HTTPS URL，校验原始 digest、对象 hash、revision、schema 和依赖后原子创建。支持原版通用包 envelope，保留原始 digest 和不可变 snapshot。Full Pack export 是诊断快照，可能含私有来源材料，不能当作 portable package 安装。

暂停停止新的释放；取消收回权限并等待已知执行器收敛。不确定 dispatch 不能自动重放。恢复使用准确 Run/attempt、关闭证据、原 child identity 和新 lease；已落盘且关闭的成功结果可以收集而不重新调用模型。控制器丢失时，Workbench adoption 或带真实用户消息授权的 `recover_control` fence 同一 Run 树的旧权限，不会批准或完成节点。

Adoption 先按已观察 sequence 执行 CAS 和 authority fencing，再等待旧 owner 准确 shutdown。Cleanup errors 写回 Run 并阻止 resume；旧 generation 的证据在经确认的恢复后归档。Startup/abort/close 无法确认时保留原 owner 和 interrupted attempt，不写虚假的 closed receipt。切换当前聊天只撤销旧 Main 的新执行权限，仍可清理准确旧 task，不中止新聊天。

缓存先预览，再按准确 plan hash 清理未被当前版本、Run pins 或传递来源链引用的 revisions/resource objects，保存持久审计。Pi 聊天、凭证和用户 Host 安装不会被清理。Authoring 接受后的私有数据清理使用独立、可重试的事务，用户提供的 workspace 会保留。

## 验证与边界

```powershell
npm run check
npm run audit:publication
npm test
npm run check:web
npm run smoke:native
```

Smoke 脚本直接从本项目解析 Pi SDK peer dependency，不读取相邻 pi-own。真实 SDK 与扩展 loader 配合 faux Provider，在隔离状态中验证 worker → orchestration、当前聊天、原生 shell/文件工具及离线 MCP；付费模型调用为零。证据保存在 Git 忽略的 `.artifacts/`，具体范围见 [PARITY](docs/PARITY.md)。

独立 owner、原聊天 bridge 和准确恢复的证据见 [PARITY](docs/PARITY.md)；本机程序执行不宣称 OS 隔离。Codex App Server 和 native bridge 使用 Pi 原生 session/tool 适配。用户已明确排除 Cursor/Grok 远程连接，选择 Pi 的模型导入路径；它们不是 GPT 专属能力。ChatGPT web packet reviewer 和 direct OpenAI advisory transport 属于 GPT 专属路径。真实付费模型、用户 OAuth、多 Host 和 WSL 运行需要分别验证，离线通过不能证明全面验证。

详情：[迁移记录](docs/MIGRATION.md)、[Host 接口](docs/HOST.md)、[功能与证据对照](docs/PARITY.md)、[authoring 对照](docs/AUTHORING-PARITY.md)。来源 commit 固定在 [upstream.json](docs/upstream.json)，原 MIT license 保留；来源仓库未被修改。


Workflow 模式提供默认偏好，所有已安装的普通 Workflow 都可以在每个模式中选择。可选 Host 偏好接口保留会话级 CAS；独立 Pi 提供全局开关。库界面按启用与禁用分组。开关保留 Draft 状态和已有 Run pins，工具、任务和来源权限仍由实际能力契约约束。
