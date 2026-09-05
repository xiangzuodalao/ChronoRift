# City Builder：现有工具在一个新项目中的调查与修复

**2026-09-05，一组真实 Pi 对照，两组均首次通过独立验收。** 在没有参与 ChronoRift 接口设计的
`KenneyNL/Starter-Kit-City-Builder` 中，两组 Agent 产出了逐字节相同的修复：选中项不变时跳过预览重建，
保留初始化、切换与首尾循环。ChronoRift 产品源码、工具和协议没有为这个项目修改。

| 独立验收                              | 原版   | coding-only 候选 | ChronoRift 候选 |
| ------------------------------------- | ------ | ---------------- | --------------- |
| 场景检查                              | 31/66  | 66/66            | 66/66           |
| 首次空闲 120 次 `_process` 中新增预览 | 120    | 0                | 0               |
| 同一窗口中移除预览                    | 120    | 0                | 0               |
| 初始化、15 种模型双向切换及回绕       | 通过   | 通过             | 通过            |
| 双键抵消、旋转及切换后的身份稳定      | 未通过 | 通过             | 通过            |

这次对照没有显示修复结果优势。它展示的是：现有 Preview 在一个未用于接口设计的外部项目中可直接使用，
Agent 自主读码、修改并查询候选运行状态，最终候选可以由独立检查器复查。
66 项是相关的场景断言，不是 66 次独立实验；没有测量 CPU、FPS、像素画面或完整玩法。

## 固定条件与人工工作

