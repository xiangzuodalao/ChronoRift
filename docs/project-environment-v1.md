# Project Environment V1 RFC

> 状态：**历史 V1 设计参考；Preview 保留最窄实现；不是 current HEAD 必须完整遵从的不可变 contract**
> 决策日期：2026-08-12
> 目标入口：Project Environment Preview；经过显式产品验证与评审后才可成为默认 `chronorift [goal]` 入口
> 当前 release：ChronoRift v0.4.0 legacy diagnosis slice

Project Environment V1 记录实验性 Preview 的历史设计、数据和信任边界；它不是完整的当前实现说明或实施清单。
current HEAD 保留 strict DTO/store、ProjectAdapter SDK/wire/loader、初始化/publication/reuse、V2 observation 和 narrow
source/import/target closure，并把 Host process 收敛到 Linux x86_64 上 exact SRT `0.0.74`。Agent coding 使用 fresh-run
physical workspace RW；Godot 使用 Host-copied stage source RO + 前后 hash；两者默认禁网。旧 PE-A/PE-B real-model
bundles 与 PE-C CI run metadata 只作为冻结历史归档保留；当前 HEAD 不再包含它们的 producer、standalone validator
或一次性 Host Gate。历史结果不能描述成外部项目普遍受支持或默认入口已经切换。

PE-B 在 Project Environment V1 store 上增加内部 manifest/SDK/observation protocol V2。V1 bridge/SDK bytes 和已发布
PE-A revision 原样保留；新初始化默认生成 V2 adapter，未知版本或 digest 返回 `review_required`，不自动迁移。V2
使用 Execution-bound EntityRef、event-driven ordered queue、Host continuous validated ring 与 durable capture replay。

M3、M4 与 E2 的 active implementation/command 已从 current HEAD 删除；其 schema、wire 和证据只在历史 tag/归档中按
原语义保留。Preview 不恢复旧 broker、cgroup/storage layer、Host-config 或 runtime coordinator。

## 1. 产品目标与支持范围

目标体验是：用户在 Godot 项目目录启动 ChronoRift，第一次进入时，同一个可见 Pi Agent Session 自动读取项目、
生成并验证唯一的 ProjectAdapter；环境 ready 后立即开始用户工作。后续 Session 直接复用已验证环境，不要求用户
理解或编写 descriptor、Addon、sidecar、probe 或 snapshot adapter。

```text
cd <godot-project-root>
chronorift [optional goal]
→ 自动发现 project.godot、source closure 与受管 Godot toolchain
→ 创建 fresh `srt-tasks-v1` physical workspace、SRT boundary 与可见 Pi Session
→ 首次进入时，Agent 生成 ProjectAdapter candidate
→ Harness 执行 conformance，完整落盘 revision 后原子切换 current pointer
→ 在同一 Session 的下一 turn 处理已排队目标
→ 后续启动 pin 并复用匹配的 ready revision
```

完整 Project Environment V1 的支持包络冻结为以下范围，并按 §10 的 PE-A 至 PE-H/PE-P 逐步实现；PE-A 只承诺
§10.1 明列的子集：

- Linux 原生 Host；其他平台必须分别建立真实 sandbox conformance 后再声明支持；
- Godot 4.7 系列官方 GDScript runtime；实际 executable 来自 Host 受管 toolchain registry，每个 environment
  revision 固定完整版本、平台与 executable content hash，不跨 patch release 浮动；
- 不把 main scene 固定为某个 fixture，支持 adapter 声明的具名 launch targets；首发兼容范围只以 §11 冻结的
  结构类别与实际 conformance 为准；
- 项目自身的普通 GDScript 可以在隔离 runtime stage 中运行；`@tool` script 与 GDScript `EditorPlugin` 只允许在
  隔离 import/editor stage 中运行；
- C#/.NET、GDExtension、native library、未知 native engine module 与 native editor plugin 明确 unsupported；
- headless 是最低初始化边界；render/display/GPU 是显式 Task capability，audio 延后；
- 常规入口自动发现项目并冻结 realized descriptor；显式 descriptor override 只作为多项目或特殊启动方式的高级
  逃生口，不是普通用户的接入前提。

Godot version 可以由项目的 `.godot-version` 或 ChronoRift environment config 请求，但只能选择 Host registry 已安装的
4.7 patch。缺少精确 binary 时 fail closed，Task 不下载 runtime。Toolchain receipt 同时记录 requested/realized
version、platform、executable hash、build features 和 renderer；版本字符串或 registry key 不能替代实际 binary identity。

一个 Project Environment 只对应一个包含 `project.godot` 的 project root。从上层目录启动且发现多个 Godot
project 时必须让用户选择或显式指定，Harness 不得猜测。一个 Task 只绑定一个 Project Environment；跨项目 Task
不属于 V1。

## 2. Harness 与 Agent 的职责

职责边界冻结为：

| 主体                | 拥有的职责                                                                                                                                                               |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Harness             | Godot runtime bridge、versioned wire protocol、Adapter SDK/schema、sandbox、toolchain registry、loader、validator、conformance、storage 与 crash-safe publication broker |
| Pi                  | Session、模型调用、Agent Loop、工具调度、消息历史、compaction 和普通终止                                                                                                 |
| Agent               | 默认自动读取项目、生成并持续维护唯一 ProjectAdapter，定义项目实体、状态、事件、capture、control 与可选 snapshot/restore 语义                                             |
| 用户/项目 CI/review | 接受或拒绝游戏候选修改，判断 adapter 是否充分表达项目语义                                                                                                                |

Harness 不生成项目语义，不根据节点名猜测玩家、敌人、关卡或 Bug，不判断 adapter 的领域解释是否正确。Agent 是
唯一自动 generator；用户也可以显式从已发布 revision 创建 sandbox candidate 并成为该 candidate 的 author。Harness
只验证输入和输出是否符合协议、权限和预算，声明能力是否真实可执行，以及 publication/cleanup 事实是否成立。

