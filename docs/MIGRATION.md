# 独立迁移记录

用户确认并通过本机 Codex CAW 实时清单核验：`implementation-with-review` 已在原环境删除。早期 Pi 迁移误以仓库历史默认清单为用户配置，重新安装了该组合。本次从 Pi 当前定义及两个默认数据入口移除它，保留独立审阅 Role、用户图、模型绑定和历史 Run；新安装与升级不得恢复该过时组合。临时全 Host 的 course-source-compile 验证图亦已撤下，普通源码编译继续直接使用 Host 工具。

Host 交付末端折叠只检查编译器原样生成的可丢弃 final scaffold、单一受保护 Host 前驱、成功边以及其他输出绑定。上游条件分支、join 和显式教师审批不会阻止 Host 直接完成交付；自定义 final 职责继续保留。此前全图线性限制使条件主流程多出一轮 Main，本次修正删除该错误限制，并覆盖带条件和人工 gate 的真实导入/认证发布。已审阅的部署图通过原生编辑器做对应机械修订，记录 direct_editor_publication，不伪造重新 AI 审阅。

独立审阅增加由同一 canonical proposal 自动生成且 hash 绑定的 compact facts sidecar：列出实际 node source spans，以及必填 finite enum 的 explicit/default domain。开放或可选 selector 不产生有限域证明。该索引区分资源读取授权与 source evidence，避免把一个剩余合法值误当成接纳未知值、把引用整份文件误当成引用所有行。它不计算语义 approved、不覆盖失败意见、不修改 Source/plan。

课程合并转换的 Host 修正保留完整 dotted 文件名与分句极性：选择静态 result schema 不等于生产 schema 文件，否定说明不提供新的必填接口字段；旧观察 ID 保留可追溯语义，真实正向文件写入仍被验证。Review-only recheck 的 immutable `allow_semantic_repair:false` 在 compiler 和 reviewer 之后仍阻止自动 planner 重试；混合审阅出现 Host finding 时也先停止。独立 reviewer 按实际 effect owner 和保留的 runtime guard 判断 conditional dependency，共用 Host compile 不会把仅 Rmd render 所需 Pandoc 变成所有产物的启动依赖。原始 Source、planner artifact 和 journals 不重写。

来源是 Codex Agents Workflow 1.1.1，commit `534bbfcdd139d5871c54abce88d6a3ee45a74436`；准确 source inventory 与 repository URL 固定在 `upstream.json`。本仓库保存独立副本、Pi adapters、产品配置及验证；来源仓库不参与运行，也未被修改。

当前功能更新面向 pi-CAW 0.2.23，Pi SDK 1.0 是实际 Host API 适配基线。版本与能力从 manifest 和实际 Host metadata 读取，不能根据相邻仓库或过时 SDK 记录推断运行环境。

## 产品内容与 Workbench

- 还原 7 个原版通用 Roles、2 个完整 Host authoring Workflow graphs、原 prompt/direct instructions/description/tags/access/enabled/provenance，以及共享生成路由。4 个逻辑 Provider slots 具有用途和 capability metadata；只有 model/thinking binding 为 null。
- 默认内容通过带 ledger 的升级安装，保留现有修改，不恢复用户已删除的默认项。`implementation-with-review` 按用户删除状态从默认内容移除；GPT reviewer 和 web-review slot 不迁移。版本 2 的默认升级会移除早期错误加入的这两个固定身份；其他 Role 若引用该旧 slot 则清空绑定并记录诊断，不擅自改选模型。
- Workbench 使用原版 React/React Flow source UI；保留 canvas、inspector、资源、history、Skill import、authoring、run、dependencies、cache 和 integration 操作。Pi loopback transport 与模型配置替换 Codex App bootstrap/config catalog，没有只留下 JSON 编辑页。
- 内置 Role customization 使用稳定 Pack identity 和 `builtin_role_id/builtin_role_revision` provenance；Draft 不生效，Ready customization 以同一 builtin Role ID 参与选择，重复 provenance 明确失败。
- 聊天中的显式 Workflow 管理仍能创建、保存、编辑资源、发布、删除、导入和导出；配置、来源/inference 确认、最终审批、authoring 发布及 patch integration 保留人工边界。共享 routing save 不覆盖已独立配置的 authoring binding/rounds。
- Pi Skill 保留原版 control-plane 和普通 Role orchestration 规则及完整管理、native、parallel、recovery 和 Provider references，替换产品专用工具名与执行事实。

## 执行器与核心契约

