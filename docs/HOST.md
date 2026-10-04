# Pi Host 接口

`PiCawService` 接收注入的 Host；图引擎不加载另一份 Pi SDK。扩展通过 Pi 自己解析的 peer imports 使用 SDK 1.0 接口。实际版本由 `runtimeMetadata()` 读取，无法观察时显示 unknown/null，不能用版本常量替代观察。

## 会话、模型与工具

| 接口 | 契约 |
| --- | --- |
| `catalog()` | 当前 session 可用的准确模型、supported thinking 和 contract fingerprint，不含凭证 |
| `mainIdentity()` | 当前聊天的真实 session 身份，不创建 session |
| `createMainTask(request)` | current 模式排入原聊天；isolated 模式使用原聊天当前模型与 thinking 创建新的 SDK 执行上下文。两者观察准确结果调用和完成 turn |
| `createTask(request)` | 创建或续接显式绑定的 native child，固定 cwd/access/allowed paths、schema、资源及 MCP 要求 |
| `task.run({prompt,schema,signal})` | 返回经校验的语义值、准确 session/turn、usage、文件变化和完成证据；错误抛出 |
| `task.abort()/close()` | 停止并等待所属执行器收敛；Main 只停止该 dispatch，不销毁当前聊天 |
| `releaseTask()/close()` | 收回 child/SDK 资源，关闭失败必须可见 |
| `runtimeMetadata()` | 从注入 SDK 读取版本及来源 |
| `detachedBootstrap(providerIds)` | 交付准确 SDK/agent/workspace、captured catalog、声明式 Provider 配置和 MCP registry；函数式 native Provider 必须有显式可信 module |
| `discoverSkills(workspace)` | 读取当前 Pi `getCommands()` 的真实 Skill source metadata；其他目录使用 folder discovery |
| `mcpCatalog()` | 读取 Pi native 配置及 extension 注册，输出启用状态、namespace、exposure 和 scope 的安全 metadata |
| `capabilities` | 当前真实 Pi adapter 提供 `detached_owner:true`、`process_sandbox:false`；独立生命周期与 OS sandbox 是不同能力 |

模型从当前 `ModelRegistry.getAvailable()` 读取，并遵守 scoped models。Child 的 provider/model/thinking/fingerprint 必须准确匹配。Host 拒绝 SDK 的 model fallback、thinking 替换或 runtime contract 差异。自定义/native Provider 通过 Pi public registry API 注册到 Host runtime，认证依然归 Pi。

当前聊天桥在 `message_start` 激活 queued Main，因为 Pi 消费已有 agent loop 内的 follow-up 时不保证再次触发 `before_agent_start`。`agent_end` 检查当前 branch 的真实 entries：dispatch user marker、提交工具的 assistant call、成功 toolResult、最终 assistant entry、观察到的模型和 thinking。Main 使用 `main_task`、`main_resource`、`main_tool` 和 `main_result`，只返回 packet schema 内的语义值。

所有 child tools 的 native `tool_call` hook 验证准确 lease，包括 MCP/search/codemode；Main 的 tool gate 也通过 owner RPC 验证其当前 attempt。Main 的 `run_snapshot/pause/cancel` 只作用于当前 packet 的准确 Run。切换 chat 后不接受原 Main 的新执行，准确已注册 task 的 abort/close 仍可完成旧 broker cleanup，不会中止或销毁新聊天。

`thread start` 创建持久 Pi session；续接必须验证原 Run、绑定、上游 session ID、session file 和实际 turn。文件可重开不等于上一执行器已经关闭。Host 不把缺少准确完成证据的 turn 当成成功，也不以新 session 代替不确定的旧任务。

## Programs 与文件边界

Cooperative child 使用 Pi 原生 read/search 工具和 scope-checked write/edit；Main 的 `tool_call` gate 限制当前 packet 可用操作。二者共享 `scopedTaskBroker`，提供声明 workspace/input 读取、精确 pinned resource 读取、文件写入、资源 materialization、运行时依赖及程序执行。

