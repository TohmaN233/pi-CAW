# 可移植行为与验证对照

基线为 `upstream.json` 固定的 Codex Agents Workflow 1.1.1 源码、默认配置、control-plane/ orchestration Skills 和 Workbench。对照的是原版已经实现的可移植行为，不把新的 Pi API 愿望当成原版遗漏。

功能已经接线、离线 fixture 通过、真实 SDK smoke 通过和真实用户环境验证是不同层次。这里不声明无条件 full parity 或所有功能已实测。付费模型、实际用户 MCP OAuth、WSL 和所有 Host 版本不在离线 fixture 的证明范围内。

## 对照

| 原版行为 | Pi 实现 | 当前证据或待验证边界 |
| --- | --- | --- |
| 默认 Role/Workflow library | 7 个完整通用 Roles、2 个完整 Host authoring graphs、4 个逻辑 Provider slots；模型绑定为 null，保留其余模板信息。按用户实际删除状态移除旧固定实施/审阅组合 | `test/defaults.test.mjs` 对照 source prompts、metadata、graphs 与升级行为 |
| 原版 Workbench UI | React/React Flow canvas、inspector、资源/历史/import/authoring/run/dependency/cache/parallel panels；Pi settings/catalog adapter | frontend/transport/refresh/edit-launch tests 和 TypeScript/build 检查；不是所有 browser interaction 的实机验收 |
| 自动路由与普通 Role 委派 | 只返回有效 Ready candidates；精确 Role profile/adapter；Task owner 保留验收与整合责任 | `test/workbench-parity.test.mjs`；native helper lifecycle 归 Pi Host，原版也由 native host 提供 |
| 内置 Role 定制 | 稳定 built-in identity/provenance，重复定制幂等，Ready 才生效 | customization、unchanged instructions、disabled 与重复 provenance 回归 |
| 图/资源/history/CAS | immutable revisions/objects、资源编辑、restore/duplicate/rename、publish 不启动、delete 到 trash | imported store/editor 契约及 Workbench regression；所有图形编辑路径尚需真实 UI 验证 |
| Skill/brief import 与 source status | 全资源 Draft、来源和 unresolved observations、两种 source adapters、SkillRef pins/inline、relocation | core importer/compiler 被保留；`host-inventory` 与 Workbench tests 证明实际 Pi catalog/folder 区别 |
| Authoring | planner → graph assembly → execution binding → validation → independent reviewer → exact human publication | `test/authoring-parity.test.mjs`；详见 `AUTHORING-PARITY.md` |
| Repairs/recheck | 稳定 key semantic repairs；复用持久 planner artifact；saved reviewer 重新校验后人工接受 | 离线端到端 artifact/identity/review/source-CAS tests，无 planner 重放 |
| Main execution / completion | 节点级 worker / orchestration；继承原聊天当前模型，worker 默认独立上下文，orchestration 使用当前聊天和原生工具；稳定 actor、准确 hash 人工接受 | `main-execution-mode` / `current-chat-main` / `isolated-main` tests；`smoke-native-pi` 实际 SDK worker → orchestration、shell/write、无 pi-own hooks |
| Provider/thread/fan-out | native Pi child；准确 session continuation；并发/逐项分配及确定性结果 join | `service` / `fanout` / `thread-source-options` tests；SDK faux smoke 独立验证实际 APIs |
| SubWorkflow | immutable child revision、父子 authority、独立最终验收、成功后收集 | `test/subworkflow.test.mjs` |
| Recovery | exact claim、closed durable result、child reattach、controller-tree adoption 与用户消息授权 | `workbench-parity` / `service-recovery-binding` tests，验证未增加 attempt 和无 worker redispatch |
| Pausing/cancellation | 停止新 release，回收权限，等待执行器及 Run 树；不把请求取消当成 shutdown 证据 | Main queued cancellation、native program shutdown、session fixture tests；复杂真实 Host/process 场景需验证 |
| Host owner/watchdog | 默认独立 Node IPC owner、authority watcher、heartbeat/terminal/quiescence、准确 parent Main bridge、generation history | `test/detached-owner.test.mjs` 的真实 spawned Node 与 `test/detached-pi.test.mjs` 的实际 Pi SDK/faux Provider；验证 parent exit/close 后 child 继续、原聊天 reattach、exact stop/acceptance、unknown startup，不调用付费模型 |
| Cost ledger | 观察 actual assistant usage，聚合 fan-out/turns，保留 unknown 和 budget reservations | ledger/usage 路径接通；不能把 unknown 算成零费用，真实模型计费需实测 |
| Portable packages/full Pack export | 校验 digest/objects/revision/dependency；通用原版 envelope 保留原 digest；诊断 Pack snapshot 单独导出 | package integrity、tamper、相对路径、workspace containment regression |
| Runtime preparation | portable executable requirements、Host registry、closure discovery/recheck，位置不写入 reusable definitions | environment core 与 program broker tests；真实机器/version/module 需验证 |
| Programs | native Pi shell/Node 与注册程序，共享 resource/input/workspace broker、运行输出和效果日志 | `program-broker` tests；native process 应用授权不等于 OS sandbox |
| Native MCP | Pi native config/search/codemode/exposure/OAuth；Strict subset、Cooperative catalog，等待实际 startup；工具调用检查 exact lease | `test/native-mcp.test.mjs` 和实际 SDK 离线 smoke，包括 revoked lease gate；实际 OAuth/远程 server 待验证 |
| Parallel read/write/integration | read concurrency；Strict write worktrees；exact patch review/integrate/cleanup | `test/parallel-pi.test.mjs` 使用真实 Git 的两个 Strict child writers，验证隔离、越界拒绝、准确 hash 人工集成、当前聊天 final 和幂等 cleanup；child 为离线 fixture，不证明所有真实模型/Host |
| Cache cleanup | human preview/hash；传递来源与 Run pins；orphans/revisions sweep；durable audit | `test/workbench-parity.test.mjs`；不触碰 Pi 安装版本、会话或凭证 |
| 可选 WSL | 显式 Host binding，经 qualifier/broker 原样执行准确发行版和程序 | retained interface 与输入校验；本轮未证明真实 WSL/sandbox/distribution 环境 |

