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

完整证据、hash 和复现顺序见
[v0.3.2-luna evidence workspace](benchmarks/v0.3.2-luna/README.md)。

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
> 错误与零错误确认，并进一步通过 implementation-bound hardened 005 canary 与 raw-to-proof
> verifier；36-cell 正式评测待执行。

## 边界

Hardened 005 canary 已完成，因此 freeze 的 canary 前置已满足；36-cell Luna formal campaign 和产品
Gate 仍是 **pending**。当前数据证明工程链路与 canary 运行事实，不证明 ChronoRift 相对 generic
Agent 已有统计优势。Fixture 仍是同一代码库内的校准小场景，不得外推为任意 Godot 项目即插即用。
