# v0.3.1-r2 Reproduction

## 1. 修复后 gate

```bash
corepack pnpm check
corepack pnpm test:godot
corepack pnpm benchmark
corepack pnpm benchmark:verify -- \
  --spec docs/benchmarks/v0.3/benchmark-spec.v2.json \
  --report docs/benchmarks/v0.3/benchmark-report.v2.json
corepack pnpm pi:smoke
corepack pnpm pi:smoke
corepack pnpm test:live
```

任一命令失败就停止。smoke 不进入 formal aggregate。

## 2. spec 与 freeze

```bash
corepack pnpm --silent benchmark:spec -- \
  --campaign v0.3.1-r2 \
  > docs/benchmarks/v0.3.1-r2/benchmark-spec.v2.json
```

人工复核 campaign/tag/seed、hash、矩阵、预算、模型与 Gate；提交 spec 后在干净 commit 创建
`v0.3.1-r2-benchmark-freeze`，不得移动 tag。

## 3. 唯一 execution

```bash
corepack pnpm benchmark:status -- \
  --spec docs/benchmarks/v0.3.1-r2/benchmark-spec.v2.json

corepack pnpm benchmark:formal -- \
  --spec docs/benchmarks/v0.3.1-r2/benchmark-spec.v2.json
```

selection 已存在时只能加 `--resume EXECUTION_ID` 恢复同一 execution。

## 4. 发布

```bash
corepack pnpm benchmark:publish -- \
  --spec docs/benchmarks/v0.3.1-r2/benchmark-spec.v2.json \
  --execution EXECUTION_ID \
  --output docs/benchmarks/v0.3.1-r2
corepack pnpm benchmark:verify -- \
  --spec docs/benchmarks/v0.3.1-r2/benchmark-spec.v2.json \
  --report docs/benchmarks/v0.3.1-r2/benchmark-report.v2.json
corepack pnpm benchmark:gate -- \
  --spec docs/benchmarks/v0.3.1-r2/benchmark-spec.v2.json \
  --report docs/benchmarks/v0.3.1-r2/benchmark-report.v2.json
```

verifier 返回 0 且 Gate 返回 2 是本次已发布负结果的预期复验结果。verifier 与 Gate 分开解释；负面、
invalid 或 recovery-exhausted incomplete 结果不得替换。