默认程序绑定来自 Host：Node 使用实际 `process.execPath`，shell 使用 Pi `SettingsManager`/`getShellConfig` 的当前设置。其他程序来自准确 `requirements.executables` 和已验证的 Host runtime registry。Broker 使用独立 argv、准确 cwd、受限输出、授权检查、任务生命周期及文件效果观察；程序错误、越界变化和无法确认 shutdown 都使结果失效。运行时配置和 ambient Skill 文件不作为 broker 的普通 task input。

Native shell/Node 是合作式本机执行。应用工具授权及 workspace 效果检查不等于 OS filesystem ACL。Strict Main 和 child 关闭 ambient context，仅提供声明 workspace/input/resource 的 broker 工具及明确 MCP subset。Main 原 actor/session/call chain 保持稳定；receipt 的 thread_id/session_file 记录真实隔离执行日志，observed_model 记录 dispatch 时继承的模型与 thinking。

## 明确选择的 WSL binding

WSL 是可选 passthrough；默认本机执行不会自动切换。启动 Run 时可以在 `constraints.execution_binding` 提供已存在、已由 Host 验证的完整绑定。例如以下是接口形状，不是安装指令或已验证配置：

```json
{
  "kind": "wsl",
  "launcher": "C:/Windows/System32/wsl.exe",
  "distribution": "Ubuntu",
  "sandbox": "/usr/bin/bwrap",
  "programs": { "node": "/usr/bin/node", "shell": "/usr/bin/bash" },
  "runtime_roots": ["/usr", "/lib", "/lib64", "/bin", "/sbin"],
  "command_timeout_ms": 300000
}
```

发行版、sandbox 和程序必须真实存在；`qualifiedExecutionBinding` 检查形状、launcher、程序根及 deadline。执行时还会验证 runtime、路径映射、scope、可写目录链接、准确 Linux execution unit 和终止证据。Windows workspace/task-root 使用 drive path 映射；声明的 `task_root`、`constraints.task_workspace` 或准确 Run workspace 由 Host 绑定，模型不能自行换根。缺少能力时明确失败，不安装 WSL、提权、寻找替代发行版或回退本机。真实 WSL 行为需要独立实测。

## Native MCP

`loadNativeMcpCatalog` 使用 Pi 的 `loadMcpServerConfig` 和 extension `getMcpServers()`，尊重 project trust、原 namespace、server exposure 与 tool exposure。私有配置留在 native catalog 内，模型只收到安全 metadata。它不包含插件自建的 MCP client/凭证协议。

Cooperative child 在无明确 subset 时可使用当前启用的 native catalog；Strict child 只加载声明的 server subset。Host 创建 Pi 的 native MCP/search/codemode extension factories，等待必需服务器实际 ready 后再提交模型 prompt。缺少或隐藏的 server、namespace 冲突、连接失败和 OAuth 要求均为可见错误。Child 登录和配置操作交给父 Pi 会话的 `/mcp`，随后显式重试；不会在 child 内打开登录窗口或写 server 配置。

MCP 能力由实际 server 提供；native transport 不能证明外部工具没有副作用。工作流仍需准确声明要求与授权，禁止把另一个邻近 server 当作缺失工具的替代。离线 native MCP fixture 验证 transport、exposure、启动和关闭，不证明用户 OAuth、远程服务或所有工具行为。

## 控制、并行与状态

运行身份、lease 和 controller tokens 由 Host 保存。恢复同一 attempt 时轮换 lease，未提交 claim 接续原 dispatch 路径；已有关闭的 durable result 直接消费；SubWorkflow 重连校验完整父子身份与控制 hash。控制器 adoption fence 原 Run 树并暂停；仍有 interrupted 节点时不能自动继续。恢复不替代审批或最终接受。

`DetachedOwnerRegistry` 启动独立 Node process，以 IPC 发送准确 Run/actor/controller identity 和 Host bootstrap。`pi-worker` 加载捕获的同一 SDK，检查模型 fingerprint/thinking，持有 children、programs、MCP 和 driver。Private loopback owner RPC 与 parent bridge 分开；credential-bearing descriptor 只在 Host 私有记录/IPC 中保存，公开 worker 状态不含 endpoint token 或 bootstrap credential。

