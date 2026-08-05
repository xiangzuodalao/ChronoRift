# ChronoRift v0.3.2-luna Benchmark V3 Protocol

本协议定义 v0.3.2-luna 的 canary 和 formal 评测语义。历史 C0/C1-004 的 readiness 字段为
ready，但强化 verifier 只把其 V1 linkage 归为 `legacy_only`；implementation-bound C0/C1-005
均已 `ready`，前置资格为 `hardened`。
本文仍是待与 machine spec 一起冻结的协议，不是已完成的 formal 结果。

## 1. 历史不可改写

v0.3、v0.3.1 与 v0.3.1-r2 的 schema V2 spec、selection、attempt ledger、report、canonical
hash 与 verifier 保持原样。V3 使用独立 schema、repository 和 campaign identity，不对历史数据
进行 migration、rehash 或结果替换。

## 2. 预注册身份

- campaign：`v0.3.2-luna`；
- freeze tag：`v0.3.2-luna-benchmark-freeze`；
- order seed：`chronorift-v0.3.2-luna-formal-1`；
- provider/model：`openai-codex/gpt-5.6-luna`；
- model metadata：272,000 context window、128,000 max output；
- thinking：请求 `max`，Pi 映射值必须为 `max`；
- 矩阵：4 Fixture × 3 arm × 3 repetitions = 36 cells；
- 顺序：按 Fixture/repetition block 随机化，每 block 内 arm 顺序由冻结 seed 决定；
- sampling seed：不可用，三次 repetition 不声称独立可复现的模型样本。

三个 arm 继续使用 byte-identical prompt 和 `FailureBriefV1`，仅 active tool set 不同。源码只以
`case/main.gd` 中性虚拟视图暴露，隐藏 oracle 只在 proposal 提交后评分。

## 3. 冻结预算与工具流

每 cell 预算为 baseline 1、replay 1、intervention 2、source call 4、总游戏执行 4、总工具
调用 12、工具错误 0、连续无语义进展结果 0、墙钟 600 秒、并发 1。provider 内部
重试为 0。

所有 Pi 诊断工具使用 sequential execution mode。Agent 必须先读取 active baseline 证据，再完成
active replay，然后才能列出/执行单变量实验；compare 只接受本 Session 实验返回的 candidate。
第一个工具错误或第一个无语义进展工具结果就终止当前 Agent Loop，防止非有效轮询消耗
时间与 token。

每次证据或源码访问仍产生 content-addressed `EvidenceAccessReceiptV1`。为减少模型转录长 ID
时的错误，工具另返回 Session-local `@rN` handle。handle 不是新 artifact；Harness 在 proposal 边界
将其解析为同 Session 的精确 receipt ID，再执行完整的引用重验。

score-eligible 终态必须携带 strict raw manifest，绑定 frozen Contract/InputTrace/source view/
intervention catalog/oracle、canonical Failure Brief receipt、终态 progress/metrics 与 Agent proposal。
verifier 从 raw manifest 和公开的 prose-free scoring proof 分别重算 replay、intervention 与 source-call
预算；报告 hash 自洽不能替代这些事实检查。

## 4. Typed provider failure 与 progress

provider adapter 仅在边界把错误归类为结构化事实：

- phase：`request` 或 `response_stream`；
- code：`connection`、`timeout`、`http_408`、`http_429`、`http_5xx`、`auth`、
  `model_not_found`、`non_retryable_4xx`、`provider_error_unknown` 或 `aborted`；
- `httpStatus`：可验证时记录，否则为 `null`；
- retry class：`transient`、`permanent` 或 `unknown`。

progress 快照分别记录 fixture stage，model request/output/turn/tokens，tool
started/completed/failed/semantic revision，baseline/diagnostic game executions 和 proposal submitted。
每条 journal 都必须序列连续、计数不倒退，finished attempt 不得少报已持久化进展。

## 5. 3+3 recovery 与评分资格

首轮为 ordinals 1–3，仅在“无诊断进展 + transient infrastructure failure”时继续。仅有一个
recovery cycle，ordinals 4–6 重复同一规则。任何 permanent/unknown failure，或任何已有
model output、tool start、diagnostic game execution 或 proposal 后的基础设施失败，都立即终止
当前 cell，不用新 attempt 筛选模型回答。

`scored` 与 terminal `diagnostic_failure` 是 score-eligible；`infra_unavailable` 与 `invalid` 不计入
能力分母。每个 arm 必须有 12 个 score-eligible cells，否则 Gate 为不可评估，不得将
基础设施失败计为模型诊断失败或成功。

## 6. Canary 前置

C0 使用 signal-ordering，C1 使用 physics-tunneling；每阶段按
generic → evidence-only → chronorift-full 顺序各运行一个 cell。每个 canary cell 只有一次
attempt，不 resume、不 retry。C1 必须引用同 canary identity 下 ready C0 的 report hash。

C0-001/002/003 均为 `not_ready` 并必须保留。C0-004 与引用其 report hash 的 C1-004 报告仍按
原字节验证为 `ready`，但缺少 V2 implementation receipt，因此前置资格仅为 `legacy_only`。
新 identity 005 必须绑定精确 Git HEAD、runtime source hash/count 与 clean implementation scope；
只有 005 C0 ready 后，精确 C0 report hash 和相同 receipt 才能授权 C1。该前置已完成：
[C0-005](canary-c0-ready-005.json) 与 [C1-005](canary-c1-ready-005.json) 均为 `ready`，verifier 均返回
`prerequisiteEligibility=hardened`；C1 精确绑定 C0 report hash
`0c5ef20c0e8f16ee9d93175b36cb7b1fb85f9514c6d06e5267b3c9f7974545c1`。formal spec、freeze 与
selection 仍未执行。

## 7. Formal Gate 与发布

主指标仍为 `groundedSuccess = mechanismCorrect && canonical verdict == confirmed`。Gate 要求：

- chronorift-full grounded success 至少 9/12；
- chronorift-full 减 generic grounded-success rate 至少 +0.20；
- chronorift-full incorrect confirmations 为 0；
- 三个 arm 各有 12 个 score-eligible cells。

report integrity verifier 与产品 Gate 必须分开执行。有效负面、invalid 或 recovery-exhausted
incomplete report 仍必须原样发布；不得删除 selection、重跑同一 definition 或只发布有利
cells。本地 verifier 不是外部签名、CI attestation 或 provider attestation。
