# PERSEUS

**一个 Actor，异步扩展探索广度，让证据提前到达决策。**

[English](README.md) · [论文](docs/paper/perseus-iclr2027-submission.pdf) · [架构](docs/architecture.md) · [验证记录](docs/validation.md) · [下载](https://github.com/HuiCir/Perseus/releases)

![Perseus 总览：唯一权威 Actor、独立投机分支、持续 Future 和 ready-only 证据通道](docs/assets/perseus-overview.png)

PERSEUS 将探索广度与任务决策权分开：Actor 保持原生任务轨迹；Speculator 在可验证的原生工具参数域中进行单轮探索，每次采集都进入独立工作副本。Future 保存跨请求的未完成采集，ledger 把已完成、带来源的证据交给后续 Actor 决策。工作副本不会合并回权威环境，分支也不接管最终答复。

本仓库重新整理为三部分：**算法原型 0.9.0、Codex 插件 0.2.1、DSH Host 插件 0.1.3**。DSH 官方设置 UI 0.1.0 和实验调试面板 0.1.0 单独提供。原型是研究 demo；插件分别按各自 harness 的公开接口实现，兼容边界并不完全相同。

## 核心机制

1. **Meta-Tool 派生**：根据 schema 中声明的动作值和成功权威调用的结构化参数头，构造互斥域；没有完全覆盖时保留补集。不启发式拆分不透明 shell 文本。
2. **异步单轮探索**：新权威进度推进 revision，每个合格域最多生成一次。完整参数到达并通过校验即可启动采集，不等待整波生成结束。
3. **独立副本执行**：保存完整结果、错误和副本来源；临时写入不进入 Actor 状态。
4. **持续 Future**：相同未完成调用共享执行，未完成工作可以跨请求继续；证据接收本身不触发新波次。
5. **只接收 ready 证据**：Actor 不等待未完成分支，仍通过原生工具执行所有权威操作。

![独立信息发现可以重叠，真正的数据依赖保持原序](docs/assets/logical-folding.png)

图取自随附论文的 Figure 1 / Figure 5；第二张图表示逻辑阶段，并非实际时间轴。论文仍为**匿名 ICLR 2027 审稿稿件**，没有声称已接收。

## 安装选择

| 组件 | 说明 |
| --- | --- |
| [prototype](prototype/README.md) | 原型源码、工具宿主合同、开发测试；需要自行配置 provider |
| [Codex](plugins/codex/README.md) | 原生插件清单、9 个 hooks、typed argv MCP；A 跟随 session，S 默认 Luna/high |
| [DSH Host](plugins/dsh/README.md) | 锁定 DSH 0.2.0-rc.2 的 Cordis 插件；原生 AgentLoop 保留 |
| [DSH UI](plugins/dsh-ui/README.md) | 独立设置卡片，使用官方 dsh.client 接口 |
| [DSH panel](plugins/dsh-panel/README.md) | 可选实验调试界面，不默认安装，也不宣称已完整验证 Desktop UI |

下载预构建发行包后，按各组件 README 安装。Codex 通过 native marketplace 加载；DSH 通过 `dsh plugin --profile YOUR_PROFILE add PACKAGE.tgz` 安装到指定 profile。不要把源码仓库内的开发依赖上传或复制为账号环境。

## 论文结果与工程验证

论文在四个基准共 **183 个筛选任务 × 3 次尝试**上，用 **GPT-5.6 Terra / Luna，均 high** 比较 13 个 baselines。总体任务成功率由 ReAct 的 **56.3%** 提升到 **67.8%**，成功数/总耗时定义的 Execution Speed 从 **2.43** 提升到 **3.20 × 10⁻³ s⁻¹**。PERSEUS 总体成功率最高，但总体 ES 不是所有方法中最高。完整表格与实验边界见 [英文 README](README.md#results-in-the-manuscript) 和论文。

这些数值不代表当前 GPT-6 Codex 插件的性能，也不是本次重新执行的 benchmark。当前源码、原生接口和隔离测试记录见 [validation](docs/validation.md)。短函数调用实验也说明 PERSEUS 并不保证普遍加速。

## 兼容边界

Codex 使用 hook/tool 边界，不等同于每次模型请求；它额外提供 `command_exec` MCP 契约，以弥补原生 hooks 缺少完整工具 registry。DSH 使用原生 request/stream/session/tools 接口。外部服务的可变状态必须由真实独立 provider 隔离，不能退回共享环境。当前验证过的系统隔离后端是 macOS；Codex 副本内 Node 测试须使用 `--test-isolation=none`，DSH 的进程清理合同不覆盖主动脱组 daemon。

代码为 MIT；保留组件第三方声明。论文及插图的来源记录见 [figure provenance](docs/assets/paper-figure-provenance.json)。
