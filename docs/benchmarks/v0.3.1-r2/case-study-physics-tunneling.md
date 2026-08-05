# Preselected Case: Physics Tunneling / Full / Repetition 1

> 状态：已发布的运行前预选案例。不得因结果替换案例。

问题、证据要求和解释边界与 [v0.3.1 预选模板](../v0.3.1/case-study-physics-tunneling.md) 完全一致。

## 已发布事实

- execution：`benchmark-execution:e16b8aa7-2f63-444b-9aec-bfcc3aeb426d`；
- cell：`benchmark-cell:4cab80cefd5910ec6021b7df48d402771a42bc7147303ec824018b822282f1a1`；
- attempt：`benchmark-attempt:b9011105d913e64cd022568b875ee6941a64d9661feb4b9121095cba8ca852cd`；
- terminal：`diagnostic_failure / proposal_missing`；
- metrics：1 次 baseline、0 次工具调用、0 tokens、5,720 ms；
- proposal、verdict、access receipt、candidate execution 与 comparison 均不存在；
- score：grounded success false、mechanism correct false、incorrect confirmation false、verdict
  `inconclusive`；
- case bundle 完整度为 `partial`，原因为 `diagnostic_attempt_has_partial_flow_evidence`；
- report Gate 为 fail。

case bundle hash 为 `c2afcb3a99755a94a8313e2ac7ff501d417c337ec74321d7e579580f12406b5d`。
该案例只证明 baseline 与 partial flow 被封存、Agent 没有提交 proposal；它没有 replay、干预或比较证据，
因此不能定位 physics tunneling 机制，也不能作为 ChronoRift full arm 成功案例。

缺少 matching replay、realized control、comparison 或 receipt 时必须 inconclusive；confidence 不参与
裁决。不得用隐藏 oracle、原 v0.3.1 中止 cell 或其他 repetition 补写缺失证据。
