# r3 预执行协议

本文定义 `v0.3.2-luna-r3` 的计划边界。它不是 machine spec，也不证明任何步骤已执行或通过。

## 1. 单一变更维度

r3 保持 r2 的 4 个 Fixture、3 个 arm、3 次 repetition、盲化 prompt、Luna Max、单并发、工具权限、
预算、retry policy、metric set、预选案例和产品 Gate 问题不变。计划中的唯一主要语义变化是 receipt
coverage 分类修复；最终 material/model metadata 仍必须由 r3 machine spec 重新计算并固定，不能复制
r2 hash。

r2 的触发事实是：case 02 generic r3 的 7 次工具调用全部成功，proposal 被工具接受且
`mechanismCode` 正确；proposal 引用了 baseline events，却遗漏对应 raw baseline receipt。Conclusion
Gate 已将证据不足反映为 blocker，但 post-run terminal validator 又把相同缺口升级为
`harness_failure`，使唯一 execution 在 5/36 cells 后成为不可恢复的 `invalid`。

## 2. Receipt coverage 分类契约

计划修复必须同时满足以下不变量：

1. Agent 仍须显式提交所依赖的 Session-local receipt handle；Harness 不自动补入 `@r1`，也不从工具
   调用历史推断 Agent 已引用某项证据。
2. 每个 proposal ID、event ID 和 receipt ID 仍须解析到当前 investigation 中的精确对象；伪造、未知、
   跨 investigation 或内容不匹配的引用继续 fail closed。
3. 当 event 本身可解析，但 proposal 没有显式引用覆盖它的 raw-execution 或 Capsule receipt 时，这是一项
   evidence-admissibility blocker。Conclusion Gate 必须返回 `inconclusive`，且
   `groundedSuccess=false`；模型 confidence 或机制判断正确不能覆盖该 blocker。
4. 对上述“可解析但 coverage 不足”的 proposal，terminal validator 必须验证 blocker/verdict 与原始
   receipt 集一致，并将其保存为可计分的负向诊断结果；不得在 post-run 阶段重新分类为
   `harness_failure` 或使整个 execution `invalid`。
5. `confirmed` verdict 若缺少相同 coverage，或 raw manifest 隐藏/篡改该 blocker，仍属于 Harness
   integrity failure，必须拒绝封存。
6. Conclusion Gate、raw manifest seal、sanitized scoring proof 和独立 verifier 必须使用同一 canonical
   coverage policy；任何一层出现不同结论都 fail closed。
7. 修复不放宽 source grounding、Failure Brief、replay、candidate、comparison、lineage、预算或
   canonical verdict 的其他要求。

这一区分保留两条边界：Agent 的证据不足是被测诊断结果；Harness 无法证明自身 artifact 一致性才是
Harness failure。

## 3. Freeze 前离线门槛

在真实 canary 前必须：

- 用 [reproduction.md](reproduction.md) 的 fixture 在旧策略下复现 r2 分类错误；
- 证明同一输入在新策略下稳定得到带 canonical blocker 的 `inconclusive` 与
  `groundedSuccess=false`；
- 覆盖 unknown receipt、cross-investigation receipt、confirmed-without-coverage、blocker 被删除、
  manifest/proof 篡改等反例；
- 验证完整 coverage 的历史 scored path、`invalid_proposal` 预算例外和 r1/r2 已发布报告重验不回归；
- 通过 `corepack pnpm check`，并在需要 Godot 的边界通过 `corepack pnpm test:godot`。

离线门槛只证明实现行为，不授权 machine-spec freeze 或 formal execution。

## 4. Canary 010

canary identity 预注册为 `v0.3.2-luna-canary-010`。计划沿用两阶段真实 Pi 路径：

| Stage | Fixture             | Arms                                      | 当前状态 |
| ----- | ------------------- | ----------------------------------------- | -------- |
| C0    | `signal-ordering`   | generic / evidence-only / chronorift-full | 未运行   |
| C1    | `physics-tunneling` | generic / evidence-only / chronorift-full | 未运行   |

