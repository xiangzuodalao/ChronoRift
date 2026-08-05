# ChronoRift v0.3.2 作品集摘要

## 一句话介绍

ChronoRift 是基于 Pi SDK 的 game-native Agent Harness：它把 Godot 运行时 Bug 转换为带冻结
Contract、checkpoint/replay、单变量 intervention、证据引用和 Harness verdict 的受控实验，而不是只让
模型阅读源码与日志后自由作答。

## 我做了什么

- 用 strict TypeScript 与 pnpm workspace 建立
  `domain ← gamebranch ← adapters ← CLI` 的单向依赖，隔离 Pi、Godot、存储与核心规则。
- 实现四个真实可执行的 Godot runtime-Bug Fixture：Signal 连接顺序、frame/time 混淆、离散物理
  tunneling 和 entity incarnation 复用。
- 将 Contract、checkpoint/restore、strict replay、单变量实验、canonical comparison、Evidence Capsule
  与 Conclusion Gate 串入真实 Pi Session/Agent Loop。
- 设计 generic、evidence-only、chronorift-full 三个工具 treatment；冻结 Fixture、模型、prompt、预算、
  顺序种子和评分规则，并让 Harness 而非模型 confidence 决定是否 `confirmed`。
- 实现 36-cell Benchmark V3：typed failure、单调 progress、可恢复执行、write-once terminal seal、
  sanitized scoring proof、独立 verifier 和产品 Gate。Agent 的无效 proposal 作为局部 diagnostic failure
  留在矩阵中，真正的 Harness/lineage 损坏仍 fail closed。
- 用 Session-local `@rN` handle 降低模型抄写长 receipt ID 的错误，再在 submit 边界解析为 canonical ID，
  校验 run、fixture、artifact、event、receipt 与 source coverage 的 investigation 归属。

## r4 正式 Benchmark：完整，但产品 Gate 未通过

唯一 r4 formal execution
`benchmark-execution:22c2dee9-e508-41fe-b0db-2e90de8a2b7b` 已完整封存 **36/36** 个 cells：
30 个 `scored`，6 个 `diagnostic_failure`（5 个 `invalid_proposal`、1 个 `invalid_tool_flow`），无
infrastructure-unavailable cell。独立 verifier 返回 `issues=[]`，证明公开报告可由冻结材料重算；这只说明
证据链完整，不代表产品指标通过。

| Arm             | Grounded success | Mechanism correct | Incorrect confirmation | Total tokens |
| --------------- | ---------------: | ----------------: | ---------------------: | -----------: |
| generic         |             6/12 |             11/12 |                      0 |    1,103,071 |
| evidence-only   |             0/12 |             10/12 |                      0 |      540,781 |
| chronorift-full |             6/12 |              9/12 |                      0 |    1,213,944 |

冻结 Gate 的两个优势阈值都未达到，因此结果是 **fail**：

- `chronorift-full` grounded success 为 6/12，低于要求的 9/12；
- full 与 generic 的 grounded-success rate 都是 0.50，差值为 0，低于要求的 0.20。

这轮结果说明 36-cell pipeline、局部失败分类、不可变发布与独立验证已经跑通，也说明当前 full treatment
没有测得相对 generic treatment 的优势。六个 diagnostic failures 全部保留为可计分的零分结果，没有通过
重跑、删格或模型 confidence 美化结论。

## 对照组应如何解释

本 benchmark 的 `generic` 是**同一 Pi SDK / GPT-5.6 Luna Agent Loop 下的工具消融 arm**：它与其他
arms 共享冻结的模型、prompt、Fixture、预算和评分规则，只获得较通用的诊断工具集合。它不是 Claude
Code、Codex CLI，也不是对这些产品的代理测量。

因此，r4 不支持“ChronoRift 优于 Claude Code/Codex”或“game-native Harness 已具有统计优势”的表述。
只有 4 个仓库内校准 Fixture、每个 arm 12 cells，且没有独立项目、不同模型或多次 campaign 的重复验证；
不能声称统计显著性、跨项目泛化或即插即用的任意 Godot 调试能力。

## r3 负向审计轨迹

r3 的 canary-010 已 `ready/hardened`，但唯一 formal execution 在 **16/36** 后不可恢复地变成
`invalid`：11 个 `scored`、4 个 `diagnostic_failure`、1 个 `invalid/harness_failure`，没有 aggregate 或
可解释的产品 Gate。

根因不是 provider 或 Godot 故障。case 03 / generic / repetition 3 的模型把 `runId` 抄错一个字符；旧
submit tool 只校验 Capsule 与 baseline，没有在入口校验 proposal 的 `runId/fixtureId`。Conclusion Gate
先安全地给出跨 investigation 的 `inconclusive` blockers，terminal integrity 随后才发现绑定错误并使整个
campaign fail closed。冻结 publisher 又因 public receipt projection 遗漏 `schemaVersion: 1` 而拒绝发布。
r3 没有通过绕过 provenance 生成伪报告，其 spec、tag、selection 和本地 invalid ledger 均保持不变。