- Main 保留原 Pi actor；current 路径的 receipt、dispatch marker 和 JSONL 绑定原 session，isolated 路径另记真实执行 session。模型/thinking 在 dispatch 时继承原聊天，没有独立 Main 模型配置。
- Provider 子任务使用注入 Pi SDK 的 native sessions 和实际 registered Provider runtime，绑定为 `provider/model_id/thinking/fingerprint`。Catalog 来自当前 `ModelRegistry.getAvailable()` 并遵守 scoped models；不存在默认 child、默认 thinking 或 fallback 模型。
- `thread` 使用 Pi session/JSONL identity。Start 产生新 session，continue 验证并重开准确上游 session、Run 和 binding；Codex task/native bridge 接口不参与运行。
- `workflow-runtime.mjs` 的 Main receipt allowlist、native ownership 与 executor events 使用 Pi 身份；`thread-protocol.mjs` 使用 `pi_session` evidence。Intent、receipt、result proposal、shutdown 及 journal hash 的顺序与真实性不放宽。
- `config.mjs` 保留模板字段，native provider identity 不再映射内置 GPT 模型；废弃的 Codex spawn 构造器与 app-server/strict transport 不作为 Pi runtime 依赖。
- 默认 Draft 使用 cooperative 策略。Strict Main/child 使用隔离上下文、限定工具和 pinned resources，不降级。Main 可显式选择隔离或继续当前聊天；声明 Strict 的节点仍须隔离。
- Fan-out 保留输入投影、并发窗、逐项 delivery、accepted-item journals 和确定性 join；Host 独占 item indexes、receipts、schemas 和完成证据。模型不手抄原始数据或协议字段。
- Pi startup admission 与 core 数量语义一致：没有列表 fan-out 的 `subagent_count: auto` 确定为一个 child，不是隐式多 child 池。固定大于一仍必须声明真实列表 assignment / all-required join，Main 不能配置数量；不修改 published graph 的配置值。`test/subagent-admission.test.mjs` 覆盖真实离线 startup/dispatch 单 child、非法固定多 child 与 Main 数量在创建 Run/模型前失败。
- Read-only `get` / `run_snapshot` 仅在安全、现存 Run store 下准确 Run 目录不存在时返回 `RUN_NOT_FOUND` 与 `details:{run_id,observation:'run_directory_absent'}`。这只是当前目录缺失观察，不证明从未创建、owner quiescence 或可重试。缺 store、链接、现存目录内缺 journal/pins/resources、损坏、权限和 controller 错误仍显式失败。私有 Extension bus 的 Promise reject 原样传 Error/code/details；`test/run-not-found.test.mjs` 覆盖这些边界。
- Usage 从实际 Pi assistant entries 观察并聚合；缺失 metering 记 unknown。原预算、reservation 和 known/uncertain cost ledger 保留。
- 原版 independent owner 的通用生命周期迁移到 `detached-owner.mjs`、`pi-worker.mjs` 和 `parent-main-bridge.mjs`。默认真实 Node IPC owner 在 Pi Host 关闭后持有 child 工作；Main 缺少原聊天 bridge 时进入 `waiting_parent`，重连准确 actor，不创建替代 Main。
- Owner 保存准确 generation/heartbeat/terminal/quiescence，watch Run journal authority；私有 endpoint token 和 bootstrap credentials 不进入模型结果。函数式 native Provider 使用 Host 明确提供的可信 module，用户可明确选择 `detached_host:false`，不自动回退。
- PiSdkHost / PiCawService 支持可信 `getHostTools()`（同步返回 registry object 或 Map），每个条目使用既有 `identity`、qualified/cancellable/effect-observation `attestation`、`execute(request)`、`cancel(request)`。拒绝覆盖 built-in ID/implementation name。可选 `contract` 必须通过原 Host-tool contract 验证并匹配条目 identity；它进入 authoring 的 `host_tool_contracts`，执行时要求完整 contract 一致。模型不能通过此 hook 注册实现。
- Detached bootstrap 的外部工具只保存 ID、identity、qualification attestation 和可选 contract，丢弃 execute/cancel closures 及 adapter 私有状态。Worker 通过已有 authenticated owner RPC 到原 parent Main bridge 执行 domain tool，无新增公开 HTTP 路由。每次执行固定原 actor、Run/node/attempt、完整 contract、attestation、输入、owner callback 与有效权限；immutable resource bytes 保持 hash 并在 parent 校验。Domain workflow 可以完全由 tool nodes 和 deterministic finalizer 组成，无 Main 模型任务。
- External execute 保留标准请求，同时提供 `contract`、`authorize()`、`context.node_permissions` 和真正的 AbortSignal。Parent 在 dispatch 前和返回结果前回调 exact detached owner；adapter 应在 domain commit 前再次 await authorize。effects（包括实际 SQLite/外部路径与 artifact effects）和 termination evidence 原样交给标准 HostToolRunner 验证。取消等待原 execute promise 的退出，不能把 socket 中断或缺少 parent 当作“无效果”成功；已 dispatch attempt 不自动重放。写操作应使用 `reconcile_required`，恢复先核对 intent、domain CAS 和实际结果。
- Parent 缺失时，尚未 dispatch 的 domain tool 与 Main 一样报告 `waiting_parent`，恢复仅接受准确原 actor/Run。已 dispatch 操作保留原 endpoint，断连需要 reconcile，不能转给新 bridge 重放。`pi-caw:run-lifecycle` 在 start/reattach 的 driver 前、terminal/attention notify 前发出，供可信领域扩展维护准确 Workflow ownership。Detached deterministic finalizer 的 terminal journal watcher 在 shutdown 前保留实际结果和通知证据。

## Authoring 与资源