初始化使用正常的 Pi coding-agent 资源加载：保留默认 system prompt，加载项目 `AGENTS.md`、适用 skills 与上下文，
并提供绑定 Adapter SDK version 的 `project-adapter` skill。该 skill 解释 manifest、capability modules、SDK 示例、
validator 与 fidelity 规则，但不规定固定调查步骤或唯一工具顺序。不存在隐藏 bootstrap Agent 或 Harness 自己实现的
第二套 Loop。

## 3. Source closure 与 managed workspace

### 3.1 Git 工作区快照

Project Environment V1 接受 Git 工作区快照，而不只接受 clean checkout。每次进入项目时，Harness 冻结：

- 每个 Git root 的 HEAD、tracked tree 与 tracked dirty change；
- 用户显式选择纳入且通过 source admission 的 untracked 文件；
- 已 materialize 的 submodule、Git LFS 实体文件和 vendored addon；
- 每个 source root 的实际内容、mode、归属与 lineage；
- symlink 的文本与 canonical target；target 必须仍位于已授权 source closure；
- 自动发现得到的 project root、`project.godot`、launch metadata 与 realized descriptor。

`.git/`、ignored files、未选择的 untracked 文件和 `.chronorift/` 永不进入 closure。Persisted closure 只保存 opaque
source-root ID、安全 project-relative reference、mode、content identity 和 lineage；Host canonical absolute path 只在
Host source admission 内短暂使用，不能写入 environment、artifact 或 export bundle。

当前 sandboxed run 不自动 clone、fetch、更新 submodule 或下载 LFS object。LFS pointer 尚未 materialize、source root 缺失、
symlink 逃逸、unsupported tree entry 或 identity 在冻结期间漂移时 fail closed。URL、commit 名称或 lockfile 不是已取得
字节的替代品。

以上是完整 V1 的目标边界，不等于 PE-C 一次实现全部能力。当前 PE-C 只接纳选中项目的 tracked 最终工作树 bytes、
逐次显式选择的 untracked 文件，以及遇到的 clean、已 materialize direct-submodule set；未 materialize 的 LFS
pointer、symlink、dirty/递归 submodule 与任意 sibling/absolute roots 在该切片继续明确拒绝。已 materialize 的 LFS
实体 bytes 仅按普通文件进入 admission 和 closure；PE-C 不提供 LFS-aware 下载、专门 lineage 或跨仓库一致性保证。
materialize 后必须重新计算 closure identity，漂移时在 Agent、import 或 game execution 前停止。

Source admission 在 hashing、copy 和模型可见之前拒绝 Pi auth/credential roots、`.env*`、private key、常见 cloud
credential 文件及由 operator policy 标记的敏感路径；submodule、LFS 实体和 vendored addon 使用同一规则。拒绝日志
只能记录脱敏的 project-relative category，不能回显 secret bytes。current HEAD 不提供 secret injection；项目 secret
不能成为 source closure、adapter、artifact identity、bundle 或普通 command/Godot environment。

### 3.2 Project Environment 与 Task 分离

Project Environment 是项目级、可跨 Task 复用的本地环境；Task 仍拥有单独的 managed workspace、Pi Session、
runtime、Execution、capture、checkpoint 和 artifact 配额。

项目根的 `.chronorift/` 保存 Project Environment 的 immutable revisions、current pointer 与人类可读的 adapter
内容。它必须：

- 使用独立的 `project-environment-v1` namespace，不重解释既有 v0.3/v0.4 run store；
- 通过目录内只含 `*` 的 `.chronorift/.gitignore` 自包含 local-only，不修改项目根 `.gitignore`、Git index、
  `.git/info/exclude` 或共享 Git config；该 marker 自身也不能进入 source closure 或 bundle；
- 被 ChronoRift 的 source discovery、dirty snapshot、patch、refresh 和 apply 硬性排除；
- `project-environment-v1` namespace 不保存凭据、未脱敏 provider request、Pi auth、Host 敏感路径或普通 runtime
  history；既有 v0.3/v0.4 namespace 与字节仍按原语义共存；
- 在根级 `.chronorift/` 已被 Git 跟踪、经过 symlink 映射或不能安全排除时拒绝初始化。

未发布 ProjectAdapter candidate、初始化 Session、验证日志和 runtime artifacts 保存在仓库外的 fresh-run
`srt-tasks-v1` namespace。current HEAD 不提供旧 bounded-storage mount、inode ledger 或跨命令 failed-attempt manager。
project-local environment store 只保留 Preview 实际使用的 revision/publication 数据；不把容量 policy 写成已实现事实。

Agent 的普通 coding tools 只能修改 SRT candidate，不能直接写 Host `.chronorift/`。Host publication code 创建 revision
并更新 current pointer；不再经过独立 publication broker framework。

### 3.3 Host drift 与游戏 patch

Session 启动后若用户、IDE 或 Git 操作改变 Host source closure，Harness 必须暂停新的 Build/Execution 并展示 Host
diff 与 managed workspace diff。刷新是一次显式、可审阅的 source lineage event；无冲突时才更新 managed
workspace，有冲突时 fail closed。运行中的 Execution 不热换源码。

Agent 的游戏修改始终留在 managed workspace。交互界面分别展示游戏 patch 与 adapter/probe diff；用户显式
`apply` 时，Host broker 重验 baseline、当前 dirty state 和目标 containment，无冲突才应用游戏 patch。它不自动
commit、merge 或 push。`ApplyReceiptV1` 绑定 input patch、目标 pre/post tree identity 与实际结果；冲突时 fail closed
并保留 managed candidate，供用户或 Agent 显式解决后重试。`.chronorift/` publication 不能混入游戏 patch apply。

## 4. Project Environment 数据模型

所有 external、wire 与 persisted DTO 都必须 strict、versioned，并在每次读取时重新验证。V1 至少定义以下资源：

