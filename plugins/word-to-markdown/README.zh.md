# @local/dsh-word-to-markdown

[English](README.md) | 中文

给 agent 一个 `word_to_markdown` 工具：把 Word 文档交给它，它写出一个 Markdown 文件，
并把文档里的图片提取到旁边的文件夹、以 `![](path)` 链接进正文。
不依赖任何第三方 JS 包 —— 转换交给 [pandoc](https://pandoc.org/)，需在 Host 上安装。

正常提需求即可（例如"把 `D:\docs\spec.docx` 转成 Markdown"），agent 会调用该工具，
没有别的需要配置。

## `/` 指令：`/word2md`

同一条转换也可以完全不经模型，直接在输入框里跑：

```
/word2md @spec.docx           ← 输入框 @ 补全出来的引用
/word2md @"my spec.docx"      ← 路径含空格时的引号写法
/word2md @spec.docx <目录>     ← 覆盖输出目录
/word2md D:\docs\spec.docx    ← 绝对路径也可以
```

该指令运行在 UI 指令平面：**不产生模型消息**、不消耗 token、由指令自己返回文本：

```
▸ ✅ 转换完成 · 13742 字节 · 4 张图 · gfm
  输入：@47.WMS-…需求文档.docx
  输出：<工作区>\docs\47.WMS-…需求文档.md
  图片目录：<工作区>\docs\media
  ⚠️ 已剥离 43 处 Word 高亮标记（文字保留）
  根目录来源：session.header.cwd
```

运行期间，对话记录里显示的是平台自带的指令行 —— 指令名 + 闪烁的 `执行中…`，完成后由上面
这个结果替换。

回复刻意做成**短首行 + 详情行**：客户端把首行当作折叠摘要显示，所以单行长文本只会被截断；
而它的展开控件（点击整行展开）**只在文本含换行时才出现**，因此详情行正是让其余内容仍能
被点开看全的原因。告警也用界面语言渲染，而不是照搬工具结果的英文措辞。

指令在菜单里的描述和输入提示**刻意写成中文**：`/` 菜单只对六个内建指令做本地化（词条在
客户端自己手里），其它指令一律原样显示 Host 传来的 `description` —— 所以想让第三方指令在
菜单里显示中文，只能直接这么写。**自定义图标同样够不到**：客户端把图标也绑在同一张内建表上，
`commandUi.decorate()` 挂的是"空调用时的 UI spec"而不是外观，而 `commandUi.register()`
贡献的行又不允许与 Host 指令同名。

它的输入是**路径，不是附件**。`@` 是**文件引用**：composer 的补全插入的是纯文本，
而给模型的引用契约明确写着**相对路径从工作区根目录解析**。指令完全遵循这条规则，
所以 `@spec.docx` 就是 `<工作区>/spec.docx`。带引号的引用会被当作一个完整参数分词，
开头的 `@` 不属于路径本身。

指令**刻意不声明接收附件**：所以把文件拖上来会在 handler 执行之前就被执行器拒绝，
而不是被静默忽略 —— 请改用路径传入。

工作区根目录取自 `agent.session.header.cwd` —— 正是 `@` 补全提供者读取的同一个字段，
所以引用和指令对"相对路径"的理解一致。另外几个形状只作兜底，`process.cwd()` 排最后，
并且**每次回复都会写明取自哪个来源** —— 猜错了你立刻能看见，而不是把结果悄悄丢到别处。

## 做什么

- 参数：`docxPath`（必填）、`outputDir`（默认：源文件所在目录）、`format`、`overwrite`。
- 写出 `<name>.md`，并把提取出的图片放进 `outputDir` 下的文件夹，**还原文档自身的内部
  媒体路径**（`media/image1.png`），因此 pandoc 写出的链接天然相对于 Markdown 文件，
  无需重写。
- 返回：Markdown 路径、图片目录、图片数量、字节数、所用方言、pandoc 版本，以及告警。
- 在 `PATH` 与常见安装位置查找 pandoc；行配置里的 `pandocPath` 可覆盖。

## 图片处理，以及为什么要带一个 Lua filter

Word 会给每张插入的图片记录明确的宽高。pandoc 的 `gfm` writer 表达不了这些属性，
于是退化成裸 `<img src="...">` 标签 —— 而**未开启 raw HTML 的渲染器会把它当字面文本显示，
图片就丢了**。`strip-image-attributes.lua` 会剥掉这些属性，之后同一个 writer 就输出
`![](path)`。仅当已安装的 pandoc 报告 `+lua` 时才应用该 filter；不支持时转换照常进行，
并在 `warnings` 里说明这一限制。

## 会清理的 Word 痕迹

- **图片尺寸** —— 上面那个 Lua filter，让图片保持 `![]()`。
- **残留的 `{width=...}` 属性** —— 从图片链接后剥掉（示例文档里有 43 处）。
  把 `stripImageAttributes` 关掉可保留。
- **Word 高亮标记** —— Word 的高亮以裸 `<span class="mark">` 标签形式出现。
  标签被移除、高亮文字保留，因此未开启 raw HTML 的渲染器不会看到标签噪声；
  高亮本身被丢弃，数量会在 `warnings` 里说明。

## 方言怎么选

以下是一份真实的 290 KB 需求文档（简体中文、4 张图、4 张表其中 3 张含宽单元格或图片）
的实测：

| `format` | 字节 | 表格丢失 | 图片 | 说明 |
|---|---|---|---|---|
| `gfm`（默认） | 13742 | 0 | 4 × `![]()` | 能装下的用真 Markdown 表格；那 3 张复杂表保留为 HTML `<table>` |
| `markdown` | 18553 | 0 | 4 × `![]()` | 完全不输出 HTML；所有表格变成 pandoc grid 表格（本例 11 行 `+---+` 框线） |
| `gfm-raw_html` | 9253 | **丢 3 张表** | 4 × `![]()` | 最"纯"，但被 `[TABLE]` 占位符替换 |

默认选 `gfm`，因为它不丢内容。代价只有一个：DSH 自身的 Markdown 渲染器未开启 raw HTML，
那三段 `<table>` 在聊天回复里可能显示为字面文本 —— 如果这比表格保真更重要，改用
`format: markdown`；或者直接用编辑器打开这个 `.md`，HTML 表格在那里渲染正常。

## 行配置

所有字段可选：

```yaml
- id: word-to-markdown
  name: '@local/dsh-word-to-markdown'
  config:
    pandocPath: C:\Program Files\Pandoc\pandoc.exe  # 默认：搜索 PATH
    format: gfm                # gfm | markdown | gfm-raw_html
    wrap: none                 # none | auto（pandoc --wrap）
    stripImageAttributes: true # 应用 Lua filter 并清理残留属性
    timeoutMs: 180000          # 单次转换的时限
```

本包无法 import `@deepseek-ai/schemastery`（见下文"文件"），因此不声明 `Config`
导出：这些值由代码防御式读取，被拒绝的值会报错而不是被静默替换。

## 文件

| 文件 | 作用 |
|---|---|
| `index.js` | Host 半边：工具定义、`/word2md` 指令、pandoc 调用、结果拼装 |
| `strip-image-attributes.lua` | 剥掉图片尺寸的 pandoc filter |
| `cordis.patch.yml` | insert 本 bundle 的 Loader 记录 |
| `test/convert.test.mjs` | schema、参数处理、以及真实往返转换测试 |

`index.js` 只 import Node 内置模块。用 `link:` 安装的 bundle，Node 会从其真实路径解析，
该路径在 profile 的 `node_modules` 树之外，所以提供 `defineTool` 的
`@deepseek-ai/dsh-tools` 在这里无法解析。因此工具定义直接携带 `defineTool` 本会产出的
registry-ready 形状与 JSON Schema；测试用工具注册表自身的 `assertSupportedJsonSchema`
校验这两个 schema，而不是靠信任。

## 安装

```sh
dsh plugin --profile <profile> add "link:<本目录的绝对路径>"
```

重启 `dsh web`（或等 profile 自动重载），然后确认工具已可用。

## 验证

```sh
node test/convert.test.mjs
```

24 项检查：两个 schema 通过注册表校验器与 `register()` 契约；所有拒绝路径（缺参数、
文件不存在、旧版 `.doc`、扩展名不对、未知方言、行配置错误、`overwrite: false`）；
一次真实往返 —— 用带内嵌 PNG 的 Markdown 固件生成 `.docx`，再转回来，断言标题与表格
文本存活、图片是 `![](path)`、没有残留裸 `<img>` 或 `{width=}`，并且输出目录里**原本就存在**
的无关图片不会被算成"提取出来的"；以及 `/word2md` 指令 —— 覆盖 `@` 引用按工作区根目录
解析、**短摘要 + 可展开详情**的回复形态、用法与拒绝提示、含空格的引号引用、绝对路径、
输出目录参数、**不成路径的多余词**、引用不存在、引用非 Word 文件，以及回复里报告的
工作区来源。找不到已安装的 DSH 时 schema 检查会跳过并说明；pandoc 缺失时转换检查会跳过。

## 已知边界

- **旧版 `.doc` 会被拒绝**，并提示另存为 `.docx`：pandoc 读不了 2007 之前的二进制格式。
- **复杂表格**在默认方言下是 HTML `<table>`（见上表）。
- **复用输出目录。** 图片检测对比转换前后的目录快照，所以已有图片不会被误计；若某张图片
  被 pandoc 以字节完全相同的内容重写且 mtime 未变，则不会计入 —— 对一次全新提取而言不会发生。
- **输出目录不受内置 `fs` 工具那样的沙箱约束**：工具会写到 `outputDir` 指向的任何位置。
  它从不写源文档。
- **仅涉及 Host。** 没有 Web UI 半边；结果通过工具的正常文本输出回报。