- `system.skill2workflow` 和 `system.build-workflow` 保留相同的 semantic blueprint/repair/checklist 契约和完整 Host pipeline。绑定与 prompt 可编辑，Host topology、SourceContract、schemas、permissions 和 compiler identity 受验证保护。
- Planner/reviewer 是明确绑定的独立 Pi children。Authoring `final` 只是 Host publication boundary，不能被当成当前 Main packet，也不能用 controller 模型替代 reviewer。
- `pi-caw-authoring-*` 是迁移后的契约 namespace；语义工作使用原 compact inventory、稳定 key patch、bounded repair、requirement assignments、source dispositions、dependency decisions 及 deterministic compiler。
- Authoring 固定 source/template revisions、routing、planner/reviewer identity 和 canonical proposal hash；exact human acceptance 与 source CAS 通过后部署 source-free Workflow。
- 已完成 planner artifact 可以重跑当前 projection/compiler 和独立 review，无新增 planner 调用；已持久化且关闭的 reviewer artifact 可由当前 checklist 复核后人工接受，两种模型都不重放。
- Source approval observation 按原文的句子/分号分句判断操作、否定和时序，不能把相邻句的 must/before 与 approval 拼成新审批门。已有批准的输入前提、工作流后的 pending 人工审核，以及不得自行批准或宣称批准的规则，保留原文和精确行号作为 method_rule；正向取得批准的指令与“未经批准不得执行”的保护仍是 approval，必须映射真实 human_gate 和受保护操作。旧 observed_approval 行 ID 在原错误分类被更正时保留，Host 重投影 canonical kind/details；不伪造已完成批准或 requirement mapping。`test/source-approval-observations.test.mjs` 固定课程新稿第 8 行的完整反例，并验证真实教案审批、先决状态、pending review、否定权限和 coverage gate 保护。
- Canonical source requirement 的 closed `details` schema 显式声明 `approval_clauses:[{relation,source_quote}]`，relation 只允许 operation_gate / existing_prerequisite / pending_review / non_approval，原文每条最多 1000 字符。普通转换、持久 proposal replay 与 legacy JSON envelope 共用该 schema；分句证据完整保留，非法 relation、缺失原文和未声明批准状态字段均被拒绝。
- Source artifact observation 判断产出动词、条件和禁止语句时排除路径本身的词汇；`Read references/semantic-output.md` 只保留读取固定参考资料的 knowledge 要求，文件名中的 output 不会生成 required_artifacts 完成门。实际 Write/Save/Update 等指令仍保存原精确路径与 source span；`test/source-artifact-observations.test.mjs` 覆盖课程完整反例、参考列表、真实产出和否定/条件分句。
- 发布后私有 source history、Host-owned workspace、job 和 Run 采用持久 cleanup transaction；同来源 active Run 阻止 history purge；caller-owned workspace 保留。`purge_authoring_artifacts` 继续准确事务，不重新发布或猜测目标。
- Portable export 的原生格式是 `pi-caw.workflow.package`。通用 `codex.workflow.package` envelope 安装先验证原 digest，再验证相同 snapshot/object/dependency 契约，保留 original package hash 和 immutable revision，不修改内容 pins。产品专用 executor/dependency 仍需真实 Pi 支持。
- Full Pack snapshot export 是独立诊断格式，保留全部资源及 provenance，可能包含私有材料；它不是 installable portable package。

## Programs、MCP、parallel 与恢复

- Shared program broker 迁移到 `core/execution/program-broker.mjs`，由 Main/child/tool-node 共用。Native binding 来自 Pi shell 设置、实际 Node runtime 及 executable registry；记录 command、cwd、stdout/stderr、效果和 shutdown。可选 WSL binding 只有明确提供后使用，不自动安装或切换。
- Native MCP 使用 Pi 的 config、extension registry、namespace/exposure、native MCP/search/codemode factories 和 OAuth lifecycle。Strict subset、Cooperative catalog、真实 startup/close 验证接通；不保留替代 MCP client 或插件自建凭证。
- 用户明确不需要 Cursor/Grok 远程连接，选择 Pi 本身导入各种模型的路径。二者是原版非 GPT 产品适配器的明确范围排除；其 Provider 责任、绑定、权限、准确身份和停止/恢复规则仍迁移至 Pi session。ChatGPT web/direct OpenAI adapters 是另一个 GPT 专属排除，不能混同。
- Git worktree/integration manager 与 Workbench prepare/review/integrate/cleanup 操作已接通。Strict writing branches 保留 source qualifier，集成必须人工接受完整 patch 的准确 hash。`test/parallel-pi.test.mjs` 使用真实 Git 和两个离线 Strict child writers 验证隔离、越界拒绝、准确人工集成、当前聊天 final 及幂等 cleanup。
- `recover_claim` 恢复原 attempt 与新 lease 后接续原 dispatch；`recover_result`/`recover_strict_result` 消费关闭的持久成功结果而不重调 worker；SubWorkflow reattach 验证全部 parent pins/child identity/control hash。
- `recover_control` 使用准确用户消息授权 schema、observed sequence 和 root-tree fencing；Workbench adoption 为另一路径。Old owner、interrupted dispatch、pending approvals 和未确认停止的效果不能被自动略过。
- Adoption 按原版先 CAS/fence，再持久 authority 并等待旧 owner shutdown，记录错误阻止 resume。已确认的 owner generations 保留归档；原 owner 和 original attempt 的不确定 startup/effects 不重放。Node completion 前验证 session owners 关闭，关闭失败保留 interrupted 状态和 cleanup owner。
- Native child/MCP 的每个工具调用验证 exact lease；当前聊天的控制动作只能作用于 packet Run。Actor 改变撤销新执行但保留准确旧 task teardown；cleanup 不会中止新 chat。
- Child/Role 通知不会结束 root owner。Accepted authoring 在 journal purge 前记录准确 terminal outcome；active publication RPC 完成、parent response/notification 收集后才关闭 owner。
- `events/next/wait` 使用准确 journal cursor 和 Host wait，Pi worker status 映射 source lifecycle phases；wait continuation 不包含 controller token，取消 wait 不取消 Run。
- 缓存按准确 human preview/hash 清理 unpinned revisions 与 resource objects，保留当前、Run 和传递 provenance 引用，保存 durable audit。不触碰 Pi 安装版本、会话或认证；source Codex plugin-cache 清理属于产品专用安装管理。

