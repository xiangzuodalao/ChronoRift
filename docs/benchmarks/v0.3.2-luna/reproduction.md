# v0.3.2-luna Reproduction

本文区分已完成的真实链路与 hardened C0/C1 前置，以及尚未执行的 freeze/formal 步骤。

## 1. 环境与离线检查

```bash
nvm use
corepack pnpm install
corepack pnpm check
corepack pnpm godot:doctor
corepack pnpm test:godot
```

凭据只能位于 Pi 用户级 credential store。确认 Luna metadata：

```bash
corepack pnpm models -- --provider openai-codex
```

目标必须精确解析为 `openai-codex/gpt-5.6-luna`、272,000 context、128,000 max output，
thinking `max` 必须映射为 `max`。

## 2. 真实 Pi 链路前置（已完成）

```bash
corepack pnpm pi:smoke
corepack pnpm pi:smoke
corepack pnpm test:live
```

2026-08-05 的本轮记录中，两次 smoke 均持久化 Session、调用 5 次工具并由 Harness
裁决 `confirmed`；total tokens 分别为 30,828 和 30,039。随后 `test:live` 通过。smoke
不接触四个 formal Fixture，不进入 formal aggregate，不能替代 canary。

## 3. 历史 C0-004（已完成，`legacy_only`）

C0-001、C0-002 和 C0-003 的 JSON 已作为 `not_ready` 证据保留。不得覆盖这些文件或重用
其 canary ID。C0-004 必须使用新 identity：

```bash
corepack pnpm --silent benchmark:canary:spec -- \
  --id v0.3.2-luna-canary-004 \
  > .chronorift/v0.3.2-luna-canary-004.spec.json

corepack pnpm benchmark:canary -- \
  --spec .chronorift/v0.3.2-luna-canary-004.spec.json \
  --stage c0

corepack pnpm benchmark:canary:publish -- \
  --spec .chronorift/v0.3.2-luna-canary-004.spec.json \
  --stage c0 \
  --output docs/benchmarks/v0.3.2-luna/canary-c0-ready-004.json

corepack pnpm benchmark:canary:verify -- \
  --report docs/benchmarks/v0.3.2-luna/canary-c0-ready-004.json
```

该报告按原 schema 以 `ready` 封存，report hash 为
`78915077d2881d1b0eed232e34abc3b16a894b4bd8a51841c73f3004f698dc07`。三个 arm 均 mechanism
correct；generic/evidence-only 为 `inconclusive`，chronorift-full 为 `confirmed`；全部为零 tool
errors、零无进展违规、零 incorrect confirmation。它缺少 V2 implementation receipt；强化 verifier
将其前置资格报告为 `legacy_only`。现在只重验已发布 JSON，不重跑该 identity，也不用于授权新 C1。

## 4. 历史 C1-004（已完成，`legacy_only`）

```bash
corepack pnpm benchmark:canary -- \
  --spec .chronorift/v0.3.2-luna-canary-004.spec.json \
  --stage c1

corepack pnpm benchmark:canary:publish -- \
  --spec .chronorift/v0.3.2-luna-canary-004.spec.json \
  --stage c1 \
  --output docs/benchmarks/v0.3.2-luna/canary-c1-ready-004.json

corepack pnpm benchmark:canary:verify -- \
  --report docs/benchmarks/v0.3.2-luna/canary-c1-ready-004.json \
  --c0-report docs/benchmarks/v0.3.2-luna/canary-c0-ready-004.json
```

C1 已引用同 identity ready C0 的 report hash 并以 `ready` 封存，report hash 为
`9526f486d9dea9619a748a867757861c588c77e90e58f43c4327dd0820195e3b`。generic、evidence-only 与
chronorift-full 的 mechanism 都正确、verdict 都为 `inconclusive`；三组工具调用为 7/5/8，total
tokens 为 92,310/49,464/111,558，全部为零 tool errors、零无进展违规、零 incorrect
confirmation。full 完成 matching replay、一项 intervention、一次 comparison 与 proposal。

## 5. Hardened 005 canary（已完成）

以下是已执行顺序，仅供审计；不要重跑或覆盖该 identity。005 必须在干净 implementation checkout
上生成 V2 spec；不得复制 004 spec 或修改 receipt。C1 只能由同一 identity 下实际发布的 ready C0
报告授权：