| DTO                                                   | 语义                                                                                                                   |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `ProjectSourceClosureV1`                              | HEAD、selected project、规范 path/mode/content/provenance、允许的 submodule lineage、realized descriptor 与 `SourceId` |
| `ProjectEnvironmentWorkspaceMaterializationReceiptV2` | closure freeze/postflight identity、输出 tree identity 与 `source_drift` 结果                                          |
| `ProjectEnvironmentV1`                                | project-local 环境身份、状态和 current revision 引用                                                                   |
| `ProjectEnvironmentRevisionV1`                        | 经 Agent 审阅的 source closure、adapter、SDK/bridge、toolchain、最低 policy profile 与 conformance 组合                |
| `ProjectAdapterRevisionV1`                            | 唯一 adapter package 的 manifest、GDScript、schemas、smoke、可选 probe/alignment 与内容身份                            |
| `ProjectInitializationAttemptV1`                      | predecessor、Task/Session、provider/model/thinking、candidate、预算、验证和 sealed 终态                                |
| `ProjectEnvironmentTurnV1`                            | initialization/maintenance/user-goal purpose、attempt、预算、binding 与排队隔离                                        |
| `EnvironmentBindingEpochV1`                           | Task 从 pending attempt 到精确 environment/adapter revision 的 append-only binding                                     |
| `ProjectToolchainReceiptV1`                           | requested/realized Godot version、platform、binary hash、features 与 renderer                                          |
| `AdapterConformanceReceiptV1`                         | adapter 声明能力的实际执行、coverage、loss、failure 与 cleanup 结果                                                    |
| `AdapterCompatibilityReceiptV1`                       | 已发布 adapter revision 对某个精确 candidate Build 的快速兼容事实                                                      |
| `ProjectAdapterLaunchTargetValidationV1`              | declared/default/selected target，以及各 target 的 `validated` 或 `declared_unvalidated` 状态                          |
| `EnvironmentPublicationIntentV1`                      | candidate、target revision、expected current 与 crash-recovery operation identity                                      |
| `EnvironmentPublicationReceiptV1`                     | create-new revision、expected/current CAS、实际 publication 与失败事实                                                 |
| `LaunchReceiptV1`                                     | requested target/params 与 realized scene/params/renderer/capability/clock                                             |
| `ObserverEffectReceiptV1`                             | vanilla/instrumented smoke 的可观察差异、对齐缺口与未知 observer effect                                                |
| `ApplyReceiptV1`                                      | 游戏 patch、Host pre/post tree identity、实际应用/冲突与 retained candidate                                            |
| `ProjectNetworkPolicyTemplateV1`                      | Host 用户批准的 project identity、endpoint/principal 上限、版本、有效期与撤销状态                                      |
| `TaskNetworkPolicyReceiptV1`                          | template version 到 Task 主体/domain/protocol/port/DNS 的 requested/realized policy                                    |
| `ProjectAdapterBundleV1`                              | 可显式 export/import 的无 Host path、credential 或 Pi Session 的 adapter 交换格式                                      |

这些名字描述 wire/persisted contract，不预先指定 TypeScript package。只有 engine-neutral identity、state、capability
和 receipt contract 可以进入 `domain`；Git dirty/submodule/LFS/symlink、Godot discovery、Host canonical path 与
physical store DTO 留在对应 source adapter、Godot adapter、CLI composition 或 artifact adapter 边界，不能让
`domain` 知道 Git、Godot 或 filesystem layout。

### 4.1 Fresh run、Session、Turn 与 binding

current HEAD 中 `taskId` 是一次 fresh-run record identity。每条 command 在 `srt-tasks-v1` 下创建一个新的 physical
workspace 和 Pi Session；它不是可以通过通用 Task CLI 跨命令继续的长生命周期对象。初始化与同一 command 内的 goal
turn 可以共享 Session，Project Environment revision 则独立保存在 project-local store，供后续 fresh run 复用。

保留的 `EnvironmentBindingEpochV1` 只记录该 run 使用的精确 environment/adapter revision。Publication 成功后才投递
同一 command 排队的 goal；初始化失败时 goal 不执行。current pointer 的后续变化不重写已经完成的 run record。

Attempt、turn、candidate 与 conformance Execution 属于该 fresh run；published environment/adapter revision 属于
project-local store，并拥有其发布所需的 bytes，不依赖通用 Task retention manager。

关键 identity 关系是：

```text
ProjectSourceClosure
        │ reviewed-by Agent
        ▼
ProjectEnvironmentRevision ──pins── ProjectAdapterRevision
        │                       ├── manifest + capability schemas
        │                       ├── GDScript implementation
        │                       └── optional probe/alignment
        │
        └──pins SDK + bridge + Godot toolchain + conformance
                                 │
Fresh run ──binds environment revision ▼
Build ──binds source + adapter + probe + compatibility receipt
                                 │
Execution ──binds Build + runtime + capture/checkpoint lineage
```

Adapter bytes 未变化时，Agent 针对新 source closure 的审阅仍产生新的 Project Environment revision。Fresh-run result
记录精确 environment/adapter revision；current pointer 的后续变化不重写旧 result。Build 和 Execution 同时绑定
source、adapter、probe、payload schema、toolchain 与 compatibility receipt，不能仅记录一个笼统的“项目版本”。

Content hash 用于 identity 和损坏检测，不是签名、外部 attestation 或同用户权限下的防篡改保证。

## 5. 唯一 ProjectAdapter package

“唯一”表示一个 Project Environment revision 只有一个生效的 ProjectAdapter package。项目可以拥有历史 revisions，
Agent 或用户也可以创建新 candidate；不能同时加载相互竞争的 lifecycle、semantic 或 fixture product profile。

一个 adapter revision 由以下部分共同寻址：

- strict manifest；
- 普通 GDScript SDK 实现；
- project-specific payload schemas；
- 具名 launch targets 和 adapter smoke 声明；
- 可选 runtime-only probe overlay；
- 可选跨 revision alignment mappings；
- SDK、bridge 与最小 Godot toolchain requirement。

每个 launch target 有稳定 ID、project-relative scene/resource reference、受 schema 限制的参数、environment/renderer/
capability requirement 与是否为 default 的声明。Launch receipt 分别记录 requested target/params 与 realized scene、
sanitized params、renderer、capability 和 clock；工具不能把 manifest 声明之外的自由参数传给 Godot。