## 复核与证据

Semantic Blueprint 的 `from` 和 approval `subject` 支持 `activity.output.property`，仅沿 schema 中明确声明的 object properties 投影。Blueprint 诊断与 Forge 共同采用 pinned semantic SourceContract、qualified Host 输出 schema，再采用 named record；placeholder open object 不能覆盖准确 schema，也不能授权未知子字段。Forge 编译为逐字段转义的 JSON Pointer，保留准确 schema 的可选字段、min/max 和 state-only `files maxItems:0`。深层 Host identity/location guard 使用同一准确 schema，空数组的不可达 items 不要求写权限。`test/semantic-output-projections.test.mjs` 验证 SourceContract/Host/named-record 投影、未知属性/array/scalar 拒绝、nested hash guard 和 approval subject。

互斥分支通过声明式 `coalesce(activity.output,other.output,...)[.property]` 选择原始输出，不经 Agent 复述。表达式仅允许 2..32 个不同 producer 的准确 schema 投影；Host 编译必须证明同一输出 schema、producer 在消费之前、互斥及所有成功路径都有候选值，随后生成已有 bounded coalesce selector。它不执行代码，也不能替代并行聚合。可选 Host 参数（如 compile.files）需要显式表达所选输入，不由 required-argument 默认推导插入。原有 `input:name` 与普通 dotted projection 保持行为；准确有限 scalar enum 不需要额外 type annotation 即可用于 native choice，原始 pinned schema 保持不变。`test/semantic-choice-fan-in.test.mjs` 覆盖 native choice、可选文件输入、空 files、closed grammar、错误 schema/不互斥/缺失分支及 machine gate 和 projected decode/hash。

提案的前置语义 admission 与 Forge 使用同一个 pinned schema qualification；选定 contract 缺少 authority 时报告机械错误，不能把正确的 nested output 误报为 unknown 并消耗模型修订。机器 gate 与后续 Host-projected proposal decode 保留同一有限 DataSchema 原形，包括 enum-only 节点、description 和支持的嵌套深度。模型自创 schema 的 legacy canonicalization 不得改写 Host 已编译的准确契约或 pipeline hash。

Source dependency 观察按分句区分 Node.js/JavaScript 执行命令与 Workflow/data node 普通文本。目标活动被合法移除时，它直接引用的 requirement assignment/runtime dependency 可以随同删除；无关 stable keys 继续被拒绝。已保存正确 artifact 通过 recheck 复用，不重新调用初始 planner。

Authoring observation 读取有界、物理且 identity-bound 的 owner journal；settled attention/error 优先于 Run 的生成/审阅推断，暴露原始错误和准确 journal hash。Run 状态单独返回，不能把未终结的 recoverable Run 当作健康模型执行。缺失的可选 launch:false journal 与损坏、跨 Run、签名不符的 journal 分别处理，后者可见失败；观察不修改历史或伪造 owner 关闭。

Trusted Host registry 可在 private attestation 声明 `storage_capabilities:{write_files,write_directories}`：有界 absolute files 或 dedicated directories，用于 Host 自有 DB/WAL/SHM 和 private request journals，不进入 Workflow public contract 或 Agent/child path grant。Bootstrap 和 successful receipt 保留准确声明；common completion 同时验证 durable output hash、完整 observed effects、bounded-write node 和 qualified storage boundary，拒绝未声明路径、symlink/reparse escape 或删除 outside-path evidence 的伪造 completion。

旧成功 Host delivery 的 same-attempt recovery 使用 human `collect_host_tool`，参数为 exact `run_id/node_id/attempt_id/receipt_sha256`。先按 exact CAS adopt/fence 并确认旧 owner 停止，再加载当前 Host，验证相同 actor、pinned implementation/contract、broker qualification 和 durable output。缺失旧 storage declaration 时单独记录 receipt-bound `storage_authorization` 与 `host_tool_collection` audit event，原始 receipt/effects 不变；collection 不调用 implementation 或模型。收集后仍保持 paused，显式 `continue` 仅释放尚未执行的下游节点。Malformed/corrupt receipt、different identity/broker、undeclared effects 或未关闭 owner 均阻止收集；不能通过 replay mutation、清空 outside_paths、修改旧 pins 或扩大 child scope 来恢复。