```bash
corepack pnpm --silent benchmark:canary:spec -- \
  --id v0.3.2-luna-canary-005 \
  > .chronorift/v0.3/canary-plans/luna-005.spec.json

corepack pnpm benchmark:canary -- \
  --spec .chronorift/v0.3/canary-plans/luna-005.spec.json \
  --stage c0

# C0 无论 ready/not_ready 都先以新文件名发布并验证；只有 hardened-ready 才继续 C1。
corepack pnpm benchmark:canary -- \
  --spec .chronorift/v0.3/canary-plans/luna-005.spec.json \
  --stage c1 \
  --c0-report docs/benchmarks/v0.3.2-luna/canary-c0-ready-005.json

# 公开报告可安全重验
corepack pnpm benchmark:canary:verify -- \
  --report docs/benchmarks/v0.3.2-luna/canary-c0-ready-005.json
corepack pnpm benchmark:canary:verify -- \
  --report docs/benchmarks/v0.3.2-luna/canary-c1-ready-005.json \
  --c0-report docs/benchmarks/v0.3.2-luna/canary-c0-ready-005.json
```

实际发布的 [C0-005](canary-c0-ready-005.json) 与 [C1-005](canary-c1-ready-005.json) 均为
`ready`，强化 verifier 对两份报告均返回 `prerequisiteEligibility=hardened`。C0 report hash 为
`0c5ef20c0e8f16ee9d93175b36cb7b1fb85f9514c6d06e5267b3c9f7974545c1`；C1 report hash 为
`b28560f66e6ef6c073e9029a993ad3636e8530f2c13decf47e52b7c60e710dfb`，并精确绑定该 C0 hash。六个
cells 均为 `scored`、mechanism correct、零 tool errors、零无进展违规、零 incorrect confirmation。

## 6. V3 spec 与 freeze（已完成）

```bash
corepack pnpm --silent benchmark:spec -- --campaign v0.3.2-luna
```

生成结果已写入 `benchmark-spec.v3.json`；人工复核了 schema version、campaign/tag/seed、
provider/model metadata、36-cell 构成、预算、3+3 recovery、score eligibility 与 Gate，并由 Godot
gate 确认提交文件可按当前实现确定性重建。实现、文档、canary 和 machine spec 随后一起提交，在
干净 checkout 上创建不可移动的 tag：

```bash
git tag -a v0.3.2-luna-benchmark-freeze -m "Freeze ChronoRift v0.3.2 Luna benchmark"
git status --short
```

本轮执行协议不要求推送该 tag；只要求 formal 运行时 HEAD 与本地 tag 精确匹配且
worktree 干净。

## 7. 唯一 formal execution（pending）

```bash
corepack pnpm benchmark:status -- \
  --spec docs/benchmarks/v0.3.2-luna/benchmark-spec.v3.json

corepack pnpm benchmark:formal -- \
  --spec docs/benchmarks/v0.3.2-luna/benchmark-spec.v3.json
```

selection 持久化后才算 execution 已被选中。终端输出丢失时用 `benchmark:status` 找回 ID。
只有已选中的同一 execution 可恢复：

```bash
corepack pnpm benchmark:formal -- \
  --spec docs/benchmarks/v0.3.2-luna/benchmark-spec.v3.json \
  --resume BENCHMARK_EXECUTION_ID
```

不得删除 selection、拼接另一 execution 或在看到结果后修改 spec。

## 8. 发布、完整性验证与 Gate（pending）

```bash
corepack pnpm benchmark:publish -- \
  --spec docs/benchmarks/v0.3.2-luna/benchmark-spec.v3.json \
  --execution BENCHMARK_EXECUTION_ID \
  --output docs/benchmarks/v0.3.2-luna

corepack pnpm benchmark:verify -- \
  --spec docs/benchmarks/v0.3.2-luna/benchmark-spec.v3.json \
  --report docs/benchmarks/v0.3.2-luna/benchmark-report.v3.json

corepack pnpm benchmark:gate -- \
  --spec docs/benchmarks/v0.3.2-luna/benchmark-spec.v3.json \
  --report docs/benchmarks/v0.3.2-luna/benchmark-report.v3.json
```

publisher 固定生成 `benchmark-report.v3.json`、`results.md` 和
`case-physics-tunneling-full-r1.json`。发布前不得预建或改写这些 write-once 文件。

verifier exit 0 只说明 schema、identity、hash chain、oracle、aggregate 与 report hash 可重算。Gate
exit 0 才代表预注册产品门槛通过；exit 2 表示失败或不可评估。无论 Gate 结果如何，
只要 execution 已按协议封存，就必须原样发布。