Adapter 可以遍历 SceneTree、调用项目方法、维护 entity map 并实现 snapshot/restore。它不能注册任意 Pi tool、加载
native library/GDExtension、成为 EditorPlugin、动态加载 sandbox 外代码或绕过 bridge 通信。Adapter 与项目脚本处于
同一个不可信 Godot security principal；SDK 静态检查不是安全沙箱，也不会给 adapter 更高权限。

Agent 可在普通工作 Loop 中修订 adapter。新 revision 必须重新验证、完整落盘并原子切换 current pointer，且只影响之后创建的 Build 和
Execution；active runtime 不热替换。Published revision 始终只读。用户要求手工修改时，CLI 把所选 revision
复制到仓库外的 managed candidate workspace；编辑结果必须作为新 candidate 重验，不能原地改变 current revision。

### 5.1 Capability modules

一个 adapter package 使用多个版本化 capability module，而不是一个返回空值的巨型接口：

| Module              | V1 作用                                                                     | Ready 要求                   |
| ------------------- | --------------------------------------------------------------------------- | ---------------------------- |
| `lifecycle`         | 具名 launch target、launch/status/stop/cleanup                              | 必须 implemented             |
| `clock`             | process frame、physics tick、simulation、Host monotonic 与可选 render clock | 必须 implemented             |
| `runtime_error`     | engine、script、bridge 与 process error channel                             | 必须 implemented             |
| `entity_projection` | SceneTree、稳定 entity identity 与 lifecycle                                | 必须 implemented             |
| `state_projection`  | 项目状态 schema 与有界 samples                                              | 必须至少收到一组合法 sample  |
| `event_projection`  | entity lifecycle 与 adapter 声明事件                                        | 必须 implemented             |
| `capture`           | rolling channels、coverage、loss、retention                                 | 必须 implemented             |
| `input_control`     | 稳定 control ID 到实际 Godot input 的映射                                   | 可 unsupported               |
| `snapshot`          | 状态域 capture 与 barrier                                                   | 可 unsupported               |
| `restore`           | 已捕获状态域的 write-back、read-back 与 side effect                         | 可 unsupported               |
| `render_capture`    | render-complete 与图像 capture                                              | 可 unavailable_*/unsupported |
| `alignment`         | 跨 schema/entity revision 的声明式映射                                      | 可 unsupported               |

每个 module 明确区分 `implemented`、`unsupported`、`unavailable_by_policy`、
`unavailable_by_environment` 与 `degraded`。状态域另外区分 `captured`、`reset`、`externally_controlled`、
`unsupported` 和 `uncontrolled`。空数组、缺少字段或一次无事件 observation 不能替代 capability 状态。

### 5.2 固定 Agent 工具面

ProjectAdapter 只实现标准 ports，不生成项目自定义 Pi tools。Agent 始终使用稳定、versioned 的核心工具面：

- discovery/lifecycle：`game_capabilities`、`game_launch`、`game_status`、`game_stop`；
- capture/observation：`game_capture_configure`、`game_capture_pin`、`game_query`；
- control：`game_input`、`game_step`、`game_set_controls`；
- state/lineage：`game_checkpoint_create`、`game_checkpoint_restore`、`game_fork`；
- trace/compare：`game_trace_create`、`game_trace_replay`、`game_compare`。

工具只接受稳定 resource、launch-target 和 control ID，不接受 Host path、任意场景路径、自由 Godot 参数或任意
GDScript expression。未实现的 module 返回结构化 capability 结果；工具错误不自动终止 Pi Loop。

### 5.3 Payload、Variant 与实体身份

Harness 固定 entity、state sample、event、snapshot domain 和 receipt envelope；adapter manifest 使用受限、
SDK-neutral、canonical JSON Schema 子集声明 project-specific payload，并给 entity type、state domain、event type
和公开 field 分配稳定 ID。每个 persisted/wire DTO 都有显式 `schemaVersion`；每条 bridge record 在接收时验证
schema、大小、深度、时钟、Task ownership 和 resource identity；schema bytes 属于 adapter revision identity。

Canonical value model 只允许：

- null、boolean、bounded integer、finite/canonical float 和 bounded string；
- 有预算的 array 与 string-key map；
- 明确支持的 Vector、Quaternion、Transform、Basis、Color、Rect 等 tagged value；
- task-owned `EntityId`、声明过的 `ResourceId` 与安全的 project-relative resource reference。

任意 `Object`、Callable、RID、线程、native pointer 或完整 Resource 不能直接跨 bridge。未支持 Variant 必须由
adapter 投影为已声明结构，或明确报告 unsupported/uncontrolled。NaN、Infinity 与负零等边界必须有唯一、严格的
拒绝或 canonical encoding 规则。

Adapter 为每类 entity 声明 identity strategy，可使用项目持久 ID、authored ID、spawn lineage 或
execution-local ID。NodePath 和 Godot instance ID 只是 observation field。Harness 验证同一 Execution 内的唯一性、
ownership 与 lifecycle 顺序；跨 Execution 无可靠身份时标记 `execution_local`、`unmatched` 或 `ambiguous`，不能
强行宣称为同一实体。

### 5.4 Snapshot、barrier、capture 与 control

Snapshot module 必须按状态域 manifest 声明 captured/reset/externally-controlled/unsupported/uncontrolled，
记录逐域 schema、coverage、hash、依赖与 capture barrier。Restore module 独立协商，逐域返回 requested、reported
written、failed、missing 与 side effect；conformance 必须执行 capture → controlled mutation → restore → read-back，
保存 mismatch、missing 与已知 first divergence。该结果最多说明声明投影在所测窗口内回读一致；部分失败不能
归一化成成功，没有观察到 divergence 也不证明未声明状态相同或 equivalent start。

标准 barrier 包括 `process_frame_end`、`physics_tick_end` 和 `render_complete`；adapter 可以声明具名 semantic
barrier。每次 checkpoint 记录 requested barrier、实际命中 barrier、所有适用时钟、量化延迟与失败。自定义 barrier
是 adapter revision 的一部分，不能由一次工具调用注入任意代码。

