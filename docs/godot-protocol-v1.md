# ChronoRift Godot Protocol v1

本文档描述 v0.2 实际实现的 Host ↔ Godot Addon 边界。它不是通用远程调试协议。

## Transport 与身份

- TypeScript Host 监听 `127.0.0.1` 随机端口，Godot runtime 作为 client 连接。
- 每个 Execution 启动独立 Godot 进程并生成 256-bit 单次 token。
- token 通过最小化进程环境传入，不写入日志、Session 或 artifact。
- frame 格式是 `uint32-be body length + UTF-8 JSON`，body 限制为 1 MiB。
- 双向 sequence 各自从 0 严格递增；response 必须返回原 request ID。
- 每个 envelope 固定 `schemaVersion=1`、`protocolVersion=1`，并携带 canonical payload
  SHA-256。未知字段、错误 hash、错误 sequence、超限 frame 和不支持版本都 fail closed。

Host 只绑定 loopback，并限制进程输出、连接/命令/Execution 超时。v0.2 没有容器或网络 namespace，
因此不能描述为 OS sandbox；Godot 子进程只接收运行所需的最小环境，不继承 Pi/API key。

## Message flow

```text
runtime → hello(fingerprint, token)
host    → hello_accept(required capabilities)
host    → configure(allowlisted probes)
runtime → configured

host    → restore(snapshot, certificate, logical time)
runtime → restored(validation receipt)

host    → step(logical tick, requested delta, inputs)
runtime → stepped(events, state, realized receipt, observation health)

host    → snapshot
runtime → snapshot_result(snapshot, checkpoint certificate)

host    → shutdown
runtime → shutdown_ack
```

错误通过 typed `error` 返回：authentication、capability、protocol、command、restore 或 runtime
failure。请求值在 runtime receipt 匹配前不会被当成事实。

## Capability set

v0.2 Fixture 声明：

- `observe.signal_allowlist`
- `observe.property_sampling`
- `control.input_event_action`
- `clock.process_frame`
- `clock.physics_tick`
- `launch.fixed_fps`
- `checkpoint.l0_restart`
- `checkpoint.fixture_semantic`

Host 在握手时声明所需能力。缺失能力会拒绝 Execution，不会静默忽略。Addon 只接受配置中的
Signal/property；当前 Godot 项目通过 `ChronoProbe` 显式注册 stable entity ID、Signal emission、
receiver callback 和 property transition，不声称 GDScript 能全局拦截所有 Signal 或属性。

## Logical step 与输入

输入由成对 `InputEventAction` press/release 通过 `Input.parse_input_event()` 注入。真实 Godot 会把
从 probe process callback 注入的事件交给下一输入阶段，所以 step barrier 会等待一个完整的
后续 process frame，再封存事件和状态。

`RuntimeStepReceiptV1` 同时记录：

- requested/realized logical tick 与 delta；
- InputEventAction 注入数量和 logical input order；
- process/physics frame 数量及实际 delta；
- engine process/physics counters；
- host monotonic interval；
- emitted/dropped/truncated event、backpressure、buffer 和 probe overhead。

其中 `probeOverheadUs` 只累计当前已插桩的 Signal、property、pending-effect 与 input 调用，是采样下界；
它不包含全部 lifecycle/spatial、state serialization、JSON 和 transport 成本，不能解释为完整 observer
overhead。

绝对 engine frame、host time 和 probe overhead 不参与 semantic replay digest；phase、frame/tick
数量、实际 delta、输入 receipt 和 event-loss health 参与。

## Checkpoint

L0 是新进程 + fresh scene before logical step。L2 使用最小 participant 接口：

```text
register_checkpoint_participant(id, node)
node.chronorift_capture()
node.chronorift_restore(state)
node.chronorift_validate(expected)
```

当前唯一 participant 为 `switch-door`，覆盖 switch active、door open、receiver connection、
initialization pending、logical clock 和输入调度。certificate 记录 semantic barrier、runtime
fingerprint、covered/missing domains、pending async、restore recipe hash 和逐 participant validation。

Godot physics internals、Timer/Tween/coroutine、线程、未注册 RNG、resource cache、网络和外部服务
不在覆盖范围内。L2 是 Fixture 语义恢复，不是 Godot 进程或完整 SceneTree 快照。
