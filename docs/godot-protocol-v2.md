# ChronoRift Godot Protocol v2

本文档描述 v0.3 已实现的 TypeScript Host ↔ Godot Addon 边界。Protocol v1 文档保留为 v0.2
历史说明；parser 可识别 v1/v2 envelope，但一个 Execution 的握手与后续消息必须使用同一版本。

## Transport、身份与 fail-closed 边界

- Host 监听 `127.0.0.1` 随机端口，每个 Execution 启动独立 Godot 4.7.1 进程。
- 每次启动生成 256-bit token；仅经最小子进程环境传递，不进入 artifact 或 Pi Session。
- frame 是 `uint32-be length + UTF-8 JSON`，最大 1 MiB。
- 双向 sequence 从 0 严格递增，response 必须匹配 request ID。
- envelope 为 strict `schemaVersion=1`、`protocolVersion=2`，payload 带 canonical SHA-256。
- hash、sequence、schema、能力、版本、token、frame 长度或 runtime fingerprint 不匹配均拒绝执行。

该边界不是 OS sandbox。子进程不继承 Pi/API key，但 v0.3 没有 network namespace 或容器隔离。

## Message flow

```text
runtime → hello(token, runtime fingerprint, capabilities)
host    → hello_accept(required capabilities)
host    → configure(Signal/property allowlist)
runtime → configured(realized acceptance)

host    → restore(snapshot, certificate, logical clock)
runtime → restored(participant validation, realized state)

host    → step(logical tick, requested delta, scheduled inputs)
runtime → stepped(events, state, clocks, input receipt, observation health)

host    → snapshot
runtime → snapshot_result(snapshot, checkpoint certificate)

host    → shutdown
runtime → shutdown_ack
```

## v2 capability set

v2 在 v1 基础上实际增加：

- `observe.entity_lifecycle`
- `observe.pending_effect`
- `observe.dynamic_property_registry`
- `control.physics_ticks_per_second`
- `control.fixture_allowlist`

完整集合还包含 allowlisted Signal/property、InputEventAction、process/physics clocks、fixed FPS、L0
restart 与 fixture-semantic checkpoint。Host 在启动前声明所需能力；不支持的控制不会静默降级。

## 动态注册与遥测

Fixture 通过 `ChronoProbe` 显式注册：

```text
register_state_property(path, object, property)
register_state_provider(path, callable)
register_entity(stable_id, node) → { stableId, incarnation }
record_entity_lifecycle(action, entity_ref)
record_pending_effect(action, effect_id, target_entity_ref, due_tick, reason)
record_spatial_sample(entity_ref, position)
```

`stableId + incarnation` 区分对象池复用前后的逻辑实体。Signal emission 与 receiver delivery 是两个
事件；delivery 必须引用更早的 emission。pending-effect 遥测显式记录 schedule、apply 或 discard，
并保留最初目标与实际解析目标的 incarnation。Host 把允许的结构化 runtime log 编译为
lifecycle、pending-effect 与 spatial 事件，未知日志仍作为不可信数据保留。

Addon 不进行全局 Signal/property 拦截。只采集 configure allowlist 与 Fixture 主动插桩的边界。

## Clock 与 controls

v2 保持 logical tick、simulation time、process frame、physics tick、engine absolute counter 与 host
monotonic time分离。可请求：

- `fixed_fps`；
- `physics_ticks_per_second`；
- `fixture.<allowlisted name>`；
- tick-based 或 simulation-time-based input schedule。

请求值不自动成为事实。Execution 保存 requested/realized control receipt；任何 mismatch 都使比较
不可用于 confirmed。Mock `deltaUs` 也不代表 Godot 的引擎级精确单步。

## Checkpoint 与已知缺失域

snapshot 只包含已注册 state provider 与 checkpoint participant。certificate 记录 consistency model、
semantic barrier、runtime fingerprint、covered/missing domains、pending async、restore recipe hash 与逐
participant validation。

v0.3 未覆盖 physics internals、Timer/Tween/coroutine、线程、未注册 RNG、resource cache、网络和
外部服务。这些域不会被默认为已恢复；当 Contract 依赖它们时，Harness 应输出 `inconclusive`。
