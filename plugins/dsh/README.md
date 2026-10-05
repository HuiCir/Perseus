# Perseus for DeepSeek Harness

这是根据 Perseus 0.9 算法示意重新实现的 **dsh 原生 Cordis 插件**。工程包版本为 `0.1.3`，明确针对 **dsh `0.2.0-rc.2`**；没有引用 Pi 的 agent runtime，也没有替换 dsh 默认 AgentLoop。

本仓库发布检查将其保留为工程实验版本：2026-10-05 的类型检查、构建、核心和 UI smoke 通过，但未经日志插桩的原生检查为 **12/13**，首个 bash acquisition 存在时序敏感的错误返回，根因尚未确定。先前 2026-10-03 的 13/13 记录仅为历史结果，不能替代本轮结论。详见 [发布验证](../../docs/validation.md) 和 [机器摘要](../../docs/dsh-release-checks.json)。

## 安装

已构建的 `dsh-plugin-perseus-0.1.3.tgz` 可以直接安装，不需要安装时编译：

```sh
dsh plugin --profile YOUR_PROFILE add /absolute/path/dsh-plugin-perseus-0.1.3.tgz
dsh --profile YOUR_PROFILE --dump-config
```

图形设置卡片在**独立包** `dsh-plugin-perseus-ui`（`0.1.0`）里：它注册到「插件」页的 `plugins.item` 槽，读写本插件 `Config` 中标记为 `.volatile()` 的五个字段（`enabled` / `tools` / `provider` / `model` / `reasoningEffort`）。本插件自身不声明 `dsh.client`，也不携带任何浏览器代码。详见该包的 README。

官方插件管理器负责 profile 清单和 bundle patch。安装到已有 `web`、`tui` 或 `headless` profile 即可；默认工具模式必须为 `native`。本机验证使用独立的 `perseus-test` profile，源自官方 `headless` 模板。

## 算法和原生接口

- Actor 仍由官方 AgentLoop 驱动，只读写自己的原生会话、使用原生 schema 和工具结果，拥有最终答复权。
- `agent/request` 只读取并返回原来的 frozen call config；插件通过公开 `Session.append('user/message', ..., {surfaceOp:'append'})` 写入已经完成的额外证据。该记录会进入当前真实请求和持久化会话。
- `agent/assistant-stream` 的 start 通知发生在本轮用户消息提交后，插件在此启动探索波次。每个工具参数域只有一次模型生成，不运行子 agent 循环。
- 每个完整 `block-end` 工具调用立即校验、绑定固定动作头、检查参数域归属并派发，不等待生成流结束。
- 投机调用走父 `ctx.tools.execute` 的权限和 guard 管线，只在公开的 `tools/execute` around-dispatch 接口中重定向插件私有 call ID。Actor 的调用照常执行，探索结果不会顶替它。
- Futures 按原生工具名和规范化参数共享正在执行的同一调用；新的用户输入和变化的原生工具结果推进 revision。额外证据不会推进 revision，重试不会重发同一波次。
- 每个模型请求只获取已经完成、尚未审阅且来自更早请求的 Futures；不等待未完成结果。source ledger 保留完整记录，处理重复、较旧记录和并发冲突。
- 每次可执行 acquisition 都获得独立工作副本；同一 Speculator 的两个调用也不共享副本。工作副本永远不会 merge 回 Actor。
- Actor 的原生 reasoning 和 provider replay metadata 保持原样。Speculator 接收有来源标记的历史观察，省略 opaque replay/推理块；真实 image/file 引用会保留。
- 结束、取消、session 替换或插件卸载会取消旧 epoch。正常结束和卸载等待清理；取消会立即停止探索并异步清理，下一轮开始前会等待旧轮清理。需要显式等待时调用 `ctx.perseus.settle(agent.id)`。

证据 source 为 `perseus-evidence`，包含原始完整 observation、参数、来源、副本 snapshot 起止时间和 admission decisions，便于恢复和审计。调试事件通过 `ctx.on('perseus/event', event)` 发布；`ctx.perseus.status(agent.id)` 返回当前计数，不增加模型可见内容。

