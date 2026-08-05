# Preselected Case Study: Physics Tunneling / Full / Repetition 1

> 状态：**运行前预注册；v0.3.1 formal execution 尚未开始。** 本案例不得因结果失败、incomplete 或
> inconclusive 而替换成其他 Fixture、arm 或 repetition。

## 预注册问题

冻结 Contract 要求 projectile fired 后 target 在规定 physics window 内被击中。baseline 低 physics TPS
失败；隐藏 oracle 机制为 `discrete_physics_tunneling`。预期的单变量证伪实验是提高 physics TPS。

本案例要回答：full arm 在看不到 oracle、真实 Fixture 名和真实源码路径的条件下，是否读取 Capsule、
执行 matching replay、运行单变量 intervention、读取 canonical comparison，并提交一个能被 Harness
证据门确认的正确机制？

## 结果填写规则

正式发布后，只能从 `benchmark-report.v2.json` 与
`case-physics-tunneling-full-r1.json` 填入：

- suite/definition/execution/cell/attempt identity 与 freeze provenance；
- baseline Contract outcome、observation health、checkpoint coverage 与 Capsule；
- 按 bundle 顺序出现的 access receipt、replay、candidate 与 comparison；
- proposal mechanism、source locus、confidence、canonical verdict、blocker 和 next experiment；
- `evidenceCompleteness` 与 unavailable reason；
- cell score、aggregate 和 Gate 中与本案例直接相关的事实。

不得粘贴 credential、prompt、源码正文、Pi Session 路径或未发布 raw ledger。partial/unavailable bundle
不能根据 token count、日志邻接、oracle 或其他 repetition 重建工具调用。

模型 confidence 不参与 verdict。没有 matching replay、realized control、可比 candidate/comparison 或
有效 receipt 时，即使机制文字正确且 confidence 为 1，也必须保持 `inconclusive`。若没有 proposal，
不能把隐藏 oracle 改写成 Agent diagnosis。

## 解释边界

单个案例不证明跨项目泛化、统计显著性、自动修复能力或相对其他产品的优势。最终叙事必须与完整
36-cell report 和独立 Gate 一致；负结果同样保留。