独立 owner 监视准确 Run journal 的取消、controller hash 和 actor，保存 heartbeat、owner generation、终止原因及 quiescence receipt。它可在 parent Pi Host 关闭后继续 child 工作；需要 Main 时，通过 parent bridge 请求原聊天。Bridge 缺失时持久记录 `waiting_parent`，重连必须仍是同一 actor 和 controller；不会把等待变成新 Main/model 调用。

Controller recovery 顺序是准确 sequence CAS/Run 树 fencing → 持久新 authority → 旧 owner shutdown → 记录 recovery errors。错误未清零不得 resume。经确认并符合恢复契约的旧 generation 归档保留身份；stale heartbeat、PID 不存在或 timeout 不能证明 effects 已收敛。Startup 或 session/program abort/close 未确认时保留 cleanup owner 与 interrupted attempt，不释放新 dispatch，也不发布 closed receipt。每个 node 在收集结果后先确认所属 sessions 关闭，再 complete；fan-out 的某个后续 startup 失败也不能被早先 child 的关闭掩盖。

Accepted authoring 在 purge journal 前记录准确 terminal publication outcome，owner 等 active publication RPC 完成再关闭；响应和 queued parent notification 仍可被准确收集。Child/Role terminal events 保留自己的身份，仅 root terminal outcome 能结束 root owner。

Git worktree manager 隔离并行写分支，校验 Git base、branch ownership 和 patch。Strict 分支资格由 preflight 检查；Main 使用严格隔离或显式的 cooperative 策略。Join 需要准备并审阅准确 patch，人工接受 hash 后集成，清理有自己的证据和错误状态。这些接口已接通，实际 Pi 并行写流程的验证范围见 `PARITY.md`。

`wait` 使用 Host filesystem/event wait 和小 worker record 的 health checks，普通进度不释放模型等待。停止、失败、审批、最终验收、child events 或 timeout 返回准确状态和 continuation；AbortSignal 取消等待而不取消 Run。`events` 返回 journal cursor 和安全 event metadata。Usage 来自实际 Pi assistant entries，fan-out 聚合所有相关 turns；无可观察费用时明确记 unknown。

State 默认位于 Pi agent 目录的 `pi-CAW/`，`PI_CAW_DIR` 允许独立绝对路径。`settings.json` 存 bindings/roles/routing，`workflows/` 存 immutable Pack，`runs/` 存 pins、journal、提案及 Host controller 文件；`owners/detached-owners/` 存准确 owner status、私有 endpoint 和 generation history。Authoring job/workspace/cleanup transaction 和 worktrees 也在该 state 下。Child sessions 归 Pi SessionManager；主聊天不归插件创建或销毁。Workbench 用随机 token、loopback binding 和 same-Origin 校验认证。

新 release 先检查 recovery cleanup errors 和准确旧 generation。原版允许已确认 `stopped`、reason 为 `authority_revoked` 的 owner 沿用已 reconciliation 的 controller；其他已停止 generation 需要 controller rotation，旧证据归档。Terminal parent notification 失败时，原 Run/Role event identity 和 owner/actor/hash envelope 保留在 durable queue；只向原 Pi actor 交付，acknowledgment 单独记账，不改写终止 receipt。Extension 的 completion message 保留 `delivery_id`，已观察的同 ID message 不重复加入原聊天。

## Host 事件与限制

- `pi-caw:session-created`：真实 child/session/parent/node 身份。
- `pi-caw:task-finished`：完成、验收等待或 actionable attention，含 bounded diagnostics。
- `pi-caw:open-workbench`：本次 loopback UI 地址供 Host 展示。

这些事件不是 Pi-own Web/RPC 的专用任务注册 API，也不声明跨设备 daemon 或专用任务卡片。独立 owner 已有真实 Node 与实际 Pi SDK 离线验证；主聊天依然需要同一 Pi actor 重连。不能由这些结果推导用户真实模型/OAuth、远程 MCP、所有 Host 版本或 WSL 已验证。

函数形式的 native Provider 不可经 JSON IPC 隐式搬运；Host 必须显式提供可信本地 module，或用户明确选择 `detached_host:false` 同 Host 执行。不存在自动模式回退。WSL 仍需显式 binding 和真实环境资格，`process_sandbox:false` 仍是真实本机边界。