## 支持范围

内置 acquisition provider 使用 macOS Seatbelt + 独立 Node 工具 host，加载安装的官方 `0.2.0-rc.2` 包，并通过其 `ctx.tools.execute` 调用 **read、write、edit、grep、glob、bash**。这些工具的 Actor schema 和 output ABI 必须兼容；不匹配会失败，不使用近似工具实现。

父工具管线保留 pre/guard/post/finalization；工具 body 内的文件观察保护由副本中的官方 `dsh-fs-observation-policy` 独立执行。每次副本的观察状态都是新的，因此 Actor 或另一 acquisition 的 read 不会授权该副本修改已有文件；未观察的 existing write/edit 原生返回 `FS_NOT_OBSERVED`，新文件 write 可以正常执行。Speculator 的证据也不会替代 Actor 自己的 read-before-edit。

Seatbelt 禁止网络、原工作区的直接读写、用户目录读取和副本外写入；用户目录中只放行配置的官方运行时，系统运行库可读，副本内可写。文件参数中位于原工作区的绝对路径受控映射到副本。bash command 是不透明原生程序，不做字符串路径替换；访问原工作区绝对路径会被 OS 拒绝。后台工具模式和权限升级不能用于投机调用。

shell 清理遵循官方 SubprocessHandle 的受管理进程组合同，并等待 `waitForExit()`。普通 shell 后台子进程已验证会清理；主动脱离 session/进程组的 daemon 不属于这一合同。需要运行这类程序时，应提供容器或虚拟机等具有更强进程隔离的 acquisition provider。

这不是所有 dsh 功能的通用适配：`ptc/run_code`、`read_image`、外部 MCP/浏览器/数据库等没有内置独立执行 provider。默认不会投机执行这些工具，也不会回退到 Actor 的共享环境。其他系统、远端副作用和自定义工具需要通过 `registerAcquisitionProvider` 注册真正隔离的 provider，并在 `execution.routes` 显式映射；隔离声明必须由部署方真实实现。

内置 provider 自动发现本机 DSH Desktop。使用 npm/其他载体时，可配置官方运行时根目录和 Node 入口；`runtimeRoot` 是含 `node_modules/@deepseek-ai/...` 的目录，必须位于 Actor 工作区之外。

## 配置

配置使用导出的 Schemastery `Config` 校验。示例覆盖层（`--patch ./perseus-config.yml`）：

```yaml
- id: perseus
  config:
    enabled: true
    tools: [read, grep, glob, bash]
    # provider/model/reasoningEffort 省略时继承 Actor 本轮原生 route；
    # 三者都只影响 Speculator，Actor 的 route 原样返回。
    # provider: deepseek
    # model: deepseek-chat
    # reasoningEffort: high   # adapter 自有的 effort id，非法值由 adapter 拒绝
    # execution:
    #   runtimeRoot: /opt/dsh
    #   nodeExecutable: /opt/node/bin/node
    #   tempRoot: /private/tmp
    #   cancellationGraceMs: 10000
    #   stderrMaxChars: 16384
    #   maxResultBytes: 33554432  # 省略即不人为限制完整结果
    #   routes:
    #     read: dsh-native-seatbelt
```

`tools` 省略时选择所有有独立 provider 的原生可见工具。每个 revision 每个参数域一次生成，默认没有人为并发截断；生成的 token/sampling 设置默认继承 Actor，成本和并发要结合实际任务评估。用户覆盖 Cordis config 会替换整个 config，而非深度合并。

## 开发和验证

```sh
npm ci --legacy-peer-deps
npm run typecheck
npm test
npm run build
npm run test:native
npm pack --ignore-scripts
```

