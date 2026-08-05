# ChronoRift v0.3.2 作品集摘要

## 一句话介绍

ChronoRift 是基于 Pi SDK 的 game-native Agent Harness：它把 Godot 运行时 Bug 转换为带
Contract、checkpoint、replay、单变量 intervention 和可重算 verdict 的受控实验，而不是仅让
大模型阅读代码和日志。

## 我做了什么

- 用 strict TypeScript 和 pnpm workspace 建立
  `domain ← gamebranch ← adapters ← CLI` 单向依赖，隔离 Pi、Godot 和持久化类型。
- 实现四个可执行 Godot runtime-Bug Fixture：Signal 连接顺序、frame/time 混淆、physics
  tunneling 和 entity incarnation 复用。
- 将冻结 Contract、checkpoint/restore、strict replay、单变量实验、canonical comparison、
  Evidence Capsule 和 Conclusion Gate 串成真实 Pi Session/Agent Loop。
- 设计 generic、evidence-only 和 chronorift-full 三组盲化 treatment，prompt 与失败描述
  byte-identical，仅工具能力不同。
- 实现 Benchmark V3 的 typed provider failure、结构化单调 progress、3+3 recovery、strict
  terminal manifest、append-only seal、sanitized scoring proof 和独立 verifier/Gate；verifier 重算
  frozen material、引用、机制、评分与 per-kind budgets。
- 将 Pi 诊断工具设为 sequential，冻结每 cell 12 次工具调用、0 次工具错误、0 个
  连续无语义进展结果；用 Session-local `@rN` handle 降低长 receipt ID 转录错误，再由
  Harness 解析回精确 canonical ID 并严格 grounding。

## 现有真实数据

- GPT-5.6 Luna 真实 Pi smoke 连续两次通过：每次 5 次工具调用，30,828 / 30,039
  total tokens，Harness verdict 均为 `confirmed`；`test:live` 随后通过。
- 三份早期 C0 canary 均为 `not_ready`，已作为负向工程证据原样保留，没有删除或
  cherry-pick。
- C0-004 三组均 mechanism correct；generic/evidence-only 为 `inconclusive`，full 为
  `confirmed`；工具调用 7/5/8，total tokens 62,667/31,150/73,722。
- 同 identity C1 physics-tunneling 三组均 mechanism correct 且均为 `inconclusive`；工具调用
  7/5/8，total tokens 92,310/49,464/111,558。full 完成 matching replay、一项 intervention、
  一次 comparison 与 proposal。
- 004 C0/C1 共六个 cells，全部为零 tool errors、零无进展违规、零 incorrect confirmation；但两份
  V1 报告缺少 implementation receipt，强化 verifier 只将其前置资格归为 `legacy_only`。
- implementation-bound 005 C0/C1 共六个 cells 均为 `scored`、mechanism correct、零 tool errors、
  零无进展违规、零 incorrect confirmation；两份报告均通过强化 verifier 并取得 `hardened` 前置资格。
  C1 精确绑定 C0 report hash
  `0c5ef20c0e8f16ee9d93175b36cb7b1fb85f9514c6d06e5267b3c9f7974545c1`。
- r1 正式 execution 已原样发布 `invalid` 负结果：3 cells 中 2 scored、1 `harness_failure`，2 个
  scoring proofs、aggregate `null`；verifier 通过，Gate `not_evaluated` / exit 2。
- 独立 r2 后继的 008 C0 同样原样保留：report hash
  `d1461034624816e2946a9e0f617c18a4ce9c76818230472d7faf5c96a7217caf`，readiness 为 `not_ready`、
  前置资格为 `not_eligible`。generic 错误复制 baseline execution ID 并产生一次 tool error；full 没有
  source receipt。C1 未启动，008 不复用。

完整证据、hash 和状态边界见 [v0.3.2-luna evidence workspace](benchmarks/v0.3.2-luna/README.md)、
[r1 workspace](benchmarks/v0.3.2-luna-r1/README.md) 与
[r2 workspace](benchmarks/v0.3.2-luna-r2/README.md)。

## 这个项目体现的能力

- 将“Agent 能回答”与“系统有证据确认”分开；confidence 不能覆盖 Contract 和引用
  完整性。
- 在真实模型、游戏进程和可恢复持久化之间设计 fail-closed 边界，区分诊断失败和
  infrastructure failure。
- 对负结果与中间失败保持可审计性，不通过重跑或选择性发布美化 benchmark。

## 简历可用表述

> 独立设计并实现基于 Pi SDK 的 Godot 运行时诊断 Harness，通过 Contract、checkpoint/replay、
> 单变量实验、因果证据与 Harness Gate 约束 LLM 结论；建立 4 类 runtime-Bug、3-arm 盲化
> benchmark 与 append-only 证据链；在 GPT-5.6 Luna 的历史 C0/C1 六个 canary cells 中实现零工具
> 错误与零错误确认，并进一步完成 implementation-bound 005 C0/C1；两阶段均为 `ready`，verifier
> 前置资格均为 `hardened`，并以可重建 machine spec 冻结 36-cell protocol；原 execution 因引用
> 完整性失败未形成报告；修复后 007 C0/C1 再次达到 `ready` / `hardened`，独立 r1 spec/tag 已冻结，
> 并原样发布 3-cell `invalid` 负结果，完整性可验证但 Gate 未评估；继续保留 r2 008
> `not_ready` / `not_eligible` canary，未通过重跑或选择性发布隐藏失败。

## 边界

005 C0/C1 与原 V3 machine spec freeze 已完成。旧 selection 有 36 组 started/finished/cell，但 3 个
unresolved event references 阻止 completed/report；它不是可发布 formal 结果。007 C0/C1 与 r1 freeze
已完成；r1 报告虽通过 verifier，但只有 3 cells、aggregate `null`，产品 Gate 为 `not_evaluated`。该结果
暴露的是 `invalid_proposal` 的预算分类漏项，不证明 ChronoRift 相对 generic Agent 已有统计优势。
008 C0 又暴露 generic 的 `invalid_tool_flow` 和 full 的 source-grounding 缺口；C1 未启动，008 不得复用。
009 仅是测试修复后的下一候选 identity，尚未创建或运行。Fixture 仍是同一代码库内的校准小场景，
不得外推为任意 Godot 项目即插即用；后继 formal 尚未完成。
