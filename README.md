# ChronoRift

[English](README.en.md)

[![CI](https://github.com/xiangzuodalao/ChronoRift/actions/workflows/ci.yml/badge.svg)](https://github.com/xiangzuodalao/ChronoRift/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

**让 coding agent 看见 Godot 的运行时状态。**

碰撞范围为什么比画面更宽？不同实例是否共享了同一个资源？ChronoRift 为 coding agent 提供运行游戏、检查对象和
验证候选修改的工具，让源码分析可以与实际运行状态相互核对。

这是一个聚焦 **Agent Harness 与游戏运行时调查** 的工程作品，基于 TypeScript、Pi SDK、Godot 与
Anthropic Sandbox Runtime（SRT）。

![ChronoRift：隔离的游戏运行环境与运行状态检查](docs/assets/chronorift-hero.jpg)

_产品概念插图，非界面截图或实验记录。_

## 当前能力

实验性 `project preview` 将用户目标直接交给 Pi，保留普通 coding tools，并增加三个游戏工具。
Agent 自行选择如何调查、修改和验证，无需为项目编写 Adapter。

| 工具          | 作用                                           |
| ------------- | ---------------------------------------------- |
| `game_launch` | 从当前候选创建独立运行副本，启动默认主场景     |
| `game_query`  | 检查子节点、属性，以及保留身份的对象与资源引用 |
| `game_stop`   | 停止执行，保存实际运行记录                     |

例如，Agent 可以读取 `CollisionShape2D.shape`，再查询该资源的 `size`，检查碰撞尺寸与资源是否共享。
修改候选后重新启动，已有运行不会被后续文件编辑改变。

当前支持 Linux x86_64、Godot 4.7.1 GDScript 项目，仍有项目准入限制。
**查询只读取当前状态**；时间窗口、历史回看、probe 和输入控制尚未实现。
已发布的 `v0.4.0` 是独立的 legacy 路径，不代表 Preview 的产品形态。

## 核心设计

- **Pi 负责决策，Harness 负责执行。** 保留 Pi 的 Session、模型调用与工具调度，不把调查写成固定脚本。
- **编辑与运行隔离。** Agent 在私有候选工作区改代码；原生导入使用一次性副本，校验后再建立只读游戏运行副本。
  coding 与 Godot 操作经过 SRT、默认禁网，模型凭据留在 Host。
- **交付可审阅的结果。** 保留实际 patch、Session 与运行记录，包括失败、超时和输出截断。
  `completed` 不等于修复通过；最终验收由项目测试或人工审阅决定。

[查看设计取舍与代码入口 →](docs/portfolio.md)

## 案例

### 当前 Preview：GN-1 无 Adapter 调查

真实 Pi 从“玩家仍在平台可见宽度外就触发下落”的症状出发，自主找节点、查询 Shape 引用与尺寸，
修改一行源码，再重启查询。会话结束后的独立检查中，原始版本不满足初始几何／资源身份要求，保存的候选满足。

公开材料包含真实调用摘录与异常、实际 patch、独立检查器和五步截图回放。
提供**不需要模型凭据的候选复查命令**；它检查保存的修改，不假装重新跑模型。
这是**功能演示与回归案例**：GN-1 参与过接口设计，不是未知项目泛化证明，也没有验证完整 gameplay 时序。

[查看新 Preview 案例、截图和可运行检查 →](docs/case-studies/gn1-preview.md)

### 历史 GN-1：共享的碰撞资源

在 `endlessm/moddable-platformer` 中，四个平台的触发区共享 Shape，使较窄平台的触发区超出可见宽度。
一组固定条件的对照中，coding-only 候选仍保留共享资源；ChronoRift Agent 查询运行时几何与资源身份后，
产出的候选隔离了 Shape，并通过该案例的几何与身份检查。

这是事后选取的 **N=1 定性案例**，不代表通用修复率或总体优势。

[查看候选 patch、检查结果与案例边界 →](docs/case-studies/gn1-platform-alias.md)

### 历史 Godot Demo：第二个项目中的运行时检查

在 `squash_the_creeps` 中，Agent 使用公共 V2 runtime 路径检查 Mob 朝向与速度，并在修改前后查询状态。
ChronoRift 与 coding-only 候选都通过了独立检查（各 **3/3**）：展示了第二项目的路径复用，没有显示比较优势。

[查看调查过程与两组结果 →](docs/case-studies/godot-demo-mob-orientation.md)

以上两个历史案例使用早期的项目专用 Adapter，不是当前无 Adapter Preview 的泛化验证。
公开材料包含候选 patch 与检查摘要，完整原始会话未公开。

## 深入了解

- [架构与实现状态](docs/architecture.md)：运行时边界、模块职责和当前限制。
- [开发与验证指南](docs/development.md)：环境准备、Preview 入口及离线、Godot、沙箱测试。

## License

项目代码采用 [Apache License 2.0](LICENSE)。案例 patch 派生自 MIT 许可的上游项目，
归属与许可见 [Third-Party Notices](THIRD_PARTY_NOTICES.md)。