`test:native` 使用本机 DSH Desktop 内嵌 Node 和 **未修改的官方运行时**：真实 Cordis、LLM service、会话、工具管线、文件工具和默认 AgentLoop。模型 adapter 用确定性脚本控制时序，不调用收费模型；独立工具 host 的测试使用真实原生工具和真实 OS sandbox。可通过 `DSH_DESKTOP_RESOURCES`、`DSH_DESKTOP_EXECUTABLE` 指定其他安装位置。

工程设计对照官方 rc.2 commit `639ed015397290b3745d163aafe02ffee4aa3f84` 的 `docs/user/develop/basic/{config,tool,publish}.md` 以及 agent/tools/session/llm 的公开接口。官方 host 服务仅放在 peerDependencies 和开发依赖中，构建产物保留外部 import，以共享宿主实例。

本机验证结果（2026-10-03，macOS，安装的 DSH Desktop `0.2.0-rc.2`）：算法核心 **20/20** 通过；Desktop 原生执行/集成 **13/13** 通过、零跳过；TypeScript 检查和构建通过。普通 Node 下 `npm test` 为 24 通过、1 个 Desktop 专用测试跳过，该测试在 `test:native` 中实际执行通过。原生六工具、副本隔离、网络/原路径/hardlink 拒绝、后台进程组与取消清理、权限前置拒绝、请求证据持久化、同 ID 会话恢复、官方 tarball 安装及 Config 导入均有测试。

## 真实模型实例验证

2026-10-03 使用官方 CLI 加载已安装的 `perseus-test` 插件，沿用本机 Desktop 的默认登录账号路由 `deepseek-account`。Actor 的 6 次请求、Speculator 的 12 次请求均为 `deepseek-flash`；另有 1 次相同模型的原生会话标题请求。没有改动 Desktop 的账号或默认配置，模型覆盖仅在本次 `--patch` 生效。

实例让 Actor 修复订单计价程序，Speculator 使用 read/grep/glob 并行探索：6 个波次启动 12 个 worker，完成 44 次独立 acquisition，其中 42 次成功、2 次读取不存在的 `.env`/`.gitignore` 返回原生 `FS_NOT_FOUND`；无 acquisition 执行失败。3 条 `perseus-evidence` 消息持久化了 33 条观察（31 条成功结果、2 条原生错误），并确实出现在后续 Actor 的真实模型输入中。12 个 Speculator 流均与 Actor 流重叠，25 次工具获取跨越了后续 Actor 请求边界。

Actor 仍执行自己的原生 read/edit/bash，先读取再修改，只改 `src/order.js`；文档、测试和其他源码逐字节相同。测试从 1/5 通过变为 **5/5** 通过。CLI 在约 **16.43 秒**后正常退出（code 0），末尾 pending workers/acquisitions、active model streams、cleanup errors 均为 0，临时副本及子进程无残留。Actor 结束时取消了 1 个尚未完成的探索流；该流没有返回 usage，不能将它计作零 token 消耗。

本地记录位于 `live-results/run-20261003/`，`summary.json` 包含验证结论，`diagnostics.jsonl` 只记录模型路由、计数和时序，不含推理或凭据。官方 CLI 的原始 `stdout.jsonl` 含模型输出，权限为 0600；整个 `live-results/` 已排除 Git 和 npm 发布包。

可再次运行真实模型测试（会产生模型调用）：

```sh
node scripts/run-live.mjs
```

脚本从 `examples/live-pricing-seed` 创建新的独立任务目录和唯一结果目录，不覆盖现有记录；`--prepare-only` 仅准备输入，不启动 dsh。需先按安装步骤将插件安装到 `perseus-test` profile，并保持本机默认账号已登录。`DSH_LIVE_CLI` 可指定 CLI 路径，`DSH_LIVE_TIMEOUT_MS` 控制测试进程的超时；这些参数不会限制算法波次或改变账号。

上述结果验证了真实启动、异步探索、证据注入和任务完成。单次实例不能证明速度或准确率收益；本次没有发生 canonical execution reuse，复用行为由确定性原生集成测试验证。
