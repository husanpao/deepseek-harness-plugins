# @local/dsh-right-click-row-menu

[English](README.md) | 中文

在 Harness 侧边栏的**工作区**或**会话**行上点右键，直接弹出该行的"..."菜单，
不必先悬停再点省略号图标。

## 做什么

- 在 document 上注册捕获阶段的 `contextmenu` 监听。
- 当右键落在侧边栏的行内（`data-row-key` 以 `session:` 或 `workspace:` 开头）时，
  抑制浏览器原生菜单，并点击该行自带的"..."触发器，从而打开正常的行菜单，
  内容与原行为完全一致（重命名、Fork、置顶、归档，以及任何插件追加的条目）。
- 菜单已经打开的行保持打开；没有菜单的行、以及识别不出触发器的行，
  完全不做处理——原生右键菜单照旧出现，也绝不会点到其它控件。
- 点"..."的原有方式不受影响。本插件只是给同一个触发器增加了第二种触发方式。

## 为什么要去点它自带的触发器

菜单及其开合状态是 `@deepseek-ai/dsh-client-ui-workspace` 内部的私有 React
state，菜单项也是该包注册的 slot 条目。外部插件既无法设置这个 state，也拿不到
那些 action，所以要打开这个自带菜单，唯一的公开途径就是触发它自带的触发器。
耦合面刻意只保留这一点。

以下是所依赖的 DOM 契约，均已对照 shipped 的
`dsh-client-ui-workspace` 客户端产物核实：

| 假设 | 实际值 |
|---|---|
| 行元素 | `div[data-row-key]` = `session:<id>` 或 `workspace:<key>`，`role="treeitem"` |
| 操作条 | CSS-module 类名以 `rowActions` 结尾的元素 |
| 菜单触发器 | 操作条内由 `actions.workspace.aria` / `actions.session.aria` 命名的按钮 |
| 自带词典 | `zh`（`工作区“X”的操作` / `会话“X”的操作`）与 `en`（`Workspace/Session actions for X`） |
| 菜单已开标记 | 行上的 `menuOpen` 类 |

任何一步匹配不上时都退化为"什么都不做"，因此上游改名最多让功能失效，
不会误点到无关控件。

更正统的实现其实是上游 `packages/client/ui-workspace/src/client` 里给行加一行
`onContextMenu`，既简单又不怕升级；那属于提给上游，不适合放在本仓库。

## 文件

| 文件 | 作用 |
|---|---|
| `package.json` | bundle 清单：`dsh.bundle.patch`，以及浏览器半边的 `dsh.client` |
| `cordis.patch.yml` | insert 本 bundle 的 Loader 记录 |
| `index.js` | Host 半边——空实现；功能全在客户端 |
| `client.js` | 浏览器半边：`contextmenu` 处理 |
| `test/client.test.mjs` | 针对上述契约的最小 DOM 模拟回归测试 |
| `tools/plugin-url.mjs` | 打印本 bundle 在 `/plugins` 下的当前 revision URL，便于探测 |

## 安装

```sh
dsh plugin --profile <profile> add "link:<本目录的绝对路径>"
```

`dsh plugin` 会在 profile 目录里转发给 pnpm，然后把新装上的 bundle 选中并追加到
`dsh.profile.bundles`。`link:` 写法让本目录保持为活的源，改这里的代码后重新加载
即可生效，无需重装。

卸载：`dsh plugin --profile <profile> remove @local/dsh-right-click-row-menu`；
若 `dsh.profile.bundles` 里仍残留该名字，一并去掉。

## 验证

```sh
node test/client.test.mjs   # 10/10 通过
node tools/plugin-url.mjs   # 当前的 /plugins revision URL
```

该测试覆盖匹配逻辑及其失败分支，但**不能**证明真实浏览器里渲染成什么样：
DOM 模拟是按契约搭的，不是真实页面。请在页面上右键一个侧边栏行做视觉确认，
并顺带确认点"..."的原有行为没有变化。

## 已知边界

- 触发器靠无障碍名称的形状识别，覆盖自带的两套词典（`zh`、`en`）。将来若新增
  语言，该语言下功能会静默失效——但不会误操作。扩充 `client.js` 里的
  `ACTIONS_LABEL` 即可支持。
- 操作条在未悬停时是 `display:none`。右键必然使指针停在行上，所以这只是兜底：
  当测得尺寸为 0 时，为点击临时显示操作条，随后复原。

依赖：无。浏览器半边没有 import 任何东西——连 React 都没有。