- 上游提交 [`4535092b740b378b700efd9df9e27a631815b84a`](https://github.com/KenneyNL/Starter-Kit-City-Builder/tree/4535092b740b378b700efd9df9e27a631815b84a)，
  默认主场景与 Audio Autoload 保留；上游声明 Godot 4.6，本次实际运行 Godot 4.7.1。
- ChronoRift 产品基于 `2bb303b68891861cb9cc04934a88939d2b33b691`，使用现有源码；新增的是案例目录中的
  [运行脚本](city-builder-preview/run.mjs)、[检查器](city-builder-preview/independent-check.gd)和材料。
- 两组均为 `openai-codex / gpt-5.6-luna / max`，Pi 0.83.0、SRT 0.0.74、Node 22.23.1；每组一次全新会话，
  600 秒、所有工具合计最多 256 次调用。先 coding-only，后 ChronoRift，没有人工续轮或后续修复会话。
- 两组经过同一个 Preview 的源码准备、私有候选、沙箱与 patch 导出路径。coding-only 仅移除
  `game_launch / game_query / game_stop` 及其说明；游戏调用计入 ChronoRift 组的同一预算。
- 操作者事先阅读了上游源码并准备独立验收。项目不是盲选；检查器、分析和另一组结果没有进入任一 Agent 环境。
  两组无祖先上下文文件，正常 Pi 的两个通用 skills 保留且哈希一致。详情见[来源与边界](city-builder-preview/provenance.json)。

共同的唯一用户目标：

> 建筑预览在空闲时似乎反复重建。请调查并作最小合理修复：选中建筑不变时避免重复重建，同时保留初始化显示、前后切换及首尾循环时的正确更新。自行选择调查、修改和验证方式，并说明实际验证结果与未覆盖部分。

## Agent 实际做了什么

两组都从源码定位到：`_process()` 每帧调用切换处理函数，而该函数末尾无条件重建预览。
它们都在处理输入前保存 `previous_index`，在两个输入分支处理后仅当 `index != previous_index` 时更新。
`_ready()` 的初始更新没有改变；同帧前后输入相互抵消时也不会重建。
[coding-only patch](city-builder-preview/coding-only/candidate.patch)与
[ChronoRift patch](city-builder-preview/chronorift/candidate.patch)各 755 字节，只修改同一个游戏脚本。

coding-only 用了 22 次调用，约 102.8 秒。它完成源码和 diff 检查，并明确报告工具环境中找不到 Godot，
没有声称做过运行时验证。其四次失败命令包括 Git 外部 diff 配置错误、参数位置错误和两次自写静态计数断言失败。

ChronoRift 用了 35 次调用，约 143.0 秒，其中 10 次为游戏操作。**先修改，再启动候选**：第一次运行查询
预览子节点和 `index`；第二次运行又补充了间隔查询。在同一执行中，process frame 657 与 1777 的预览引用均为
`object.3`，子节点数量均为 1；对应 frame 658 与 1778 的 `index` 都为 0。没有人工追加提示。

这些采样支持候选在两个采样点保留同一预览对象；完整生命周期计数来自后面的独立检查。
Agent 没有运行原版，也没有通过运行时观察定位根因。两次 `read offset=0` 拒绝和三次 Git 命令失败均保留。
具体顺序、帧计数和异常见[调用导览](city-builder-preview/trace.md)及两组完整工具摘录。

**Agent 最终文字有一处需要纠正：**它写了 Godot“退出码 0”，但两个 Preview 游戏进程均由 `game_stop`
以 `SIGTERM` 停止，实际字段为 `run.signal=SIGTERM`、`run.exitCode=null`。记录顶层的 `exitCode=0` 属于
运行 wrapper，不能当作 Godot 子进程自然退出 0；导入和后来的独立检查也有各自的退出状态。
[第一次记录](city-builder-preview/chronorift/runtime-records/execution-1.json)、
[第二次记录](city-builder-preview/chronorift/runtime-records/execution-2.json)保留实际结果；没有改写 Agent 原文。

## 独立验收怎样工作

检查器在模型调用前冻结，先确认原版缺陷和几种[开发控制变体](city-builder-preview/checker-controls.json)，
两组结束后再检查原始候选。它不读取 Agent 回复，也不要求补丁使用 `previous_index` 这个写法。

检查器使用现有 SRT runner：补丁只在私有候选中应用；原生导入后建立另一份只读运行副本并核对源码哈希。
默认主场景和 Audio Autoload 正常加载。观察器在 Builder 的 `_process` 之后采样，记录预览容器的子节点进入、
退出事件、模型来源、实例身份、偏移和选择状态。`Input.action_press/release` 驱动真实输入处理路径。

66 项包含初始化、初始空闲 120 次 process 完成、15 种模型的双向完整遍历及每次切换后 3 次空闲处理、
同帧相反输入、旋转及旋转后空闲 120 次处理。process 完成次数、引擎 process frame、physics tick 分别保存；
初始 120 次完成时，引擎 process frame 从 0 到 119，不能将这两个计数混为一谈。

| 记录                                                                         | 用途                                   |
| ---------------------------------------------------------------------------- | -------------------------------------- |
| [原版检查](city-builder-preview/independent/baseline/result.json)            | 确认原始缺陷和未损坏的初始化、切换行为 |
| [coding-only 检查](city-builder-preview/independent/coding-only/result.json) | 对保存的原始候选逐项验收               |
| [ChronoRift 检查](city-builder-preview/independent/chronorift/result.json)   | 应用完全相同的检查与判定               |

三个检查的导入均成功、运行源码完整性均通过；两个候选检查进程退出 0。检查器的输入驱动、事件计数属于案例验收代码，
不是 Preview 暴露给 Agent 的新功能。退出清理在保存观察后停止音频并释放场景，避免循环 ambience 的退出资源残留；
开发期错误记录保留在本地，未通过过滤错误来制造通过。

## 无需模型凭据的复查

在本仓库根目录执行，先按[开发指南](../development.md)准备 Node 22.23.1、固定依赖、Godot 4.7.1、Bubblewrap、
socat 和可用的用户 namespace。下列命令只检查已经保存的补丁，不重新调用模型：

```bash
CITY_STATE="$(mktemp -d /tmp/chronorift-city-review-XXXXXX)"
git clone https://github.com/KenneyNL/Starter-Kit-City-Builder.git "$CITY_STATE/source"
git -C "$CITY_STATE/source" checkout --detach 4535092b740b378b700efd9df9e27a631815b84a
export GODOT_BIN="$PWD/.tools/godot/4.7.1/Godot_v4.7.1-stable_linux.x86_64"

node --import tsx docs/case-studies/city-builder-preview/check.mjs \
  --project "$CITY_STATE/source" --godot-bin "$GODOT_BIN" \
  --output "$CITY_STATE/baseline"
# 原版预期退出 1：场景断言失败。退出 2 表示需要检查环境或记录，不能当作复现成功。

node --import tsx docs/case-studies/city-builder-preview/check.mjs \
  --project "$CITY_STATE/source" --godot-bin "$GODOT_BIN" \
  --candidate-patch docs/case-studies/city-builder-preview/coding-only/candidate.patch \
  --output "$CITY_STATE/coding-only-check"

node --import tsx docs/case-studies/city-builder-preview/check.mjs \
  --project "$CITY_STATE/source" --godot-bin "$GODOT_BIN" \
  --candidate-patch docs/case-studies/city-builder-preview/chronorift/candidate.patch \
  --output "$CITY_STATE/chronorift-check"
```

候选预期退出 0。输出目录必须不存在且位于源码目录外；检查器拒绝脏 baseline、危险文件和不安全的输出位置。
原始 stdout、stderr、进程结果及检查结果保存在指定目录，源 checkout 保持不变。

## 重新运行真实调查

复用上面的干净源码目录。这两个命令会使用 Host 上配置的 Pi 认证并调用真实模型，生成新记录，不能视作原会话重放：

```bash
node --import tsx docs/case-studies/city-builder-preview/run.mjs \
  --arm coding-only --project "$CITY_STATE/source" --godot-bin "$GODOT_BIN" \
  --output "$CITY_STATE/coding-only-live"
node --import tsx docs/case-studies/city-builder-preview/run.mjs \
  --arm chronorift --project "$CITY_STATE/source" --godot-bin "$GODOT_BIN" \
  --output "$CITY_STATE/chronorift-live"
```

模型、目标和预算在案例脚本中固定。模型输出可能不同；保留每次实际记录。仓库中的 JSON 是公开摘录，保留全部工具请求、
可用返回和错误，省略 thinking、原始模型请求与私有路径；原始 Session 和完整开发记录留在本地。
补丁与源码摘录的许可见 [Third-Party Notices](../../THIRD_PARTY_NOTICES.md)。

本次工程验证：lint、类型检查、911 项离线测试、20 项 Godot 测试、7 项沙箱测试和 8 项案例脚本测试通过。
`corepack pnpm check` 在格式检查阶段被三个任务开始前已有的未跟踪架构图文件阻断；这些文件保持原样，
其后的类型检查与离线测试已单独执行。本次改动单独检查格式，具体记录见[验证摘要](city-builder-preview/validation.json)。

[简历要点、三分钟讲稿与面试追问 →](city-builder-preview/interview.md)
