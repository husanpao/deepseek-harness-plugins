# DeepSeek Harness 插件集

[English](README.md) | 中文

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的插件
bundle 集合。每个插件都是一个普通的工作区包，用 `dsh plugin` 安装进
Harness profile。本仓库里的东西都是 bundle：`package.json` 里声明
`dsh.bundle.patch`，由该 patch insert 自己的 Loader 记录；若还需在 Web 页面里
跑代码，再声明 `dsh.client`。

## 插件列表

| 插件 | 作用 | Profile | 依赖 |
|---|---|---|---|
| [`right-click-row-menu`](plugins/right-click-row-menu/README.zh.md) | 在侧边栏的工作区/会话行上点右键即弹出该行"..."菜单，不必先悬停再点省略号图标。 | `web` | 无 |
| [`word-to-markdown`](plugins/word-to-markdown/README.zh.md) | 把 Word `.docx` 转成 Markdown 并把内嵌图片提取为 `![](path)`：既有给 agent 用的 `word_to_markdown` 工具，也有 `/word2md` 指令——用 `@文件` 引用传入路径，直接写入工作区 `docs/`。 | `web` | Host 上需有 pandoc |

## 安装

在本仓库根目录，把某个插件装进你实际使用的 profile：

```sh
dsh plugin --profile web add "link:$PWD/plugins/right-click-row-menu"
```

`dsh plugin` 会在 profile 目录里转发给 pnpm，然后把新装上的 bundle 选中并追加到
`dsh.profile.bundles`。新装 bundle 可以靠 HMR 激活；新的客户端 bundle 需要刷新
页面才会加载。

`link:` 写法让这份检出目录保持为活的源：改这里的代码、刷新页面即生效，无需重装。
当某个插件改为从 registry 获取时，把它换成发布版本或 `git+` 说明符即可。

卸载：

```sh
dsh plugin --profile web remove @local/<包名>
```

## 目录结构

```
plugins/<name>/
  package.json         bundle 清单：dsh.bundle.patch（Web UI 另加 dsh.client）
  cordis.patch.yml     本 bundle 贡献的 Loader patch
  index.js             Host 半边（插件入口：apply / inject / Config）
  client.js            浏览器半边（window.__ModuleLoader__.load({ id, factory })）
  test/                无需 Harness 实例即可运行的测试
  tools/               开发辅助脚本
  README.md            英文文档
  README.zh.md         中文文档
  README.i18n.yaml     双语配对哈希记录
```

本仓库遵循的约定，与 Harness 自身的包保持一致：

- **双语文档。** 每个 `README.md` 都有对应的 `README.zh.md`；两侧具有同等效力，
  必须同步修改。`README.i18n.yaml` 记录上次确认一致时两侧的 git blob 哈希，
  因此单侧改动可以被检出。
- **Host 插件里不要写 `export default`。** Loader 的 `unwrapExports` 会折叠带
  default export 的模块并丢掉 `inject`；请用具名的 `export function apply` /
  `export const inject` / `export const Config`。
- **客户端 bundle 不引入多余的 import。** React 与静态 UI 库来自浏览器模块表；
  其它运行时 import 要在 `dsh.client.external` 里声明。
- **资源统一在 `apply` 里注册**，用 `ctx.effect` / `ctx.on`，并返回清理函数。

## 新增一个插件

1. 复制最接近的现有插件，或从 `cordis-plugin-development` skill 自带的模板起步。
2. 给包起一个唯一名字，设置 patch 记录的 `id` 与 `name`，并让客户端 bundle 里的
   `window.__ModuleLoader__.load({ id })` 与包名一致。
3. 用 `dsh plugin --profile <profile> add "link:<路径>"` 安装。
4. 在声称完成之前先验证能力本身——用
   `dsh --profile <profile> --dump-config` 检查组合后的树，并在 UI 里实际跑通。

## 验证一份检出

每个插件自带测试，并在自己的 README 里写清验证边界；在插件目录下运行，例如：

```sh
cd plugins/right-click-row-menu
node test/client.test.mjs
```

这里的测试必须在没有 Harness 实例、没有网络的情况下也能跑。若某插件的行为只能靠
肉眼确认，它的 README 会如实说明，而不会拿 mock 冒充真实页面。