Pi authoring 的持久 `expand.outputs_schema` 保留 initial/repair 共用 envelope；实际 dispatch 必须按 attempt 选择严格 current blueprint 或 targeted repair schema，不能直接把空持久 schema 发给模型。compiler、normalization 和已保存 artifact 的 recheck 共用 v6 协议验证。历史空 schema 接受的 free-form inventory 不自动转换为另一套 plan：`GENERATION_PROPOSAL_CONTRACT` 保留原 artifact hash 并列出所有有界字段诊断，停止自动 semantic repair。不能据此宣称 artifact 中提出的 writer identity handoff 已实现。

Human Workbench `recheck_authoring` 默认严格验证 retained planner artifact；不隐式采用最新 source。显式 `source_revision` 可选择机械 Host contract refresh：Workflow seed（除 revision/host_tools）、resources bytes/paths、provenance/import evidence 必须一致，tool IDs、input schema、argv、permissions、idempotency 和其他 execution policy 不变；output schema 只允许新增 optional properties。新 Run 采用选择的新 identity，不冒充旧 runtime hash；replay evidence 记录旧/新 source revisions、tool identities 和 output schema hashes。

可选 `source_attempt_id` 精确选择 source Run 中某次 succeeded planner attempt；省略时仍选择最新 succeeded artifact。Host 先验证该 attempt 的 durable result bytes/hash，再使用匹配 attempt ID 和 output hash 的 historical cumulative plan ledger；非当前 repair patch 缺失匹配 ledger 时拒绝猜测 base。未知/失败 attempt、缺失或损坏 artifact 在创建新 Run 或 model dispatch 前失败。Caller 不能提交替代 plan，也不修改 source Run journal；replay evidence 中 source_attempt_id/result_sha256 保留准确选择。

显式 `allow_semantic_repair:true` 仅允许有效 current v6 cumulative plan 的可定位 semantic findings 进入新 Run 的正常 bounded targeted repair；初始 planner 由 durable replay 完成，后续真实 semantic patch 仍可能调用 planner。Malformed envelope/schema、失去 exact patch base、Host registry conflict 或机械错误在创建 Run 前失败。无 findings 或无法映射到当前 semantic keys 的错误不能使用此开关绕过。旧 Run 必须先按正常 owner recovery 暂停、fence 并确认 owner 停止；此操作不改旧 Run pins 或 journals，不发布 Workflow。

新的 deterministic source observations 可作为尚未写入 retained plan 的 repair target。普通 driver 从 immutable Run resource bytes 重建观察；recheck 从所选 exact source resources 重建同一观察。新增 requirement ID 必须属于这份 Host inventory，feedback 必须携带匹配的 pinned source span，且只能修改 requirement_assignments。不制造 assignments、不修改 planner meaning，不接受 invented IDs、其他 source spans 或无关 semantic fields。

Pi native `caw_submit_result` 使用有限 closed JSON Schema 验证，保留已声明 optional semantic properties 的省略语义。Ready validation 和 native managed result schema 使用同一边界，不能把 optional fields 强制设为 required 或填入 null；unknown fields、缺失 required fields 和错误类型仍失败。外部 strict structured-output transport 的 `strictAgentOutputSchema` 继续要求所有 declared properties 为 required，这一 transport 约束不替代 Pi 的 native submission 契约。

Cancellation/lifecycle quiescence 区分真实 Pi session 和 deterministic Host generation replay。Replay 不创建 Pi session；其成功 acknowledged dispatch、committed completion/artifact hashes、原始 attempt/result identity 和 materialized output hash 是关闭证据。未完成 replay、hash/identity 不匹配、pending cancellation、未知 executor 或另一未关闭 SDK session 仍阻止 ownership release；不能用 controller adoption 或已停止 owner 替代具体 producer evidence。

明确由写入节点新选择的 artifact destination 可以是 Agent 新创语义；不能仅因字段名为 `path` 就当作输入复制。共享指令检查只排除这类明确新创的路径短语，同句中复制 supplied/input 路径、ID 或 hash 仍失败。read-only 节点不能声明新创文件目的地；其他 Host identity 字段及同名输入路径的直接复制仍受原规则拒绝。

该共同检查按句子分界保留 `result.files` 等 dotted binding 原形；新文件的正向命名/目的地定义不被后缀“never an existing path”否定。显式“omitting unchanged fields”仅排除该否定对象，不等同于要求返回旧值，也不能掩盖同句复制 supplied IDs 的要求。`test/authored-artifact-paths.test.mjs` 覆盖创建、修订、read-only 拒绝和混合复制禁令。

`npm run check` 检查语法、模块闭包和废弃 runtime/model 依赖；`npm test` 覆盖 defaults、bindings、Main evidence、scope、resources、threads、fan-out、SubWorkflow、authoring、recovery、packages、cache、UI transport/refresh 和 native MCP 等离线行为；`npm run check:web` 检查 TypeScript 与构建同步。

