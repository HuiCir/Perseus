# dsh-plugin-perseus-ui

`dsh-plugin-perseus` 的**设置卡片**（Web / Desktop 图形界面）。工程包版本 `0.1.0`，针对 dsh `0.2.0-rc.2`。

本包只贡献浏览器半边：它把 Perseus 的 `Config` 渲染成「插件」页里的一张卡片，不替换 AgentLoop、不注册任何 Host 服务、不直接读写磁盘。

## 与 dsh-plugin-perseus 的关系

| 包 | 版本 | 作用 |
|---|---|---|
| `dsh-plugin-perseus` | `0.1.3` | Host 插件本体（算法、调度、独立工作副本）。它的 `Config` 把 `enabled` / `tools` / `provider` / `model` / `reasoningEffort` 标为 `.volatile()`，因此这五个字段可被设置界面热编辑。 |
| `dsh-plugin-perseus-ui` | `0.1.0` | 本包。注册 `plugins.item` 卡片，读写上面那张 volatile 表单。 |

两个包**都要装**：只装 UI 包时 `ctx.configForms.get("perseus")` 找不到 namespace，卡片会显示「本部署未提供 Perseus 设置」；只装插件本体时算法照常工作，只是没有图形设置入口。

UI 卡片的「插件行」开关需要 `dsh-plugin-manager` 的 `pluginManager` Remote；缺失时该行整块不渲染，其余字段不受影响。

## 为什么是独立包，而不是给 dsh-plugin-perseus 加 `dsh.client`

`@deepseek-ai/dsh-client-modules` 会把每个 Loader specifier 的判定结果缓存在 `pkgMeta` 里，**包括「不是 client 包」这个否定结论，直到进程重启**（`lib/index.js:118-121` 注释）。`dsh-plugin-perseus` 在运行中的 profile 里已经是一个活跃 Loader 行，其否定判定已被缓存，因此给它新增 `dsh.client` 只有重启后才生效。而一个新包名从未被判定过，安装后即可被扫描到。

这与官方做法一致：`dsh-client-ui-settings-subagent`、`-agent-loop`、`-shell`、`-web-search` 都是与其 Host 插件分开的独立包。

首次安装本包时，需要让 Loader 产生一个新的 entry（见下）——若扫描结果未立即出现，重启一次 DSH Desktop 即可。

## 安装

```sh
dsh plugin --profile YOUR_PROFILE add /absolute/path/dsh-plugin-perseus-0.1.3.tgz
dsh plugin --profile YOUR_PROFILE add /absolute/path/dsh-plugin-perseus-ui-0.1.0.tgz
dsh --profile YOUR_PROFILE --dump-config
```

组装后的 profile 树应同时出现两行：

```yaml
- id: perseus
  name: dsh-plugin-perseus
- id: perseus-ui
  name: dsh-plugin-perseus-ui
```

本包不需要安装时编译，也不需要任何构建步骤：`lib/client.js` 是手写的 client bundle。

## 卡片内容

- **启用 Perseus**：`enabled`，写回 volatile 表单（插件仍保持加载，只是不再投机采集）。
- **Speculator 工具白名单**：`tools`，逗号分隔；留空表示允许全部工具（清空会 `unset` 该字段，而不是写入空数组）。
- **Speculator 模型 / 提供方**：`model` / `provider`，仅覆盖投机调用；留空表示继承会话默认。
- **推理强度**：`reasoningEffort`，下拉选择 `默认 / off / low / high / max`。
- **应用 / 放弃修改**：一次 `mutate` 提交全部改动，带 revision 栅栏；脏状态与错误就地显示。
- **插件行**：调用 `remote.pluginManager.setPluginEnabled("include:perseus", false)`，按返回信封的 `application`（`applied` / `overridden` / `restart-required` / `cancelled` / `failed`）给出提示。关闭后本卡片会随插件一起卸载，可在插件列表里重新启用。

## 包内文件

| 路径 | 内容 |
|---|---|
| `lib/index.js` | Host 半边：只有 `name` 与空 `apply()`，存在的原因是 client 扫描只对「已激活且未禁用」的 Loader entry 生成 client 行。 |
| `lib/client.js` | 手写 client bundle（`window.__ModuleLoader__.load`），只 `require("react")`。 |
| `cordis.patch.yml` | `- insert: [{ id: perseus-ui, name: dsh-plugin-perseus-ui }]` |
| `scripts/smoke.mjs` | 离线冒烟测试：用桩 React 执行 bundle，校验注册、字段投影、`mutate` ops 与信封分支。`node scripts/smoke.mjs`（不随包发布）。 |

## 自测

```sh
node scripts/smoke.mjs
```

冒烟测试覆盖：导出面与 `inject`、`plugins.item` 注册参数、`whileServed("perseus")`、五个字段的投影与渲染、一次提交的 path ops（`set` / `unset`）、插件行信封的五种 `application` 分支、只读与「未提供」两种状态。它不能替代真实浏览器验证。