Rolling capture 同时支持手动 pin 和 adapter 声明的有界 retention trigger。Trigger 可以引用 runtime error、声明
event、受限状态谓词或资源阈值，只请求保留触发前后窗口；它不是 Bug、Contract failure 或根因结论。Receipt 必须
保留实际触发位置、量化、coverage、overwrite、loss、重复抑制、预算降级与 observer effect。

Input module 发布稳定 control ID、参数 schema、允许 phase、持续时间和已知副作用，并映射到 InputMap action、
InputEvent 或受控项目方法。Trace 同时保留 requested control 与 realized Godot input、目标/实际 tick、phase 和量化。
跨 source/adapter revision replay 必须验证兼容性并报告 confounder。

跨 payload schema 的 compare 只有在 adapter 提供受限、versioned alignment mapping 时才能语义对齐。没有映射时
仍可并列展示原始记录，但结果必须是 incompatible 或 `descriptive_only`。Agent prose 不能替代可重建的 mapping。

## 6. 初始化、更新与 publication 生命周期

### 6.1 首次初始化

Project Environment 状态与初始化 attempt 状态分开。环境状态由 current pointer 与本次 source/toolchain/SDK
inspection 推导为 `uninitialized`、`ready` 或 `review_required`，不是 Agent 可以直接写入的 verdict：没有 current
ready revision 是 `uninitialized`；精确 binding 全部匹配并通过复用 smoke 才是 `ready`；source、SDK/bridge 或
toolchain 漂移则是 `review_required`。Attempt 采用以下 durable-operation 状态；它们记录 Harness 实际工作，不是
Agent 必须遵守的工具 phase machine：

```text
created
→ agent_running
→ candidate_frozen
→ validating
→ publishing
→ publication_committed
→ binding
→ succeeded

CAS commit 前任何阶段 → failed | cancelled
任何 persisted nonterminal + restart → reconciling
reconciling → publishing | publication_committed | binding | failed | binding_failed
```

Validation 可以在 Agent Loop 中重复、交错运行，这些结果都是 provisional，不触发 publication。普通
`session.prompt()` 正常返回后，Host 才冻结本 turn 的唯一 candidate identity，重跑 authoritative conformance 与
cleanup，然后自动 publication；不要求 submit tool 或固定调查顺序。Turn timeout、abort、provider failure 或没有
唯一合法 candidate 时绝不 publication。`succeeded`、`failed`、`cancelled` 与 `binding_failed` 都是 sealed terminal
states。current HEAD 不恢复失败 run 的 Pi Session/candidate，也不提供跨命令 resume/discard；下一次 invocation 创建
新的 fresh-run namespace。Project-local publication 若中断，只允许用 path-free operation identity 收敛其原子 store
状态，不自动投递旧 goal。

首次启动创建同一个可见 Pi Session。Provider、model 与 thinking 在命令边界显式选择且禁止 silent fallback；fresh run
在创建 Session 时冻结该选择，初始化和排队 goal 使用同一 Session/model/thinking。初始化 turn 与用户目标 turn 可以
记录 token、time、tool-call 和 runtime facts，并共享该 Session 的正常历史与 compaction。预算耗尽不伪装成成功。初始化 prompt 是
普通 `session.prompt()` 加简短环境 appendix/skill，保留 Pi 默认 system prompt。Agent 可以自由读码、运行隔离命令、
编写 adapter 和调用验证工具；Harness 不要求固定工具顺序或 `submit_project_adapter`。若用户同时提供目标，该目标
排队但不与初始化 prompt 合并。

PE-A 对 wall timeout 取请求值与 turn budget 的较小值；coding/game tools 共享 turn-scoped tool-call admission，第
`limit + 1` 次调用在触达 tool backend/runtime 前拒绝并把 turn 封为 `budget_exhausted`。SDK 能返回的 token 计数与其他
已观测 counter 在 turn 结束时重验；不能精确逐 turn 观测的 runtime/storage counter 保持 `null/partial`，只由既有
sandbox execution timeout 约束，不能写成主动精确计量或 SRT 未提供的 storage quota。

Authoritative validator 通过后，broker 把 bytes 复制到目标 `.chronorift/` 内的新临时目录，
逐项重验、写入最小 path-free conformance evidence closure、sync 并以 create-new 方式 materialize immutable revision；
随后才用 lease 与 compare-and-swap 原子切换 current pointer。所谓“原子 publication”只指 fully materialized
revision 后的 pointer switch，不声称能从外部 Task store 跨文件系统原子 rename。Publication intent/receipt 支持
幂等重启 reconciliation；corrupt pointer、partial revision、directory replacement、symlink race 或 source/candidate
漂移一律 fail closed，不能从 current 猜 Task binding。初始化 turn 正常结束时，只有存在绑定当前 source closure、
SDK/bridge、Godot toolchain 和 conformance 的 ready revision，且 Task ledger 已记录精确 binding epoch，才算成功；
Agent 最终 prose 不是环境状态事实。成功后在同一 Session 的独立下一 turn 执行排队目标。

Pointer CAS 是 project environment 的 commit point。`EnvironmentPublicationIntentV1` 先写入 Task store，并把同一
operation ID 固化进目标 revision manifest；随后以 create-new 写入 project-local、path-free recovery authority，
authority durable 以前不得创建 revision 或 pointer transaction。Authority/transaction record 若中断在目录创建与
首个 immutable record 之间，reopen 只会隔离完全空目录或严格匹配内部 UUID stage 命名、权限和 link identity 的
残留；未知名字、bytes、symlink 或 hard link 一律 fail closed，不会作为残留静默删除。各 crash cut 的唯一恢复语义是：

1. revision 未完整 materialize：current 不变，partial directory 被隔离或按 receipt 清理；
2. revision 已完整 materialize、CAS 未发生：current 不变；只有 expected current 仍匹配时才能幂等重试，否则保留
   未引用 revision 并以 `failed(reason = publication_conflict)` 结束；