明确命名的 pinned `*.schema.json` 文件通过静态 UTF-8/JSON 解析和有限 DataSchema 验证进入 SourceContractIndex；完整 schema 和顶层 property contracts 保留原始文件 hash、JSON Pointer、schema hash、min/max、嵌套约束及 optional 字段。`contract_ref` 使用其准确 semantic schema，不生成 path/hash 文件引用，也不执行 source。普通 JSON 不建立接口 authority；Python lexical artifact observations 保持 candidate。Malformed/unsupported 显式 schema 立即报告准确 resource 和原因。Agent schema 的 optional/nested/camelCase ID、hash、receipt 等仍受 Host-owned guard；只有明确新创 destination 的写入活动可返回新 path。`test/source-contracts.test.mjs` 覆盖这些边界。

同一 SourceContractIndex machine facts（进入现有 review packet）明确 conditional interface applicability：共享方法的条件必须对当前 source kind/mode 成立，且准确 resolved semantic output schema 允许其结果；例如 minItems=1 不支持空列表，明确为 false 的模式不能激活依赖该模式的方法。不能据其他产品的条件分支弱化本产品 schema；若源确实要求与准确接口冲突的行为，应报告 source/Host contract inconsistency，不能忽略行为或要求 planner 重写 machine schema。

Source evidence 投影合并相交/嵌套范围以去重，保留相邻语义 section 和不连续片段，不用 min/max umbrella 覆盖未选段落（包括 legacy compact decode）。准确 selected SourceContract 是其 consumer 的接口证据，完整 schema 可保留完整范围；transition 只保留源 entrypoint 的相邻阶段证据，不继承接口文件。普通 resource_refs 是 read grant，不证明整份文件被消费；registered tool 不因某个选段提及教学文件就继承该 grant。明确的 model source_sections / dispositions / requirement assignments 仍保留，错误选择属于语义 scope 问题，Host 不能自动删改以通过 review。`test/source-evidence-projection.test.mjs` 验证 disjoint spans、接口 consumer、Host tool resource isolation 与明确 broad selection 保留。

两条 retained recheck 入口共享同一来源选择：先验证选定 succeeded attempt 的不可变原始结果，再选 source_attempt_id + source_output_hash 完全匹配的 generation_projection.authoring_plan，其次是准确 matching cumulative ledger，最后是带原始 base 的 raw artifact。只重放完整 semantic blueprint，不将 compiled IR 当作 authoring plan，也不把 patch 再应用到该 patch 已晋升的新 base。匹配 projection 的 hash 冲突在创建 replay Run 前失败；receipt 保留 original result hash 并记录 semantic_source。`test/retained-authoring-plan.test.mjs` 与 public recheck 回归覆盖历史选择、initial/patch projection、冲突、无 planner dispatch 及原始 hash 保留。

`{path,omit_if_missing:true}` 只允许准确 pinned Host-tool input schema 中已声明的 optional 参数。Runtime context projection 单独传入 qualification，缺省 binding resolution 拒绝此 selector；validator 在发布前拒绝 required/unknown/Agent 使用及 default/coalesce/projection 混用。省略仅针对 unavailable 字段，null/false/空内容不被隐式删除，缺失 required 输入仍失败。`test/optional-host-bindings.test.mjs` 验证定义与真实 context projection 的共同边界。

Host compiler 同时验证生产者端：沿 `/inputs/...` 或 `/nodes/<producer>/output/...` 的每层准确 schema `required` 链判断存在性，Host tool 输出使用 pinned output contract 而非 proposal placeholder。只有来源含已声明 optional 路径且消费参数 optional 时自动添加 omission；`result.files`、commit `files` 等完整 required 路径保持严格绑定。未知来源不猜测 optional，也不吞掉缺失错误；重编译会移除旧 compiler 在 required 来源上生成的 blanket omission。`test/scoped-host-finalization.test.mjs` 使用实际 import/compiler 流程覆盖 nested、escaped Root input、required producer/optional consumer 和 required consumer 边界。

Requirement mapping 的 `binding_names` 是活动集合的 coverage 证据，不能推导为每个活动的新增输入。特别是 Host context 输出的 task ID / CAS binding 不得经此路径自动注入明确限定的 Author.inputs；保留 explicit map（包括空 map）及 human-gate subject，只有准确 pinned Host input contract 可驱动缺省 tool 参数推导。`test/study-host-binding-projection.test.mjs` 用公开合成 Study 结构覆盖 initial / repair → 完整 machine gate → projected decode/hash，Author 只接收 context 与 question，Host tools 保留身份与 CAS bindings，不读取私有 Run。

SDK smoke 直接使用 Pi SDK peer dependency 和 faux Provider，验证 extension loader、native child/continuation、当前聊天 follow-up/JSONL 和离线 native MCP；不从 pi-own 寻找 SDK。真实模型调用为零，state 与证据隔离于 `.artifacts/`。不能由这些检查推导真实 OAuth、所有 remote MCP servers、WSL、各 Host 版本或所有模型下的 parallel write/integration 已全面实测。当前功能和待验证边界集中于 `PARITY.md`。

