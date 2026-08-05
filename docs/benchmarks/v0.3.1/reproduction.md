# v0.3.1 Reproduction Protocol

本流程把 provider recovery、冻结和唯一正式 execution 分开。不要修改或覆盖 `docs/benchmarks/v0.3/`。

## 1. provider 链路验证

凭据必须已存在于 Pi 用户级 credential store。先确认模型 metadata，再在正式 Fixture 外连续通过两次
smoke，最后运行 live regression：

```bash
corepack pnpm models -- --provider volcengine-coding-plan
corepack pnpm pi:smoke
corepack pnpm pi:smoke
corepack pnpm test:live
```

若出现 TLS EOF、`Connection error`、零 token、零 tool call、Session 未持久化或 verdict 非 confirmed，
停止；先修复仓库外代理/网络/凭据，不生成 spec、不打 freeze tag、不启动 formal。smoke JSON 可以记录
用量，但不得提交 credential、prompt、Session ID、Session 路径或用户级 auth 文件。

## 2. 离线与 Godot gate

```bash
corepack pnpm check
corepack pnpm test:godot
corepack pnpm benchmark
corepack pnpm benchmark:verify -- \
  --report docs/benchmarks/v0.3/benchmark-report.v2.json
```

最后一条保证新实现仍能验证历史 v0.3 负报告；它不重新执行 v0.3。

## 3. 生成 machine spec 并冻结

```bash
corepack pnpm --silent benchmark:spec -- \
  --campaign v0.3.1 \
  > docs/benchmarks/v0.3.1/benchmark-spec.v2.json

git status --short
```

人工复核 campaign/tag/seed、suite/subject/runner hash、模型、预算、矩阵、metric 与 Gate。将实现、文档和
spec 同一 commit 提交，确保 `corepack pnpm check` 与 `test:godot` 通过、worktree 干净，再创建
`v0.3.1-benchmark-freeze` tag。tag 必须指向包含最终 spec 的 commit。

## 4. 唯一正式 execution

从干净 freeze checkout 先读取 selection：

```bash
corepack pnpm benchmark:status -- \
  --spec docs/benchmarks/v0.3.1/benchmark-spec.v2.json
```

仅当 `selected=false` 时启动：

```bash
corepack pnpm benchmark:formal -- \
  --spec docs/benchmarks/v0.3.1/benchmark-spec.v2.json
```

若已有 selection，只能使用输出/`benchmark:status` 找回的同一 ID 恢复：

```bash
corepack pnpm benchmark:formal -- \
  --spec docs/benchmarks/v0.3.1/benchmark-spec.v2.json \
  --resume EXECUTION_ID
```

不得删除 `.chronorift` selection、另开 execution、改变代码后拼接 cell，或因结果不好重新开始。exit 0
表示 complete，不表示 Gate pass；exit 2 的 `recoverable=true` 必须恢复同一 execution，
`recoverable=false` 表示 recovery 已耗尽且已封存。

## 5. 发布、验证与 Gate

对同一个 sealed execution：

```bash
corepack pnpm benchmark:publish -- \
  --spec docs/benchmarks/v0.3.1/benchmark-spec.v2.json \
  --execution EXECUTION_ID \
  --output docs/benchmarks/v0.3.1

corepack pnpm benchmark:verify -- \
  --report docs/benchmarks/v0.3.1/benchmark-report.v2.json

corepack pnpm benchmark:gate -- \
  --report docs/benchmarks/v0.3.1/benchmark-report.v2.json
```

publisher 是 write-once。verifier exit 0 仅表示报告内部完整；Gate exit 2 是应保留的有效负面或不可评估
结果。发布后用生成的 report/case bundle 填写预注册案例，不新增未经 artifact 支持的 provider 或模型
归因。
