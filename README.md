# ChronoRift

[English](README.en.md) · [工程设计导览](docs/portfolio.md) · [GN-1 案例](docs/case-studies/gn1-platform-alias.md) · [Godot Demo V2 切片](docs/case-studies/godot-demo-mob-orientation.md)

[![CI](https://github.com/xiangzuodalao/ChronoRift/actions/workflows/ci.yml/badge.svg)](https://github.com/xiangzuodalao/ChronoRift/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

**让 coding agent 从源码猜测走向可执行的 Godot 运行时证据。**

Pi 负责 Agent Loop；ChronoRift 使用固定版本的 Anthropic Sandbox Runtime（SRT）约束文件、命令和 Godot 操作，并向
Agent 返回 Build-bound runtime state、实际 diff 和 tool result。Agent 自由选择调查和修改策略，最终 acceptance 仍属于
项目 CI、独立 Eval 或人工 review。

![ChronoRift 技术概念图：隔离的 Godot runtime、baseline/candidate 执行与运行记录](docs/assets/chronorift-hero.jpg)

## 使用

安装构建好的 npm 包后，在 Git 管理的 Godot 项目目录中直接打开：

```bash
npm install -g /path/to/chronorift-0.4.0.tgz
cd /path/to/my-godot-project
crf
```

首次启动可下载 Godot，在界面内使用 `/login` 登录、`/model` 选择模型；以后复用用户配置。
也可以运行 `crf "调查并修复平台碰撞问题"`，或添加 `--multi-agent` 允许协作。
当前支持 Linux x86_64，需要可用的沙箱环境；安装包构建、系统前提和结果使用见[安装指南](docs/installation.md)。
仓库已提供打包命令，尚未据此宣称已发布到 npm。

## 两分钟看懂

![ChronoRift high-level 架构](docs/assets/chronorift-architecture.png)

ChronoRift：Pi SDK 负责模型、session 和工具调度；ChronoRift 提供 Loop 外的 workspace、
sandbox、Godot execution、multiagent runtime 和 runtime evidence。

- **A · 调试回路：** Agent 修改可写 candidate、执行 Godot，并根据 runtime observation 继续迭代；observation 是
  调试信号，不是 verdict。
- **B · 独立验证：** Godot validation 使用独立的只读 stage；当前固定案例的 evaluator 只在 Agent 结束后运行，
  不参与修复。Patch round-trip 与 evaluator 是两项独立检查。
- **Acceptance 在 Loop 外：** `completed` 不等于 `fixed`；最终结果由项目 CI、外部 Eval 或人工 review 决定。

**核心价值：** 一致执行、工作区隔离、运行时证据和可独立审阅的验证。

当前实现、模块职责和运行边界见 [架构文档](docs/architecture.md)，使用与验证命令见 [开发指南](docs/development.md)。

Project Preview 可选 `--multi-agent`：Root 和 worker 使用独立 Pi Session；每个 worker 从父代理当前源码创建独立 Git worktree，各自拥有固定源码的
Godot execution。所有代理都可继续委派、发消息和等待；默认全树最多 3 个活跃 worker，加上预留的 Root 共 4 个并发名额。
采用 Adaptive Multi：只委派能替代 Root 工作的独立子任务，小任务允许零 worker；worker 完成后结束当前 turn，后续通过
`followup_task` 继续。父代理显式审阅并接收 worker patch；记录各代理模型请求和各自 workspace 锁等待时间，用于检查协作是否减少 Root 工作和耗时。
普通消息不自动启动闲置模型轮，Root 完成后 Headless 会停止剩余 writer，再输出 Root 最终 patch。使用方法、用量归属和
Codex 公开设计的适配边界见 [Multi-Agent](docs/multi-agent.md)；旧 Pilot 的性能结果不代表当前实现。
此前的 [V2 四路复测](docs/case-studies/codex-v2-retest.md)满足固定配置协议，八次验收通过；两个小任务中 Multi 均更慢、已上报估算费用更高。
后续 [Adaptive Multi 实验](docs/case-studies/adaptive-multi-v1.md)保留这些负结果，比较可选 worker 是否减少 Root 工作和关键路径，
并记录一次针对性优化后的开发对照及独立 holdout。
[提高预算后的功能对照](docs/case-studies/godot-capacity-multi-v1.md)中，Single 与 Adaptive 均完成 PR180 并通过独立验收，
但未观察到协作加速；Worker 的实际交付和 SDK 用量缺口均保留在报告中。

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

## License

ChronoRift 自有代码采用 [Apache License 2.0](LICENSE)。两个 case 的候选 patch 均派生自 MIT 许可的上游项目，归属和许可
单独记录在 [Third-Party Notices](THIRD_PARTY_NOTICES.md) 与案例目录中。