`test/detached-owner.test.mjs` 使用实际 spawned Node processes 验证 parent exit、authority revocation、exact stop/recovery、startup uncertainty 和 publication purge receipt，包括原版允许的 same-controller confirmed authority stop。`test/detached-pi.test.mjs` 使用实际 Pi SDK 和 faux Provider 验证 child 在 parent service 关闭后继续、准确原聊天 reattach、Main tool evidence 和 human final acceptance；另一个完整 authoring case 验证独立 review、准确 hash 人工发布、故意延迟的 cleanup、private Run purge、active RPC flush、owner 停止和失败 terminal notification 的原聊天 durable delivery/acknowledgment。不同 actor 不接收该事件，恢复及后续读取不重复调用模型。无付费模型调用；证据边界单独列在 `PARITY.md`。

`scripts/import-core.mjs`、`adapt-core.mjs` 和 `extend-core.mjs` 记录导入/适配过程，不是普通构建步骤；不要再次覆盖已经适配的 core。后续关键技术栈或产品语义改变必须同步本文件、`AGENTS.md` 和 Pi Skill，保留具体 regression evidence。

0.2.23 的 scoped domain conversion 保留 seed 的 Strict / implicit-deny / no-ambient 策略及写入 sources 路径边界。线性的 qualified Host validated_artifact 终节点在 required boolean guard 成功时承担 finalization，只折叠精确 compiler scaffold；显式源 approval 和用户编辑的 Main finalizer 职责保留。Host tool 默认不额外插入确认步骤，仍受 pinned tool contract、private prepared-task admission 和 source human gates 控制。可选 input selector 由编译器按 exact Host schema 自动添加，不能省略 required 参数。实际 import → compile → certificate → deploy 回归在 test/scoped-host-finalization.test.mjs。

0.2.23 的共享 proposal admission 在 normalization 前使用与 Forge 同一个 `semanticBlueprintQualification(pack,resources,context)`，覆盖 initial、repair、retained recheck 与最终 acceptance。没有传入 selected source contract Map 的 contract_ref 校验明确报 mechanical `AUTHORING_FORMAT`，不产生错误的 semantic repair findings。IR transport 保留 bounded description（最多 16000 字符）、enum/const 无 type 的准确 schema 与八层有界 schema edges；不丢弃 annotation，也不要求模型补写 schema。已经带 Host pipeline hash 的 compiled IR decode 验证准确 DataSchema 而不应用 legacy type/required/closure 推断，仍重新 compile 并比对准确 proposal hash。`test/authoring-parity.test.mjs` 覆盖完整 initial/repair admission、machine gate、corrupt projection 拒绝和原 succeeded attempt 的零 planner recheck。

Workflow modes are default preferences, never installed-library partitions. All installed normal Workflows can be selected in every mode. Optional Host preference hooks preserve per-session CAS; standalone Pi needs no Mode Pack and offers human global switches. Library UI groups enabled/disabled only. Tool/task/source authority remains enforced by each actual capability; switches never publish Drafts or rewrite existing Run pins.

## 0.2.24 — logical Main context parity

The Pi adapter incorrectly equated logical Main with current-chat transport and rejected Strict Main graphs before creating a Run. Logical Main now inherits the live caller model and thinking, while `main_context:auto/current/isolated` controls execution context. Strict nodes use fresh scoped SDK contexts; Cooperative nodes may continue the conversation or explicitly isolate. No Provider rebinding or graph rewriting is needed. The detached parent bridge verifies original actor plus actual execution session; receipts retain stable logical session/call chain and distinct execution journal/model. Completion verifies the selected context receipt and matching real Pi turn; acceptance, lease fencing, cleanup and recovery stay intact. SDK task journals default to the supplied agent directory. `test/isolated-main.test.mjs` verifies actual detached two-node execution, no history/ambient leakage, dispatch-time model inheritance, final acceptance and session disposal. Existing current-chat tests preserve that path.

## 0.2.26: node-level Main responsibility and standalone Pi

Adopt the latest local Codex CAW Main design beyond the fixed migration baseline:
`executor.mode: worker/orchestration`. New unannotated nodes default to worker;
the initiating Agent can propose root-node `main_modes`, validated before admission
and frozen throughout the pinned closure. Historical Run constraints retain their
old context semantics. Both modes inherit the actual calling model and thinking.
Main profiles and orchestration profiles survive semantic decode, Forge and both
automatic/fixed routing; the editor and canvas expose the same contract.

Pi orchestration continues the original chat with its actual native tool catalog.
It can coordinate configured helper Roles within the original node grant, without
an independent Main model binding. Helpers inherit revocable authority and settle
before completion. Metadata-only workspace observation records native effects
without putting repository contents into model context. Cooperative observation
is not an OS sandbox. Existing human acceptance, claims and recovery stay intact.

Plain Pi loads the package's extension, Skill, defaults and Workbench using SDK
peer imports. Course/Mode Pack hooks remain optional. The native smoke exercises
worker → orchestration with actual SDK sessions, extension events, detached owner,
current-chat RPC, native shell and write. It has no pi-own/Next dependency and no
paid model calls. Authenticated application failures keep their original code;
they no longer become a misleading parent-disconnected transport diagnosis.
# Run feedback and retention (0.2.25)

The initiating actor receives model-excluded, deduplicated native `pi-caw:status`
messages with changed node status and deliverable links. Pi Web coalesces them to
one latest card; its existing node inspector remains. Background execution does
not imply invisible execution.