r4 针对这两点增加了边界回归：scope 错误在 submit 时成为 cell-level
`diagnostic_failure/invalid_proposal`，后续 cells 继续运行；public projection 保留 receipt schemaVersion。
r4 的 36/36 完成证明这些 Harness 阻塞问题已解除，但 Gate fail 同时表明“能完整测量”和“产品具有优势”
是两件不同的事。

## 可核验的证据

- [r4 machine spec](benchmarks/v0.3.2-luna-r4/benchmark-spec.v3.json)：冻结 4 × 3 × 3 矩阵、模型、
  budgets、Gate 与 order seed。
- [r4 formal report](benchmarks/v0.3.2-luna-r4/benchmark-report.v3.json)：report hash
  `7aef5376cca43bfd01bdef8ca46b73357c9d5608c83295ba9812de80dd897b2f`，selection hash
  `fd5faf448e71cbd8156ca4c202f70dc9074b67b32830634f796ba722e463eaf0`，status `complete`。
- [r4 generated results](benchmarks/v0.3.2-luna-r4/results.md)：arm 与 Fixture × arm 的公开汇总。
- [r4 preselected public case](benchmarks/v0.3.2-luna-r4/case-physics-tunneling-full-r1.json)：预注册
  case 03 / full / repetition 1 的脱敏 scoring proof。
- [r4 C0 canary](benchmarks/v0.3.2-luna-r4/canary-c0-ready-011.json) 与
  [r4 C1 canary](benchmarks/v0.3.2-luna-r4/canary-c1-ready-011.json)：formal 前的真实 Pi/Godot
  `ready/hardened` 证据。
- [r4 boundary regression protocol](benchmarks/v0.3.2-luna-r4/reproduction.md)：proposal scope 与 public
  receipt projection 的最小复现和修复 oracle。
- [r3 negative workspace](benchmarks/v0.3.2-luna-r3/README.md) 与
  [r3 reproduction protocol](benchmarks/v0.3.2-luna-r3/reproduction.md)：16/36 invalid 终态、hash、未发布
  边界与后继修复依据。
- [r2 immutable negative report](benchmarks/v0.3.2-luna-r2/README.md)：更早 receipt coverage 分类缺陷的
  write-once 审计证据。

r4 formal 使用本地 annotated tag `v0.3.2-luna-r4-benchmark-freeze`，对应 clean commit
`c03237bea8c9767aa8a956d4e3db9a17e680ad94`；报告记录 GPT-5.6 Luna、Pi `0.83.0`、Godot
`4.7.1`、requested/mapped thinking level `max`。这些 provenance 字段可验证本次执行身份，但不能扩大
实验外推范围。

## 这个项目体现的能力

- 将“Agent 给出正确 mechanism”与“证据足以 canonical confirm”分开；本轮 mechanism correct 为
  11/10/9，但 grounded success 只有 6/0/6，正好展示这条边界。
- 在真实模型、Godot 进程、checkpoint/replay 与持久化之间设计 fail-closed trust boundary，并区分
  diagnostic、tool-flow、infrastructure 与 Harness integrity failure。
- 对正负结果使用同一冻结 protocol 与独立 verifier；完整发布 Gate fail，而不是只展示成功个例。
- 从 r2 receipt coverage、r3 proposal scope/publisher projection 两轮真实失败中提取离线回归，再用新
  campaign identity 验证修复，不改写历史 artifacts。

## 简历可用表述

> 独立设计并实现基于 Pi SDK 的 Godot 运行时诊断 Harness，以 strict TypeScript 构建 Contract、
> checkpoint/replay、单变量实验、Evidence Capsule、Conclusion Gate 与 write-once Benchmark V3；在
> GPT-5.6 Luna 上完成 4 类 runtime-Bug × 3 工具 treatment × 3 repetitions 的 36-cell 正式执行，
> 独立 verifier `issues=[]`、零错误确认；如实发布产品 Gate fail（full 6/12，generic 6/12），并将 5 个
> invalid proposal 与 1 个 invalid tool flow 作为局部失败保留；通过 r3 的 16/36 invalid 负向审计定位
> investigation scope 与 public receipt projection 缺陷，修复后使 campaign 完整运行且保持历史证据不可变。

## 边界

r4 证明的是该冻结环境下的 pipeline completion、证据可重算性和失败分类，不是 treatment 优势。generic
只是工具消融对照，不是 Claude Code/Codex；当前样本不支持统计显著性、跨仓库泛化或商业产品对比。
Fixture 仍是同一代码库中的校准小场景；自动修复、视觉、多 Agent、复杂 World Graph 和广泛真实项目验证
仍不在 v0.3.2 的已实现范围内。