3. CAS 已发生、receipt 或 binding 缺失：验证 pointer、revision 内 operation ID 与 Task intent 后补写 receipt，再
   exactly-once 追加 binding epoch；不能仅看到 current 就猜测 owner；
4. CAS 已发生但 Task store 丢失或损坏：ready revision 不回滚，attempt 记录或恢复为 `binding_failed`，当前命令
   失败且 queued goal 不执行；后续新 Task 可以在完整 revalidation 后复用该 environment。

CAS 后不再接受 cancellation，attempt 只有完成 Task binding 才是 `succeeded`。`binding_failed` 不表示 degraded
environment；它明确表示 project publication 已提交、原 Task 未获得可用 binding。

Current pointer 与 recovery authority 中的 `commitRequestedAt`/`pointerCommitRequestedAt` 是 CAS 前选定的 transaction
时间，不冒充 publication 完成时间。`EnvironmentPublicationReceiptV1.completedAt` 必须在实际执行或 restart
reconciliation 形成 receipt 时采样；若 receipt 已 durable 而后续事件中断，reopen 按 operation ID 找回并验证原 receipt，
不能用新的时间制造第二份 receipt。

首次初始化未达到最低 conformance 时命令非零退出、Project Environment 仍为 uninitialized、排队目标不执行。
已有环境的 review/migration 失败时，旧 immutable current 不被覆盖，但本 fresh run 保持 `review_required` 且不执行排队
目标。失败 candidate、Pi Session、实际验证与 cleanup 结果可以留在该 fresh-run directory 供 review，但不会被后续
command 作为可恢复 Task 打开，也不能作为 degraded current revision 发布。

### 6.2 Ready 最低门槛

Ready revision 至少必须真实完成：

1. 一个默认具名 launch target；
2. bridge handshake、source/adapter/runtime identity 和 version negotiation；
3. process/physics/simulation/Host clocks、runtime error 与 bounded diagnostics；
4. 可查询的 SceneTree/entity projection 与合法 lifecycle；
5. 至少一组 project-specific state projection，并在 smoke Execution 中实际收到 schema-valid、identity-bound sample；
6. entity lifecycle 与 adapter 声明 event 的严格记录；
7. 有界 rolling capture、Harness 计算的 transport coverage/loss、adapter 声明的 semantic coverage/unknown、budget
   和 observer-effect receipt；
8. stop、process scope 与 operation-private scratch cleanup 的实际成功记录，以及预期保留的 Session、candidate、
   revision 和 evidence inventory；
9. 未覆盖或不可恢复状态域的明确分类。

Input、自定义深层事件、snapshot/restore、alignment、render capture 可以明确 `unsupported`、
`unavailable_by_policy` 或 `unavailable_by_environment`。Ready 只证明 Harness 在这次 conformance 中执行了所列
动作并接收了符合 schema/identity 的 observation，不证明 observation 是完整或真实的游戏状态、adapter 完整理解
项目、snapshot 等价、游戏正确或任意项目可支持。

### 6.3 复用、源码变化与 SDK 迁移

后续进入项目时：

- source、SDK/bridge、toolchain 和最低 conformance policy profile 未变：重验 schema/binding 并运行 quick smoke 后
  直接复用；每次 sandboxed run 仍默认禁网，不存在隐式 network/display/credential grant；
- Host source closure 变化：向同一可见 Agent 提供精确 diff、旧 adapter 与旧 capability report；Agent 可以保持或
  修订 adapter，但都必须产生绑定新 source 的 environment revision；
- managed workspace 内的普通候选代码变化：不要求每次发布 environment revision；每个 candidate Build 先运行
  快速 adapter smoke，生成 `AdapterCompatibilityReceiptV1`；
- compatibility 失败或 capability coverage 变化：Agent 修订 adapter，完整 conformance 后发布新 revision；
- SDK/bridge 升级：旧 revision 保持不可变；Agent 按 migration guide 生成并验证新 revision，不能原地改写历史。

旧 SDK 可以在明确支持期内继续用于历史读取或 replay；不再受支持时拒绝创建新 Execution，但不能破坏旧 artifact。

Compatibility receipt 只证明该精确 adapter revision 能在该精确 Build 上加载，并完成所列声明交互；它不证明 adapter
语义仍然适用、状态覆盖完整或候选修改正确。Compare 必须展示两侧 compatibility receipt identity 与差异。

### 6.4 并发与 revision pinning

并发多 Session 不是当前承诺。每次顺序执行的 command 拥有独立 fresh-run workspace、Pi Session 和 SRT directories，
并记录启动时的精确 Project Environment revision。若未来支持并发 publication，才需要项目级租约/CAS；current
publication 必须持有项目级租约并进行 expected-revision CAS。CAS 冲突保留 candidate，不能覆盖另一 Session 的
revision。旧 Session 不因 current 更新而热切换。

## 7. Runtime、overlay 与 conformance

### 7.1 Managed overlay

Bridge、Adapter SDK runtime、ProjectAdapter 与可选 probe overlay 分别冻结并注入 Host-created Godot stage。Host
checkout 和 mutable candidate 不挂入 Godot sandbox；stage source 只读，`.godot` import cache、home/tmp/artifacts、operation
scratch 与 overlay 分离。Adapter 不进入候选游戏 patch。

Probe overlay 可以在 runtime-only stage 对项目源码插桩，以观测公开 API 之外的内部状态；它不能修改 Host checkout
或 managed candidate workspace。Build identity 记录被改写文件、probe patch、应用结果与已知 observer effect。
Adapter/probe 不同的 Execution 在 compare 中必须报告 confounder。首个 Preview 可以冻结该 contract 而只在一个
characterization project 中启用；不能用未实现的 probe 路径宣称已支持任意内部状态。

### 7.2 执行级 conformance

Publication 前必须至少验证：

- manifest、payload schemas、GDScript SDK 入口、预算与禁止特性；
- vanilla 与 instrumented 使用同一 source closure、独立 fresh import cache/stage 的 import/launch；
- project GDScript `@tool`/EditorPlugin 始终留在不可信 sandbox 内；
- bridge handshake、所有 realized identities 与 capability negotiation；
- Ready 最低模块的真实 observation；
- adapter 声明的每个可选 module 的成功、失败、unsupported 和 corruption 行为；
- bounded output、timeout、runtime crash、resource ownership、history loss 与 cleanup；
- publication 前 Host source 和 candidate identity 未漂移。

