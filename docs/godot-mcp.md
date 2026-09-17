# Godot AI MCP Preview

`project preview` 默认通过已安装的 `pi-mcp-adapter@2.34.0` 接入
[godot-ai v4.1.0](https://github.com/hi-godot/godot-ai/tree/v4.1.0)。Pi SDK 固定为 `0.84.1`，
Godot 固定为官方 Linux x86_64 `4.7.1`。ChronoRift 管理环境和权限，Pi 负责发现、调用 MCP 工具以及呈现图片；
没有另外维护一套 GameTools schema 或 Agent Loop。视觉调查需要支持图片输入的模型；
仅文本模型仍可使用代码和状态工具。

## 安装与运行

需要 Linux x86_64、可用的 SRT/Bubblewrap 用户命名空间、`socat`、`rg`、Xvfb、Mesa 软件渲染、系统 Python 3 和 `uv`。
安装阶段需要网络；游戏和 coding 进程没有外网权限。安装器下载并校验固定插件 archive，创建私有 Python 3.12.13
环境，再按 `scripts/godot-mcp-requirements.txt` 安装固定版本依赖。

```bash
sudo apt-get install bubblewrap socat ripgrep xvfb libgl1-mesa-dri fontconfig xdg-user-dirs
corepack pnpm godot:install -- --with-mcp
corepack pnpm godot:doctor -- --with-mcp
corepack pnpm project preview -- "复现角色移动异常，修复后再次运行验证" \
  --provider PROVIDER --model MODEL --game-backend godot-ai
```

`godot:doctor --with-mcp` 检查本地版本、插件文件和 Xvfb 可执行文件；它不是游戏兼容性或完整图形栈验收。
真实环境闭环由 `.github/scripts/run-srt-sandbox-conformance.sh` 验证。缺少 Corepack 但依赖已安装时可用
`npm run <script>`；Conformance 脚本有相同 fallback。

默认依赖目录为 `.tools/godot-ai/4.1.0`。Host 可通过 `CHRONORIFT_GODOT_AI_HOME`、`CHRONORIFT_XVFB_BIN`
指定安装和 Xvfb 位置；项目不能设置这些权限。已有安装不覆盖，先 doctor，再由用户显式管理版本目录。

| 后端               | 工具与用途                                                                             |
| ------------------ | -------------------------------------------------------------------------------------- |
| `godot-ai`（默认） | Root 使用上游 MCP 的场景、节点、脚本编辑，运行、状态、输入、求值和截图能力             |
| `inspection`       | 显式回退到已有 `game_launch`、`game_query`、`game_stop`；保留独立只读运行 stage        |
| `none`             | 不注册托管游戏工具，提供 coding-only 对照入口；仍使用相同私有 workspace 和 coding 沙箱 |

上游的完整工具面通过标准 `mcp` gateway 搜索、描述和调用，例如先搜索 `screenshot`，查看 schema，再调用结果中的工具。
常用的 9 个上游工具（editor_state、project_run、project_manage、game_manage、editor_manage、editor_screenshot、script_patch、logs_read、scene_open）
在模型轮次开始前以原生 schema 直接注册；可直接调用，无需先搜索或逐个 describe。其余工具仍通过 gateway 发现和调用。
这些 schema 来自当前固定的上游服务，不在 ChronoRift 中复制维护。ChronoRift 不替模型编排调查步骤。MCP 服务安装、认证和任意新增服务属于 Host 管理，模型无法通过 gateway 改变它们。

常用工具的 Pi 提示补充固定上游版本的作用域、输入和求值限制；参数与原始返回仍由 adapter 和 godot-ai 提供。
Pi 自主选择是否使用运行时工具，这些说明不要求固定的调查步骤。

## 环境与写入衔接

每次 Preview 从已准入源码建立新的私有 candidate。编辑器与 coding 工具读写这一个副本，原 checkout 不变。
准备时只启动 MCP 服务和虚拟显示；查询工具目录、参数或 MCP 连接状态不打开 Godot 编辑器。首次实际 Godot 工具调用才打开编辑器。
启动前注入固定 godot-ai addon 和 runtime helper，结束时移除本轮注入的文件与配置，提取并 round-trip 校验候选 patch。
已有同名 addon 必须匹配固定 release；冲突会明确报错。

Host 已确认编辑器关闭时，参数校验通过的单独 `project_manage(op=stop)` 返回明确标记的 Host「已停止」结果，
不为了停止而打开编辑器。其他请求仍使用上游工具；启动失败不会被记作就绪，后续显式调用可以重试，修改操作不会自动重放。
编辑器启动等待 `readiness=ready` 或 `no_scene`，导入中继续等待；空编辑场景是合法状态。
这项判断只确认编辑器可用，游戏 helper、当前游戏场景和目标节点需要另行观察。

MCP 后端、Godot 编辑器、游戏和 Xvfb 在同一个 SRT 隔离环境内，通过隔离网络命名空间的 loopback 通信。
Host 提供 mode 0700 目录中的 Unix socket；有界管道帧只转发原始 MCP 字节，沙箱仍禁止创建 Unix socket。
Host 的模型凭据、Pi MCP 配置与缓存不进入这个环境。每个 Host 进程只允许一个托管 MCP Root；
各代理的认证目录在加载扩展前固定，避免扩展的私有 metadata cache 设置影响 worker 认证。没有接入用户桌面，也没有实时游戏窗口 UI。

Root 独占 MCP；worker 只有 coding 与协作工具。任何代理执行 `bash`、`edit` 或 `write` 前，Host 都会：

1. 停止正在运行的游戏。
2. 保存所有有路径的打开场景；无法保存时阻止这次代码操作。
3. 关闭编辑器，然后执行 coding 操作。
4. 下次实际 Godot 工具调用时重新从磁盘打开编辑器并恢复活动场景；搜索、列目录、describe 不触发编辑器重启。游戏需重新 `project_run`，此前的 session ID 不能复用。

保存时先直接保存已经活动的场景，再打开并保存其余场景；每次都核对实际保存路径。
场景清单不一致、无路径场景或保存失败仍会阻断 coding 操作。

`read`、`grep`、`find` 和 `ls` 不关闭编辑器，但只看到磁盘内容。调查期间优先用这些工具读取源码；
任意 `bash`（包括只读 shell 命令）仍会关闭游戏和编辑器，不通过猜测命令是否只读来放宽安全边界。代码读写与 MCP 调用串行化；这不提供跨多次调用的事务，
也不消除代理之间的业务覆盖冲突。无路径的新场景应先通过 MCP 显式保存。异常退出可能丢失未保存的编辑器内存状态，
结果会保留失败信息，不能把进程退出当作保存成功。

Root 可用 Host 工具 `environment_wait({duration_ms: 0..10000})` 等待而不关闭游戏；`0` 只读取 Host 已知的编辑器状态。
该工具计入共享调用预算、支持取消，返回实际 Host 等待时长和编辑器实例代次；它不保证游戏 helper 已就绪，也不表示推进了多少物理帧。
发生关闭的 coding 工具结果会追加运行状态失效提示，保留原始结果；请显式重新运行游戏，不复用旧运行时引用。

同一 Preview 的 Godot `user://` 磁盘数据通过独立的 `XDG_DATA_HOME` 目录跨编辑器重启保留；新的 Preview 使用空目录，结束时删除。
这个目录只挂载到托管编辑器沙箱，原 checkout、Host 凭据和 adapter cache 不进入其中。它不恢复内存状态、角色位置或节点引用，
也不额外授权项目自定义的外部存档路径。

## 证据与限制

新后端和 `none` 输出 Preview V6，包含 `gameBackend`、`workspaceMode`、执行预算、Session、候选 patch 与实际结束状态。
MCP 环境另外写入 `godot-mcp.v1.json` 生命周期记录（区分 backend_ready 与 editor_ready，工具记录 requiresEditor）、各次编辑器启动的有界日志；原始工具返回和图片进入 Pi Session。
任务 records 中的 `preview-phases.v1.json` 分别记录 preflight、materialize、环境准备、Pi 调用、清理和补丁导出。
Pi 调用包含 Session 初始化和关闭，不能直接等同于纯模型时间；工具总耗时包含其触发的启动等待，不要与启动耗时重复相加。
`inspection` 和历史案例保留旧格式与语义。

控制失败记录可附带有界诊断：操作、阶段、实际耗时与超时预算、展开后的异常类型和消息，以及临时 attach 的 stderr 摘要。
stderr 持续排空，完整行脱敏后立即保存，每进程最多 1 MiB；单行超过 16 KiB 时整行丢弃。超限和未完整收集均有标记。
异常组不会仅剩一个 TaskGroup 摘要，普通连接错误也不会被自动归类为超时。

Host 预检可使用 `@chronorift/pi-harness` 的 `createManagedMcpProbe`：与正式 Session 共用初始化、已注册 adapter 工具、参数验证和扩展 hooks，
提供 `tools()`、`execute({id, name, args, signal?})` 和 `close()`。它使用内存 Session 和空凭据，不发模型请求。
新缓存下先通过 `mcp` 查询目录等待工具注册；目录查询不开编辑器。调用者负责准备及关闭沙箱环境，先关闭 probe 再关闭环境。
该接口执行正式工具路径，不运行 Agent Loop；预检仍须检查实际状态和后置条件，不能只看工具是否返回错误。

图形测试验证一个真实 fixture 的节点创建、场景保存、代码修改后重启、游戏输入、状态读取和 PNG 截图；
离线 Pi 测试验证扩展发现、调用和图片内容传递。它们不证明任意 Godot 项目都兼容，也不证明总体修复率或耗时提升。
上游 game sequence 的 process frames 不等于确定性的 physics ticks；截图只证明相应时刻的画面。
GUI 键盘交互使用 `game_manage input_key`；`input_action` 修改 Input action state，并不等价于 GUI 按键事件。
图片是否过期、游戏是否就绪须依据实际返回判断。本轮未修改上游鼠标移动的拖拽事件语义，不能据此宣称修复了拖拽能力。
当前没有通用 checkpoint/restore、确定性 replay、实时视频或自动修复 verdict。

运行时查询的 `root_path` 为空或 `/` 时，`get_scene_tree` 和 `get_ui_elements` 从当前场景开始，通常不包含 autoload。
autoload 使用显式 `/root/<名称>` 路径。需要发现这些节点时，短 `game_eval` 可以从 `get_tree().root.get_children()`
收集节点的 `get_path()`；不要把编辑器场景路径和运行时绝对路径混用。

相关状态可以通过一次短 `game_eval` 一起返回。多档采样要用多行循环收集结果，并在循环结束后返回数组；以实际返回的样本数量和值判断覆盖范围。
修改窗口尺寸后，应分别读取 `DisplayServer.window_get_size()` 和 `get_viewport().get_visible_rect().size`，不能将请求尺寸当作实测 viewport。
固定上游对求值中的等待设有 8 秒超时；它无法抢占不让出主线程的死循环，Host 的调用超时也不代表该循环已经结束。
较长过程可以分为触发操作和后续短查询；返回成功并不保证请求中的所有观察都已执行。

`input_sequence` 按 process frames 安排 `Input` action，不发送物理按键、手柄或触摸事件，也不提供确定性的 physics ticks。
涉及 GUI 输入或输入来源冲突时，动作时间线不能替代相应的真实事件路径。`batch_execute` 供适用的编辑器命令使用，不能嵌套运行时 game operations。
`project_run` 返回启动尝试的回执；`game_status`、`helper_live` 和后续 `editor_state` 提供不同时刻的就绪观察。
helper 上线仍不能证明目标场景、控件或所需业务状态已经就绪。

比较优势需要另外进行受控实验：相同源码、任务、模型、thinking、执行预算和独立验收，分别运行 `godot-ai` 与 `none`，
记录环境冷启动和总耗时、到首次复现的时间、最终独立验收、模型用量及失败/超时。不得只比较成功样本，
也不得把额外 MCP 工具调用次数当成效率。本次实现不自动发起付费模型实验。
