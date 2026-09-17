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
ChronoRift 不替模型编排调查步骤。MCP 服务安装、认证和任意新增服务属于 Host 管理，模型无法通过 gateway 改变它们。

## 环境与写入衔接

每次 Preview 从已准入源码建立新的私有 candidate。编辑器与 coding 工具读写这一个副本，原 checkout 不变。
启动前注入固定 godot-ai addon 和 runtime helper，结束时移除本轮注入的文件与配置，提取并 round-trip 校验候选 patch。
已有同名 addon 必须匹配固定 release；冲突会明确报错。

MCP 后端、Godot 编辑器、游戏和 Xvfb 在同一个 SRT 隔离环境内，通过隔离网络命名空间的 loopback 通信。
Host 提供 mode 0700 目录中的 Unix socket；有界管道帧只转发原始 MCP 字节，沙箱仍禁止创建 Unix socket。
Host 的模型凭据、Pi MCP 配置与缓存不进入这个环境。每个 Host 进程只允许一个托管 MCP Root；
各代理的认证目录在加载扩展前固定，避免扩展的私有 metadata cache 设置影响 worker 认证。没有接入用户桌面，也没有实时游戏窗口 UI。

Root 独占 MCP；worker 只有 coding 与协作工具。任何代理执行 `bash`、`edit` 或 `write` 前，Host 都会：

1. 停止正在运行的游戏。
2. 保存所有有路径的打开场景；无法保存时阻止这次代码操作。
3. 关闭编辑器，然后执行 coding 操作。
4. 下次 MCP 调用时重新从磁盘打开编辑器并恢复活动场景；游戏需重新 `project_run`。

`read`、`grep`、`find` 和 `ls` 不关闭编辑器，但只看到磁盘内容。代码读写与 MCP 调用串行化；这不提供跨多次调用的事务，
也不消除代理之间的业务覆盖冲突。无路径的新场景应先通过 MCP 显式保存。异常退出可能丢失未保存的编辑器内存状态，
结果会保留失败信息，不能把进程退出当作保存成功。

## 证据与限制

新后端和 `none` 输出 Preview V6，包含 `gameBackend`、`workspaceMode`、执行预算、Session、候选 patch 与实际结束状态。
MCP 环境另外写入 `godot-mcp.v1.json` 生命周期记录、各次编辑器启动的有界日志；原始工具返回和图片进入 Pi Session。
`inspection` 和历史案例保留旧格式与语义。

图形测试验证一个真实 fixture 的节点创建、场景保存、代码修改后重启、游戏输入、状态读取和 PNG 截图；
离线 Pi 测试验证扩展发现、调用和图片内容传递。它们不证明任意 Godot 项目都兼容，也不证明总体修复率或耗时提升。
上游 game sequence 的 process frames 不等于确定性的 physics ticks；截图只证明相应时刻的画面。
当前没有通用 checkpoint/restore、确定性 replay、实时视频或自动修复 verdict。

比较优势需要另外进行受控实验：相同源码、任务、模型、thinking、执行预算和独立验收，分别运行 `godot-ai` 与 `none`，
记录环境冷启动和总耗时、到首次复现的时间、最终独立验收、模型用量及失败/超时。不得只比较成功样本，
也不得把额外 MCP 工具调用次数当成效率。本次实现不自动发起付费模型实验。