Normal Run process retention is 24 hours after success, configurable 0..720 hours.
Confirmed quiescent failed/cancelled executions clean immediately. Manual cleanup
can clean succeeded executions early. Interrupted, paused, pending, uncertain,
parent-pinned and unpublished authoring records remain protected. A durable small
terminal summary precedes deletion and supports interrupted-cleanup recovery.
Journals, resource copies, private owner process data and exact closed SDK task
JSONL are removed; deliverable paths and native initiating chats are preserved.
`get` reports `process_cleaned`; every execution/recovery operation rejects the
retired identity. One bounded latest cleanup report records actual bytes removed.

Status observation verifies journal/pin integrity without rehashing every copied
resource blob. Execution and cleanup still perform full resource verification.
Progress reads are serialized and track the actor's admitted/recovered normal
Runs; historical private authoring jobs do not flood the teaching chat. Failed
authoring jobs clean only when no retained Run uses that exact job definition,
with revision/provenance CAS and Host-owned workspace scope. A changed/live writer
is protected; an absent exact writer can recover a terminal cleanup transaction.


## 0.2.27: Host-controlled bounded loops

Ports upstream 8db71a32ef16f9ca3fb2dd671f985563e28e563e while preserving Pi's full source-schema qualification, coalesce selectors and authoring review fixes. The scheduler, round budget, artifact observations, parallel ownership, recovery, semantic planner/repair/Forge and canvas/editor/Run views share the loop contract. Bundled authoring contracts upgrade to v30 with user bindings and prompt suffixes preserved; existing Run pins are immutable. Real native Pi SDK smoke exercises two review rounds and in-turn malformed-verdict correction over actual native execution, with final human acceptance pending and zero paid calls. See [loop behavior](LOOPS.md).

## 0.2.28: validation and loop authoring seams

Audits the latest upstream loop baseline (still 8db71a3). Empty semantic collections and placeholders may be omitted with explicit Host normalization; stable-key patches omit unchanged collections. Fresh read-only Main worker exits are eligible without forced Provider switching. Main IR now accepts the already-supported main_mode field. Authoring results use the exact shared compiler/review gate before native submission, with bounded actionable findings visible in the same node turn. Builtin prompt lineage upgrades to v31 while preserving bindings and user suffixes; old Run pins stay unchanged. See [validation audit](VALIDATION.md).

Pi startup now invokes authoring template migration for existing templates only. Historical v29/v30 contracts upgrade to v31; selected Providers, prompt suffixes and user names/tags survive. Deleted templates are not recreated and existing Run pins are untouched.

## 0.2.30: compatible Host updates

Host interface compatibility replaces source-fingerprint equality for qualified tools with an explicit registered contract. Workflows are not republished on program-only changes; each new receipt records the actual implementation identity. Local execution, bootstrap bridge and admission share the same rule. The latest Codex reference also contains exact binding checks plus builtin identity migrations; Pi's previous external-domain extension lacked an equivalent usable upgrade path. Pi now resolves compatible registered implementations at execution while preserving immutable graph/Run evidence. Pre-Run refusals are distinguishable from uncertain dispatch for domain retry. See [validation policy](VALIDATION.md#compatible-host-updates-0230).

### Windows Run initialization

Run initialization writes resources, pins and the start journal directly into the final Run directory, avoiding the directory rename that can fail on Windows. Listing skips unpublished initialization directories; creation can reclaim them under the store writer lock. Existing journals and retained terminal results block recreation. A started journal with missing pins remains an explicit read error. Regression tests cover interrupted initialization, duplicate creation, missing pins and retained deliverables.

### Public fixtures

Private course planner outputs and Skill text were replaced with small fictional documentation fixtures. Artifact destinations, schema optionality, malformed-output diagnostics, source provenance and scoped repair remain covered. Shipped defaults contain only the two portable authoring Workflows. `npm run audit:publication` checks tracked files for common credentials, personal home paths, local session links and private data files.

## 0.3.0: SDK runtime layout compatibility

Replaces fixed dist/adjacent-peer imports with active SDK/AI entry bindings and a same-tree native MCP adapter. Public MCP exports take precedence; trusted Hosts can supply relocated module entries and local loader hooks. Detached workers receive the exact bindings and verify SDK package identity/version. Source-only and stale-dist fixtures exercise real offline SDK interfaces and detached child/Main execution. See [runtime bindings](SDK-RUNTIME.md).

## 0.3.1: private execution session lifecycle

Temporary SDK workers, including isolated Main, use per-Run `execution-sessions` directories in plugin state rather than the Pi session catalog. Parent Main bridges and detached workers share this storage binding. Durable JSONL remains available for exact recovery and inspection until normal Run retention commits its terminal summary. Successful independent Roles save the result, confirm task closure and retire their transcript through a recoverable hash-bound cleanup intent. Failed and uncertain Roles retain evidence. Explicit threads survive Run cleanup, including old receipts and interrupted historical cleanup intents; the initiating chat remains untouched.

Offline real SDK regressions cover detached isolated Main, Role success/failure, native thread continuation and scoped history listing. Cleanup tests cover durable results, changed bytes, parent-path rejection and interrupted retries. No paid model calls are used.