`ObserverEffectReceiptV1` 比较真正 vanilla 与 instrumented 的 Host 可观察 process lifecycle、startup stdout/stderr、
exit status 和资源使用；vanilla 没有 bridge 时不得声称观察了它的 SceneTree。需要比较 clock/SceneTree 时另运行
`bridge_only_baseline`，并把 generic bridge 自身记录为 instrumentation。明显破坏启动、隐藏原始 failure 或留下
额外进程时拒绝 publication。没有观察到差异只说明该 smoke window 内未发现差异，不证明 adapter 没有 observer
effect，也不要求动态项目完全等价。

## 8. 信任边界、权限、网络与设备

| 区域                                             | 信任范围                                                                                   |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| Host control plane / SRT wrapper                 | 只信其实际 SRT policy、路径、process result、staging/hash 与 publication enforcement       |
| Pi Loop / model / Agent prose                    | 作为决策者和普通内容使用；不信其环境状态、conformance、权限或 acceptance 声明              |
| ProjectAdapter / probe / project / Godot plugins | 全部是不可信同一 runtime principal；只接受经过 strict bridge validation 的有界 observation |
| Source closure / imported bundle                 | 用户授权但内容不可信；identity 与 containment 可验证，不据此信任代码行为或语义             |
| Runtime records / receipts                       | raw Harness observation 优先于 prose，但只证明所记录边界，不是游戏真值或外部 attestation   |
| Independent release validator                    | 只重算冻结 evidence；不进入产品 Loop，也不判定 adapter 语义、Bug 或候选修改正确性          |

Godot 内同进程的项目代码可能伪造、遗漏或干扰 adapter observation；bridge handshake、只读 overlay 与 content hash
不能把这些数据变成第三方可信遥测。Ready 中的 project-specific state sample 只表示 Harness 在所列 Execution 中实际
接收了 schema-valid、identity-bound adapter observation。Capture 分开报告 Harness 可计算的 transport coverage/loss 与
adapter 声明的 semantic coverage/unknown，后者不能被写成完整世界覆盖。

Adapter、probe、项目源码、日志、Godot strings、payload 和模型输出都是不可信内容，不能提升 capability 或改变
sandbox policy。current HEAD 的 SRT 使用 strict empty network allowlist，所有 sandboxed process 禁网；adapter/project
bytes 不能扩大 policy。当前没有 project network template、policy broker、domain approval UI 或 network receipt。只有
维护产品路径出现真实联网需求时，才单独设计最小授权 surface。

Source closure 所需 submodule、LFS 与 addon 必须在进入 Harness 前 materialize；初始化不以自动联网下载依赖补齐
source。凭据按工具和目标服务单独授权，永不进入 `.chronorift/`、ProjectAdapter、普通 command environment 或
Godot process。Pi credential 只供 Host 模型路径使用。

Headless 是当前默认和最低 conformance。Render/display/GPU 不属于已支持 SRT surface，不能静默打开 Host display
或 device。Process frame、physics tick、render completion 与
Host monotonic time 保持不同 clock。Audio 不属于 V1。

current SRT cutover 只提供 process timeout 与 output prefix limit，不宣称 CPU/memory/PID/storage hard quota 或通用
retention policy。若未来实现 capture/checkpoint/render artifact，容量与清理必须如实记录且不能静默删除仍被引用的
结果；这不是当前 Preview 的前置 framework。

## 9. Adapter bundle 与团队共享

Project Environment 默认 local-only。用户可以显式 export 人类可读的 `ProjectAdapterBundleV1`，其中只包含
adapter manifest/GDScript/probe/schema、SDK/toolchain requirement 和可公开的 conformance receipt；不包含 Host
path、credential、Pi Session、provider request 或项目私有 runtime artifact。

Import 只创建不可信 candidate。它必须针对当前 source closure、Godot binary、SDK/bridge、sandbox 与 policy 重新
验证，不能因 bundle 曾在另一机器 ready 就直接更新 current。团队或 CI 可以通过独立 artifact store 分享 bundle，
但 V1 不自动提交 `.chronorift/` 到游戏仓库。

`.chronorift/` 中的 unsupported schema、损坏 revision/current pointer、revision bytes 与 identity 不一致都必须显式
失败。用户可以走有审计记录的 reinitialize/recovery 路径创建新 revision；Harness 不静默重建、覆盖或把损坏 bytes
转成 candidate。

PE-A baseline freeze 同时首次冻结 project-local `project-environment-v1` store 与外部
`chronorift-project-environment-task-store-v1` Task substore。此前未发布开发 checkout 产生的两侧本地 store 都不属于
兼容输入：缺少冻结 layout、marker 或必需字段时必须 fail closed。Operator 必须分别审阅并归档 project-local 与
Host Task bytes，再协调地显式清理/重新初始化；Harness 不自动迁移、删除未知 bytes 或只清理其中一侧。PE-B 不提供
静默升级，也不原地重解释任何已冻结 revision；任一物理域发生不兼容变更都必须使用新的 namespace/marker。

## 10. 历史实现 rollout

本节解释 PE-A 至 PE-C 的历史切片，不是 current HEAD 的 backlog 或不可变完成条件。后续能力只有在真实维护路径出现
依赖时才重新评估。

### 10.1 PE-A：Author → Validate → Publish → Use

首个 Preview 只回答一个问题：**同一个正常、可见 Pi Session 能否为一个简单且已物化的 Godot 4.7 GDScript
项目生成达到最低观测门槛的 ProjectAdapter，由 Harness 验证并发布，然后在下一独立 turn 开始用户目标。**

