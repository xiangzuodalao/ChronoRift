# ChronoRift

[English](README.en.md) · [工程设计导览](docs/portfolio.md) · [GN-1 案例](docs/case-studies/gn1-platform-alias.md) · [Godot Demo V2 切片](docs/case-studies/godot-demo-mob-orientation.md)

[![CI](https://github.com/xiangzuodalao/ChronoRift/actions/workflows/ci.yml/badge.svg)](https://github.com/xiangzuodalao/ChronoRift/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

**让 coding agent 从源码猜测走向可执行的 Godot 运行时证据。**

Pi 负责 Agent Loop；ChronoRift 使用固定版本的 Anthropic Sandbox Runtime（SRT）约束文件、命令和 Godot 操作，并向
Agent 返回 Build-bound runtime state、实际 diff 和 tool result。Agent 自由选择调查和修改策略，最终 acceptance 仍属于
项目 CI、独立 Eval 或人工 review。

> **结果优势 — GN-1：** 在相同源码、prompt、model、thinking、timeout 和共享工具下，coding-only candidate 的
> geometry oracle 为 `false`；ChronoRift Agent 查询真实 platform geometry 和 Shape identity 后产生不同候选，oracle
> 为 `true`。
>
> **跨项目验证 — Godot Demo V2：** 在第二个真实上游项目中，ChronoRift Agent 调用 13 次 V2 game tools，查询修改前
> 14 个、修改后 5 个 Mob state，候选通过独立 evaluator 3/3。Coding-only 也通过 3/3，因此本案例证明产品路径复用，
> 不证明总体修复优势。

**截至 2026-08-27：** `v0.4.0` 是当前 legacy release，Project Environment 是实验性 Preview。默认
`chronorift [goal]`、任意 Godot 项目支持和自动“修复成功”判定尚未实现。

![ChronoRift 技术概念图：隔离的 Godot runtime、baseline/candidate 执行与运行记录](docs/assets/chronorift-hero.jpg)

_概念插图，用于表达产品母题；不是产品界面、运行截图或实验凭据。[查看 2560×1280 master](docs/assets/chronorift-hero-master.jpg)。_

## 两分钟看懂

![ChronoRift high-level 架构](docs/assets/chronorift-architecture.png)

ChronoRift 不重做 Coding Agent：Pi SDK 负责模型、session 和工具调度；ChronoRift 提供 Loop 外的 workspace、
sandbox、Godot execution 和 runtime evidence。

- **A · 调试回路：** Agent 修改可写 candidate、执行 Godot，并根据 runtime observation 继续迭代；observation 是
  调试信号，不是 verdict。
- **B · 独立验证：** Godot validation 使用独立的只读 stage；当前固定案例的 evaluator 只在 Agent 结束后运行，
  不参与修复。Patch round-trip 与 evaluator 是两项独立检查。
- **Acceptance 在 Loop 外：** `completed` 不等于 `fixed`；最终结果由项目 CI、外部 Eval 或人工 review 决定。

**核心价值：** 一致执行、工作区隔离、运行时证据和可独立审阅的验证。

完整目标契约见 [架构文档](docs/architecture.md)；它描述 vNext 方向，不等于当前功能清单。

Project Preview 可选 `--multi-agent`：Root Pi Session 委派独立子会话，每个子代理拥有自己的 candidate 和 Godot
执行。Host 隔离工具权限、收集结果；Root 显式导入候选后重新验证。默认最多 2 个子代理，支持持续会话、消息、等待和
取消。使用方法及限制见 [Multi-Agent V1](docs/multi-agent.md)。

## Runtime evidence 改变候选：GN-1

GN-1 中，coding-only 产生了一个看似合理的宽度调整，但 candidate runtime 仍保留共享 Shape identity，case-level
oracle 为 `false`。ChronoRift Agent 查询了 realized geometry 和 resource identity，候选改为隔离共享 Shape resource，
oracle 为 `true`。

两个 fresh arm 固定 `endlessm/moddable-platformer` 的同一 commit/tree，并共享中性 prompt、model、thinking、timeout
和普通工具；`chronorift` arm 只增加四个 game tools 及其既有简洁 metadata。

| Arm           | Agent 可见的额外 runtime surface                              | Candidate 的 Host geometry observation                              | Case-level oracle |
| ------------- | ------------------------------------------------------------- | ------------------------------------------------------------------- | ----------------- |
| `coding-only` | 无                                                            | 四个 area width 均为 682 px，resource identity 仍共享               | `false`           |
| `chronorift`  | `game_capabilities`、`game_launch`、`game_stop`、`game_query` | area width 与 128/256/384/768 px 的 solid width 对齐，identity 分离 | `true`            |

## 第二项目复用：Godot Demo V2

在固定的 `godot-demo-projects/3d/squash_the_creeps` revision 上，公共 V2 loader、managed runtime、sandbox、lineage
和 game tools 完成了第二项目的端到端运行。

| 产品事实                   | 正式结果                                                     |
| -------------------------- | ------------------------------------------------------------ |
| Agent-visible runtime 使用 | 13 次 V2 game-tool call；initial 14 条、candidate 5 条 state |
| ChronoRift candidate       | 独立 Godot evaluator 3/3                                     |
| 第二项目 runtime 路径      | source、Build、Execution、patch、cleanup 均有绑定记录        |
| 比较性 Hero gate           | 未晋级；coding-only 也产生同义修复并通过 3/3                 |

Treatment 的完整增量包含四个 game-tool definitions 及其 metadata，以及两行中性的 discoverability appendix；这不是
tool-only comparison，结果不能归因于单独的 game tools。

本轮的价值是证明 ChronoRift 的 runtime 产品边界不只存在于 GN-1；它不承担比较优势结论。详细页完整保留两个原始
candidate patch 与 evaluator stdout，并汇总耗时、成本、本地 raw records 中的失败 tool response 和运行限制。

## License

ChronoRift 自有代码采用 [Apache License 2.0](LICENSE)。两个 case 的候选 patch 均派生自 MIT 许可的上游项目，归属和许可
单独记录在 [Third-Party Notices](THIRD_PARTY_NOTICES.md) 与案例目录中。
