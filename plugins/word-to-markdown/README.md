# @local/dsh-word-to-markdown

English | [中文](README.zh.md)

Gives the agent a `word_to_markdown` tool: hand it a Word document and it writes
a Markdown file with the document's images extracted to a folder beside it and
linked as `![](path)`. No third-party JS dependencies — conversion is delegated
to [pandoc](https://pandoc.org/), which must be installed on the Host.

Ask in the normal way ("convert `D:\docs\spec.docx` to Markdown") and the agent
calls the tool; nothing else to configure.

## Slash command `/word2md`

The same conversion runs from the composer with no model involvement at all:

```
/word2md @spec.docx           ← the @ mention the composer completes
/word2md @"my spec.docx"      ← the quoted form for a path containing a space
/word2md @spec.docx <dir>     ← overriding the output directory
/word2md D:\docs\spec.docx    ← an absolute path works too
```

The command runs in the UI command plane: it creates **no model message**, costs
no tokens, and returns its own text:

```
▸ ✅ 转换完成 · 13742 字节 · 4 张图 · gfm
  输入：@47.WMS-…需求文档.docx
  输出：<workspace>\docs\47.WMS-…需求文档.md
  图片目录：<workspace>\docs\media
  ⚠️ 已剥离 43 处 Word 高亮标记（文字保留）
  根目录来源：session.header.cwd
```

While it runs, the transcript shows the platform's own command row — the command
name with a shimmering `执行中…` — and this reply replaces it on completion.

The reply is deliberately **a short first line plus detail lines**. The client shows
the first line as the collapsed summary, so a single long line would simply be
truncated; and it offers its disclosure — expanded by clicking the row — only when
the text contains a newline, so the detail lines are what keep the rest reachable.
Warnings are rendered in the interface language rather than repeating the tool
result's English wording.

The command's own menu description and input hint are **written in Chinese on
purpose**. The `/` menu localizes only the six built-in commands, from a table the
client owns, and shows every other command's Host-supplied `description` verbatim —
so writing it in the interface language is the only way a third-party command gets
a Chinese menu entry. A custom menu icon is not reachable either: the client keys
icons off that same built-in table, `commandUi.decorate()` attaches only a
bare-invocation UI spec rather than a face, and a `commandUi.register()`
contribution may not reuse a Host command's name.

Its input is a **path, not an attachment**. `@` is a *file reference*: the
composer's completion inserts plain text, and the reference contract given to the
model says relative paths resolve from the workspace root. The command follows
exactly that rule, so `@spec.docx` means `<workspace>/spec.docx`. A quoted mention
is tokenized as one argument, and the leading `@` is not part of the path.

The command deliberately does **not** declare attachment input, so a dragged file
is refused by the executor before the handler runs rather than silently ignored —
pass the document by path instead.

The workspace root comes from `agent.session.header.cwd` — the same field the
`@file` completion provider reads, so a mention and the command agree on what a
relative path means. A few other shapes are probed as fallbacks with
`process.cwd()` last, and every reply names the source it used, so a wrong guess
is visible immediately instead of silently filing the result somewhere unexpected.

## What it does

- `docxPath` (required), `outputDir` (default: the source file's own folder),
  `format`, `overwrite`.
- Writes `<name>.md` and the extracted images into a folder under `outputDir`,
  recreating the document's own internal media paths (`media/image1.png`), so
  every link pandoc writes is relative to the Markdown file and needs no
  rewriting.
- Returns the Markdown path, the image folder, the image count, the byte length,
  the dialect used, the pandoc version, and any warnings.
- Discovers pandoc on `PATH` and in the usual install locations; `pandocPath` in
  the row config overrides that.

## Image handling, and why a Lua filter ships with it

Word records an explicit width and height on every inserted picture. Pandoc's
`gfm` writer cannot express those attributes, so it falls back to a raw
`<img src="...">` tag — and a renderer that does not enable raw HTML shows that
as literal text, losing the picture. `strip-image-attributes.lua` removes those
attributes, after which the same writer emits `![](path)` instead. The filter is
applied only when the installed pandoc reports `+lua`; without it the conversion
still runs and reports the limitation in `warnings`.

## Word artifacts it cleans up

- **Picture sizes** — the Lua filter above, so images stay `![]()`.
- **Leftover `{width=...}` attributes** — stripped after an image link (43 of
  them in the example document). Turn `stripImageAttributes` off to keep them.
- **Word highlight marks** — Word's highlighting arrives as raw
  `<span class="mark">` tags. The tags are removed and the highlighted text is
  kept, so a renderer without raw HTML does not show tag soup; the highlight
  itself is dropped, and the count is reported in `warnings`.

## Choosing a dialect

Measured on a real 290 KB requirement document (simplified Chinese, 4 pictures,
4 tables of which 3 have wide or picture-bearing cells):

| `format` | Bytes | Tables lost | Images | Notes |
|---|---|---|---|---|
| `gfm` (default) | 13742 | 0 | 4 × `![]()` | Real Markdown tables where they fit; the 3 complex ones stay as HTML `<table>` |
| `markdown` | 18553 | 0 | 4 × `![]()` | Emits no HTML at all; every table becomes a pandoc grid table (11 lines of `+---+` framing here) |
| `gfm-raw_html` | 9253 | **3 tables** | 4 × `![]()` | Purest Markdown, but replaced by `[TABLE]` placeholders |

`gfm` is the default because it loses nothing. Its one cost: DSH's own Markdown
renderer does not enable raw HTML, so those three `<table>` blocks may show as
literal text in a chat reply — switch to `format: markdown` if that matters more
than table fidelity, or read the `.md` in an editor, which renders the HTML
tables fine.

## Row configuration

All fields are optional:

```yaml
- id: word-to-markdown
  name: '@local/dsh-word-to-markdown'
  config:
    pandocPath: C:\Program Files\Pandoc\pandoc.exe  # default: search PATH
    format: gfm                # gfm | markdown | gfm-raw_html
    wrap: none                 # none | auto (pandoc --wrap)
    stripImageAttributes: true # apply the Lua filter and strip leftovers
    timeoutMs: 180000          # bound on one conversion
```

The package cannot import `@deepseek-ai/schemastery` (see Files below), so it
declares no `Config` export: these values are read defensively and a rejected
one is reported as an error rather than silently replaced.

## Files

| File | Role |
|---|---|
| `index.js` | Host half: tool definition, the `/word2md` command, pandoc invocation, result assembly |
| `strip-image-attributes.lua` | Pandoc filter that drops picture sizes |
| `cordis.patch.yml` | Inserts the bundle's Loader row |
| `test/convert.test.mjs` | Schema, argument, and real round-trip conversion tests |

`index.js` imports only Node builtins. A bundle installed with `link:` is resolved
by Node from its real path, outside the profile's `node_modules`, so
`@deepseek-ai/dsh-tools` — which supplies `defineTool` — is not resolvable here.
The tool definition therefore carries the registry-ready shape and JSON Schemas
that `defineTool` would have produced, and the tests validate both schemas with
the registry's own `assertSupportedJsonSchema` rather than trusting them.

## Install

```sh
dsh plugin --profile <profile> add "link:<absolute path to this directory>"
```

Restart `dsh web` (or let the profile reload), then confirm the tool is offered.

## Verify

```sh
node test/convert.test.mjs
```

24 checks: both schemas pass the registry validator and the `register()`
contract; every rejection path (missing argument, absent file, legacy `.doc`,
wrong extension, unknown dialect, misconfigured row, `overwrite: false`); a real
round trip that builds a `.docx` from a Markdown fixture with an embedded PNG,
converts it back, and asserts the heading and table text survived, that images are
`![](path)`, that no raw `<img>` or `{width=}` survived, and that an unrelated
image already sitting in the output directory is not counted as extracted; and the
`/word2md` command, covering an `@`-referenced conversion relative to the workspace
root, the short collapsed summary plus expandable detail shape of a reply, the
usage and refusal messages, the quoted mention form for a path with a space, an
absolute path, the output-directory argument, a trailing word that is not a path, a
missing reference, a non-Word reference, and which workspace source the reply
reports. The schema checks are skipped with a notice when no installed DSH is
found; the conversion checks are skipped when pandoc is absent.

## Known limits

- **Legacy `.doc` is refused** with a save-as-`.docx` instruction: pandoc cannot
  read the pre-2007 binary format.
- **Complex tables** land as HTML `<table>` under the default dialect (see above).
- **Reused output directory.** Image detection compares the directory before and
  after the run, so pre-existing images are not miscounted; an image pandoc
  rewrites with byte-identical content and an unchanged mtime would not be
  counted, which cannot happen for a fresh extraction.
- **The output directory is not sandboxed** the way the built-in `fs` tools are:
  the tool writes wherever `outputDir` points. It never writes to the source
  document.
- **Only the Host is touched.** There is no Web UI half; the result is reported
  through the tool's normal text output.