PE-A 冻结为：clean、single-root、single project、single default launch target、headless、deny-all network；新
namespace 与严格 DTO；fresh-run physical candidate；manifest + GDScript SDK；只读 overlay；固定工具与 optional module 的
结构化 unsupported；§6.2 的 lifecycle/clock/error/entity/state/event/query/rolling-capture Ready 门槛；vanilla /
bridge-only / instrumented smoke；fully-materialized revision + atomic current-pointer switch；同一 Session 的下一
goal turn；adapter 未变化时对每个精确 candidate Build 执行 quick compatibility smoke/receipt；以及新 Task/Session
对完全未变 source 的 quick-smoke reuse，不重新生成 adapter。

PE-A 不支持 dynamic projection generalization、dirty/untracked/multi-source、addon/`@tool`、multiple launch targets、
generic failed-attempt/Session cross-command resume、source/adapter migration、compatibility failure 后的 adapter migration、并发 publication、Host
drift/refresh/apply 或 bundle。PE-A 仍冻结全部 optional deep-state DTO，并用一个预置 characterization adapter 跑通
snapshot → controlled mutation → restore → read-back；该 fixture 证明 contract 可执行，不让 snapshot 成为外部项目
Ready 要求，也不扩张为通用 snapshot 支持。安全边界不能延期：sandbox、ownership、path/schema validation、secret
rejection、bounded output、cleanup failure、corruption 和 goal-not-delivered behavior 必须随 PE-A 完成。
minimal reference package 的 `scene-root` entity 与 `project` state domain 是保留 placeholder；权威 validator
要求 publishable candidate 同时包含非 placeholder 的项目 entity type 与 state domain，不能把原样复制模板当成
Agent-authored 项目语义。
这里不包含独立 publication broker：新命令只按 path-free recovery authority 与 revision operation identity 收敛
publication/binding；它不恢复 Pi Session，也不自动投递旧 queued goal。

### 10.2 后续单轴切片

| Slice | 历史单轴增量                                                                                                        |
| ----- | ------------------------------------------------------------------------------------------------------------------- |
| PE-B  | dynamic nodes、custom Signal 与状态变化下 entity/state/event projection 的结构泛化                                  |
| PE-C  | narrow dirty closure、显式 untracked、项目选择、addon/import、default + selected target、稳定 reuse/review boundary |

旧 PE-D 至 PE-H/PE-P 仅是 2026-08-12 的设计候选，current HEAD 不承诺 generic Task resume/discard、multi-Session
workspace、network preauthorization、bundle framework 或 apply framework，也不为它们预建基础设施。

Input/probe/alignment/render 各自等待真实依赖再成为独立切片。首发仍不实现 daemon、多项目 Task、C#、GDExtension、
native plugin、audio、macOS、Windows、完整 physics/Timer/Tween/coroutine snapshot、bit-exact replay 或任意项目
零配置成功保证。

PE-C 的命令增量固定为 `--project-root RELATIVE_PATH`、可重复的
`--include-untracked RELATIVE_FILE` 和 `--launch-target TARGET_ID`。多个 `project.godot` 没有显式选择时 fail closed；
untracked 选择不写入长期 allowlist，每次 Preview/reuse 都必须重申。Adapter publication 只验证 default target 和当前
selected target，其余声明保留 `declared_unvalidated`，不能运行或复用。相同 closure 与选择允许复用；`SourceId` 变化
只返回 `review_required`，adapter review/migration 由 PE-D 实现。

PE-C 不包含完整 LFS、dirty/递归 submodule、directory symlink/cycle/race、内容级 secret 扫描、完整 quota matrix、
所有 targets × vanilla/bridge/instrumented、独立 PE-C bundle validator、product-subject git bundle 或全量 crash-cut。
这些能力只有真实项目要求时才进入后续 hardening/conformance，不是 PE-C 完成条件。

开发期通过显式 `pnpm project preview -- [GOAL] --provider ... --model ...` route 暴露已完成切片；当前 README
不得把目标 `chronorift [goal]` 写成已存在命令。Preview 只有在当前实现经过与风险相称的产品验证、默认入口边界被
明确评审并更新 README 后，才能替代 v0.4；legacy 命令届时再迁入显式 namespace。

## 11. 当前验证原则

当前 HEAD 只维护与产品实现直接相关的三层验证：默认离线 `corepack pnpm check`、Godot integration
`corepack pnpm test:godot`，以及显式的 coding/Godot sandbox Host conformance。新增或修改能力时，按实际风险增加
成功、拒绝、corruption、ownership、path containment、bounded output/storage、cleanup 和 runtime lineage 测试；没有
实际运行输出时不声明 Host 或 live conformance。

PE-A/PE-B/M4/E2/PE-C 的一次性 campaign、evidence producer、standalone validator 和专用 Host Gate 已退役。旧
结果仍位于 `docs/evidence/**`，只保留其历史语义；要重现旧工具链应使用对应历史 tag，而不是把它重新接回当前默认
Gate。产品是否可接受由用户、项目 CI、review 或独立外部 Eval 决定，不以仓库内 campaign verdict 代替。

## 12. 明确延期与非目标

- 跨命令 open-Execution durable cleanup owner 与 Host `SIGKILL` 后的长期 runtime reconciliation；
- C#/.NET、GDExtension、native library/plugin 与未知 engine build；
- macOS、Windows、WSL2 及其等价 sandbox；
- audio、默认 display/GPU、完整视觉诊断；
- 任意项目完整 snapshot、physics internals、Timer/Tween/coroutine、线程、外部服务或全局 Signal 拦截；
- adapter 自定义 Pi tools、自由 runtime code execution、任意场景路径或未验证 launch 参数；
- sandboxed run 自动获取 source dependency 或未经用户授权自动扩大网络；
- daemon、多客户端共享 workspace、跨项目 Task 或多 Agent；
- 自动 commit、merge、push、部署或 canonical Bug/fix verdict；
- hidden evaluator、campaign denominator、独立 acceptance 或大规模项目成功率 benchmark。

Project Environment V1 的完成标准是一个安全、真实、可审阅的项目环境闭环，不是“Agent 已经理解整个游戏”。
Agent 可以在后续任务中持续深化同一个 ProjectAdapter；每次 revision、能力变化和 observation gap 都必须可见。