C0 必须绑定干净 implementation commit、source hash、model receipt 和完整 canary spec。无论结果是否
ready，都先原样封存并由独立 verifier 检查。只有 C0 为 `ready` 且
`prerequisiteEligibility=hardened` 时，才可运行 C1；C1 必须精确绑定已发布 C0 report hash。

freeze 的 canary 前置要求 C0/C1 均为 `ready` / `hardened`，六个 cells 均 `scored`、mechanism correct，
并保持零 tool errors、零连续无语义进展结果、零 incorrect confirmations；每个 cell 还须满足冻结的
source-grounding receipt 要求。若 010 任一阶段失败或中断，保留其真实状态，停止 freeze，并为后继使用
新 canary identity；不得覆盖、拼接或重复挑选 010。

## 5. r3 identity 与 freeze

预注册值：

- campaign：`v0.3.2-luna-r3`；
- order seed：`chronorift-v0.3.2-luna-r3-formal-1`；
- local annotated tag：`v0.3.2-luna-r3-benchmark-freeze`；
- matrix：4 fixtures × 3 arms × 3 repetitions = 36 cells；
- provider/model：`openai-codex/gpt-5.6-luna`，`thinkingLevel=max`；
- preselected case：case 03 / chronorift-full / repetition 1；
- budgets：baseline 1、replay 1、intervention 2、source 4、game 4、tool 12、tool errors 0、连续无进展 0、
  timeout 600 秒、concurrency 1；
- Gate：full grounded successes ≥ 9/12、full − generic ≥ 0.20、full incorrect confirmations = 0，且每个
  arm 必须有 12 个 score-eligible cells。

suite/definition/subject/runner hash 现在均未知。只有以下条件全部满足后才能生成并提交 machine spec：

1. coverage 修复和回归位于干净 implementation commit；
2. canary-010 C0/C1 的 hardened evidence 已发布并与该实现绑定；
3. spec 由代码确定性生成，人工审核 material、model metadata、budgets、seed、Gate 与 preselected case；
4. 重建测试逐字节或按 canonical hash 证明 spec 与实现一致；
5. annotated tag 精确指向包含上述实现、evidence、spec 与测试的同一个干净 commit。

tag 创建前的文本约定不能替代这些条件。

## 6. 唯一 formal execution

freeze 后才允许创建一个 first-selection execution。selection 持久化后只可按 Harness 返回的
`recoverable` 状态恢复同一 execution ID；不得创建第二个 execution、移动 tag、修改 spec 或清理负向
cell。terminal 状态无论 `complete`、`incomplete` 或 `invalid` 都应原样发布，并分别运行 report verifier
和 Gate。

## 7. 36-cell 成功判据

“评测管线完整”和“产品 Gate 通过”分开报告：

- 管线完整：唯一 execution 为 `complete`；36/36 cells 均有 terminal cell；每个 arm 恰有 12 cells；
  aggregate 非 `null`；publisher 产物通过独立 verifier 且 `issues=[]`。即使个别 cell 因冻结的重试策略
  耗尽而成为 `infra_unavailable`，也必须原样计入，不得冒充 score-eligible evidence。
- treatment coverage 完整：三个 arm 各有 12 个 score-eligible cells，且 preselected case 有匹配 raw
  manifest。缺少该覆盖时 Gate 可以给出 `fail`，但不得把局部 cell 外推成 treatment 结论。
- 产品 Gate 通过：在管线完整且 treatment coverage 完整的基础上，chronorift-full grounded successes ≥ 9/12、full − generic
  grounded-success rate ≥ 0.20、full incorrect confirmations = 0。
- 证据边界：即使 Gate 通过，也只支持当前冻结模型、四个校准 Fixture 与该协议内的比较；不能外推为
  任意 Godot 项目、统计显著性或相对通用代码 Agent 的“绝对优势”。

若 36 cells 完整但 Gate 失败，应发布完整且可验证的负结果；若缺 cell、aggregate 为 `null` 或 verifier
失败，则不得描述为 36-cell treatment 结论。