## 产品专用执行器差异

原版 Codex App Server、native Agent spawn/followup bridge、Codex task APIs、managed login 和 MCP App bridge 是 Codex 产品接口。Pi 使用自己的 session/JSONL、follow-up、native tool/MCP、`/caw` 和 loopback Workbench；没有伪造原版 receipt 或保留无效入口。原版 detached owner 的通用生命周期已由真实独立 Node owner 和 parent Main bridge 实现，证据与 adapter 边界见下文。

用户已经明确选择“不需要 grok 和 cursor 的远程连接，因为 pi 本身可以导入各种不同模型”。因此 Cursor CDP 与 Grok ACP 连接器是用户选择排除的产品适配器，不是 GPT 专属功能。原版 Provider 的责任、绑定、权限、最小上下文、准确身份、停止证据及人工接受规则迁移到 Pi 原生模型/session 路径；MCP 工具通过 Pi-native MCP 提供。原版 ChatGPT web packet review 和 direct OpenAI advisory adapters 属于 GPT 专属路径；GPT reviewer 和 web-review slot 一并排除，不伪装为通用 Pi Provider。

0.2.24 补齐隔离 logical Main：它继承原聊天在 dispatch 时的模型与 thinking，使用独立 SDK 上下文、限定资源/工具和真实执行日志。Cooperative Main 仍可继续当前对话，也可显式选择隔离。Authoring 的 `final` 保持 Host publication 边界，独立 review 仍由已绑定 Provider 执行。

## Detached owner 的准确边界

原版 `control-plane/lib/execution/host-main-worker.mjs` 中，`launchDetachedHostMain` 以 IPC 交付准确 Run/controller/owner，启动独立 Node process；`watchHostMainAuthority` 监视 journal 的取消、authority hash 和 owner 变化；`readHostMainWorker` 校验准确身份、heartbeat 和终止状态；`waitForDetachedHostMainStop` 只在本地 session cleanup 确认后接受跨 process 的停止 receipt。这些是可移植控制面行为，不能因为旧 executor 是 Codex 就一并排除。

