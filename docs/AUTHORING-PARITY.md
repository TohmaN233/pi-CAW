# Authoring 能力与迁移验证

来源固定为 `docs/upstream.json` 记录的原版 commit。Authoring 的语义蓝图、稳定 key 修复、确定性 compiler、checklist 和 source-free conversion 保留导入的 core 契约。模型传输和会话执行改为 Pi；默认 Provider slot 的模型绑定仍为空。

| 原版能力 | Pi 实现与边界 |
| --- | --- |
| Skill / brief 两种 authoring Workflow | `system.skill2workflow` 和 `system.build-workflow` 是持久化、可编辑的模板；Host topology 和 compiler 契约受校验保护。 |
| Prompt preview | `authoring_prompt_preview` 显示隔离后的 planner/reviewer request、资源路径和输出 schema，不调用模型。 |
| 固定来源开始 authoring | `start_authoring` 固定 source revision、template revision、routing 和显式 Provider，私有 job 使用共同 Run store。登记前再次检查 source HEAD。 |
| Planner → Host compiler → reviewer | Planner 返回语义 inventory；Host 执行 graph assembly、execution binding、deterministic validation；reviewer 使用固定的独立 Pi child。 |
| Independent review | `pi-sdk-authoring-review` receipt 绑定 canonical proposal hash、source revision 和 planner attempt；reviewer 获得 compiler 投影后的 proposal 与 future-Run input schema。 |
| 自动与人工语义修复 | 导入的 `generation-repair` 保留 bounded rounds、稳定 key 修复、累计 plan ledger、非改善反馈停止和 `continue_authoring` 人工指导。Host/compiler 问题不会伪装成语义重试。 |
| 已完成 planner 的确定性 recheck | `recheck_authoring` 创建新 Run，登记 `host-generation-replay` 和原始 artifact identity，再运行当前 compiler 与独立 reviewer。修复 delta 先恢复为完整 plan；成功 recheck 不增加 planner 调用。 |
| 已持久化 reviewer 的 recheck acceptance | `accept_rechecked_authoring_review` 重新校验曾被 Host checklist 拒绝的、已关闭会话的 exact reviewer artifact；必须通过当前 checklist 并由人接受。两个模型都不重新调用。 |
| 人工验收与 source CAS | `accept_authoring` 必须传 `accepted: true` 与所展示的 `proposal_sha256`。来源、当前 review contract、canonical proposal 和 durable human receipt 全部校验后才发布。source HEAD 冲突在 final 验收之前拒绝。 |
| Source-free publication | 使用 `applyExpansion` / `compileDeployableConversion`，保留 conversion certificate 和可移植资产，移除私有 source entrypoint、来源路径及 canonical source proposal。 |
| 发布后清理与重试 | 精确 accepted deployment 先登记清理 journal，再清 source history、Host-owned workspace、private job 和 accepted Run。未结束的同来源 authoring Run 会阻止 history purge；已提交的 publication 和未完成步骤保持可见。`purge_authoring_artifacts` 可继续同一事务。 |
| 用户 workspace | 明确传入的 workspace 属于用户，清理不会删除其内容；结果列出 `retained_user_workspace`。仅 `state/authoring-workspaces/<run_id>` 的精确 Host-owned 路径可删除。 |

Authoring 的逻辑 `final` 是 Host publication 边界，由独立 reviewer 的 receipt 加人工验收完成。普通 Workflow 的 Main 继承当前 Pi 聊天的模型与 thinking，可隔离上下文或继续原对话。原版 Codex app-server / managed login /独立 Codex Main 接口由 Pi 的原生认证与会话机制替代。

离线端到端验证位于 `test/authoring-parity.test.mjs`，通过可编程 Host fixture 使用真实 store/runtime/compiler/checklist 和 durable receipt；真实模型调用数为零。覆盖正常 authoring、三个 Host stage、独立 review identity、错误 SHA、source revision 冲突、发布与全步骤清理、已完成 planner recheck、累计 delta materialization、清理冲突及事务重试、saved reviewer recheck、用户数据保留。相邻 service/default/fan-out/SubWorkflow 回归与 `npm run check` 同时通过。

0.2.27 adds shared loop-aware semantic inventory, stable-key loop repair and deterministic Forge lowering. Explicit source-required review/repair is a bounded region, not a prose instruction or local retry. Source-free publication retains loop definitions and Host item projections. Existing saved plans without loops remain valid; repair materialization supplies an empty loop collection.