真正的产品 adapter 边界在该文件的 `workerMain`：它打开 `WorkflowService` 后调用 `hostMainManager.launchRun`，后者在 `host-main-manager.mjs` 中使用 `createCodexSession`。Pi 以 `detached-owner.mjs` 的独立 Node owner、`pi-worker.mjs` 的真实 SDK child executor 和 `parent-main-bridge.mjs` 的原聊天 Main 替换该 factory。`PiSdkHost` 现在报告 `detached_owner:true`；证据证明的是实际 process/SDK 生命周期，而不只是 async Promise 或 worker JSON。

验证覆盖准确 Run/controller/actor IPC、private endpoint authentication、parent process exit、Pi parent service close、原聊天 bridge 消失后的等待与重连、controller revocation/cancel 前 effect fencing、quiescence failure 保留、generation recovery 和 publication purge 的 durable receipt。Main actor 改变后，新的旧任务执行被拒绝，准确旧 task 的 teardown 仍能完成。Child/Role terminal events 只作为 child evidence，不结束 root owner。Recovery 先执行 reviewed sequence CAS/fencing，再等待旧 owner，cleanup errors 阻止 resume；每个 node 先确认 session owners 关闭再 complete。Release preflight 在 retry/resume 新执行前检查旧 generation：已确认的 `stopped` / `authority_revoked` 可在准确 attempt reconciliation 后沿用 controller，其余停止 generation 需要 controller rotation，保留原版 resume 契约和历史证据。

`test/detached-pi.test.mjs` 还使用实际 Pi SDK、独立 planner/reviewer 与离线 faux Provider 验证 accepted authoring：人工准确 hash 接受后发布 Pack，故意延迟 cleanup 验证 active RPC 保持 owner，清理全部 private authoring artifacts，最后确认独立 owner 的 publication receipt 和停止。该 case 故意让 terminal parent notification 失败，验证原事件在 private Run purge 后仍持久保留，不交付给其他 Pi actor；原聊天恢复后准确 hash acknowledgment，重复读状态不再次交付已确认事件，也不重新调用模型。Parent Main 没有执行 authoring review，真实模型调用为零。Generic owner fixture 与该 SDK 端到端证据分别保留。

函数式 native Provider 必须有 Host 明确提供的可信本地 module，或明确选择 `detached_host:false` 同 Host 执行；不可序列化的绑定不自动回退。已有模型/OAuth/远程 server、不同 Host SDK、WSL 和跨设备运行仍需各自环境验证。本表逐行记录行为与证据，不声明所有环境或所有路径已实测。

## 怎样复核

执行 `npm run check`、`npm test`、`npm run check:web` 和 `npm run smoke:native` 查看当前 checkout 的具体结果。SDK smoke 直接解析 Pi SDK peer dependency、使用 faux Provider 与隔离 state；native MCP smoke 用离线 server fixture。`smoke-native-pi` 不加载 pi-own、Next.js、Mode Pack 或课程适配器，实际验证默认上下文隔离、原聊天接续、Pi shell/文件工具和仍待人工验收的交付。证据输出保存在 `.artifacts/`，没有写入用户配置或调用付费模型。

真实环境验收应分别覆盖选定模型/thinking、OAuth、shell/programs、续接和取消、parallel integration 与可选 WSL。不要重复调用真实模型来发现可由结构、projection、compiler、artifact replay 或 offline preflight 找到的问题。新增证据或发现具体行为缺口时更新本表和 `MIGRATION.md`。

## 0.2.27: bounded loops

Codex CAW's finite region loops, positional item repair, accepted sibling preservation, changed dependency re-review, round journals, nested/disjoint ownership, exact parallel archives and exhausted failure are available in Pi. Both generation paths compile actual loops. The editor displays regions and Run rounds. Native result submissions preflight before persistence, including detached Main's authenticated validation callback; completion rechecks current state. Main review remains fresh/read-only despite per-Run overrides. These features have no pi-own/Mode Pack dependency. [Contract and evidence](LOOPS.md).

## 0.2.28: reviewed validation boundaries

Portable loop baseline remains upstream 8db71a3. Pi deliberately removes representation-only empty-field requirements and the generator-only Provider restriction. Native authoring submission now shares compile/replay/apply qualification and exposes errors before durable submission; actual negative review remains valid feedback. Main IR field inventory agrees with routing and schema. Read the [audit and retained boundaries](VALIDATION.md); standalone native and detached SDK fixtures use zero paid calls.
