/**
 * `@local/dsh-word-to-markdown` — Host plugin that converts a Word document
 * into a Markdown file, extracting its embedded images.
 *
 * It exposes the same conversion two ways:
 *
 * - the model-facing tool `word_to_markdown`, for when the agent is asked in
 *   ordinary language; and
 * - the human slash command `/word2md`, which runs in the UI command plane
 *   without creating a model message, and accepts the Word file as a composer
 *   attachment — so dragging a document in and sending `/word2md` converts it
 *   with no model involvement at all.
 *
 * Conversion is delegated to Pandoc:
 *
 *   pandoc <file.docx> -f docx -t <writer> --wrap=none \
 *          --extract-media=. [--lua-filter=strip-image-attributes.lua] -o <name>.md
 *
 * run with the output directory as the working directory. `--extract-media=.`
 * makes Pandoc recreate the document's own internal media paths under that
 * directory (`media/image1.png`), so every link it writes is relative to the
 * Markdown file and needs no rewriting; the folders that actually received
 * images are discovered afterwards rather than assumed.
 *
 * The Lua filter removes the picture sizes Word records. Without it, the
 * GitHub-Flavored Markdown writer cannot express those attributes and emits a
 * raw `<img>` tag instead of `![](path)`, which a renderer without raw-HTML
 * support shows as literal text. It is applied only when the installed Pandoc
 * reports `+lua`; otherwise the conversion still runs and says so.
 *
 * The module deliberately imports nothing but Node builtins. A bundle installed
 * with `link:` is resolved by Node from its real path outside the profile's
 * `node_modules` tree, so `@deepseek-ai/dsh-tools` (which would supply
 * `defineTool`) and `@deepseek-ai/dsh-commands` (which would supply the command
 * types and the branded definition id) are not resolvable here. Both
 * registrations therefore carry the registry-ready shapes those packages would
 * have produced, which is why the JSON Schemas are hand-written and the command
 * omits its optional branded `definitionId`.
 *
 * The command resolves the workspace root from `agent.session.header.cwd`, the
 * same field the `@file` completion provider reads, so a relative `@path` names
 * the same file to both. `process.cwd()` is only a last-resort fallback, and
 * every reply names the source it used.
 *
 * Its argument grammar is one path plus an optional output directory. A second
 * argument that does not look like a path — someone writing `/word2md @a.docx 处理`
 * to mean "go ahead" — is refused rather than used as a folder name, which would
 * otherwise file the result under an unexpected directory without complaint.
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'word-to-markdown'
export const inject = ['tools']

/** Model-facing tool name. */
const TOOL_NAME = 'word_to_markdown'

/** Slash command name, without the leading slash. */
const COMMAND_NAME = 'word2md'

/** The image-attribute filter shipped beside this module. */
const LUA_FILTER = fileURLToPath(new URL('./strip-image-attributes.lua', import.meta.url))

/** Extensions counted as extracted images. */
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.tif', '.tiff', '.emf', '.wmf', '.svg', '.webp'])

/** Extensions this tool accepts; `docx` and `docm` share the OOXML container. */
const OPENXML_EXTENSIONS = new Set(['.docx', '.docm'])

/**
 * Markdown writers this tool exposes. `lossyTables` marks a writer that cannot
 * express every table, which Pandoc reports by emitting a literal `[TABLE]`
 * placeholder: content loss the caller must be told about.
 */
const FORMATS = {
  gfm: {
    writer: 'gfm',
    lossyTables: false,
    summary: 'GitHub-Flavored Markdown (default). Real Markdown tables wherever they fit; a table Markdown cannot express (merged cells, pictures inside cells) is kept as an HTML <table>, so nothing is lost and every image stays ![](path).',
  },
  markdown: {
    writer: 'markdown',
    lossyTables: false,
    summary: 'Pandoc Markdown. Emits no HTML at all: every table is a Markdown (grid) table and every image is ![](path). Most portable through a plain-text-only renderer, at the cost of wide grid tables.',
  },
  'gfm-raw_html': {
    writer: 'gfm-raw_html',
    lossyTables: true,
    summary: 'GitHub-Flavored Markdown with raw HTML disabled. Purest Markdown, but any table it cannot express is replaced by a "[TABLE]" placeholder, so content is lost.',
  },
}

/** Configuration defaults, overridable per row by the plugin's `config`. */
const DEFAULTS = {
  format: 'gfm',
  wrap: 'none',
  stripImageAttributes: true,
  timeoutMs: 180_000,
  docsDir: 'docs',
}

/**
 * Read the row configuration defensively.
 *
 * The package cannot import `@deepseek-ai/schemastery`, so it declares no
 * `Config` export and the Loader performs no schema validation on this row.
 * Every field is therefore type-checked here and falls back to its default; a
 * rejected value is reported rather than silently substituted.
 * @param config - the row's `config` value, of unknown shape.
 * @returns resolved settings, with `configError` set when a value was rejected.
 */
function readConfig(config) {
  const raw = config !== null && typeof config === 'object' ? config : {}
  const settings = {
    pandocPath: typeof raw.pandocPath === 'string' && raw.pandocPath !== '' ? raw.pandocPath : undefined,
    format: raw.format === undefined ? DEFAULTS.format : raw.format,
    wrap: raw.wrap === 'auto' ? 'auto' : DEFAULTS.wrap,
    stripImageAttributes: raw.stripImageAttributes !== false,
    timeoutMs: Number.isFinite(raw.timeoutMs) && raw.timeoutMs > 0 ? raw.timeoutMs : DEFAULTS.timeoutMs,
    docsDir: typeof raw.docsDir === 'string' && raw.docsDir !== '' ? raw.docsDir : DEFAULTS.docsDir,
    configError: undefined,
  }
  if (typeof settings.format !== 'string' || FORMATS[settings.format] === undefined) {
    settings.configError = `unknown format "${String(settings.format)}"; expected one of ${Object.keys(FORMATS).join(', ')}`
  }
  return settings
}

/**
 * Candidate Pandoc executables, most specific first.
 * @param explicit - `pandocPath` from the row configuration, if any.
 * @returns candidates to try in order.
 */
function pandocCandidates(explicit) {
  const local = process.env.LOCALAPPDATA
  return [
    explicit,
    process.env.DSH_PANDOC_PATH,
    process.env.PANDOC_PATH,
    'pandoc',
    'C:\\Program Files\\Pandoc\\pandoc.exe',
    'C:\\Program Files (x86)\\Pandoc\\pandoc.exe',
    local === undefined ? undefined : join(local, 'Pandoc', 'pandoc.exe'),
    '/usr/local/bin/pandoc',
    '/usr/bin/pandoc',
  ].filter((candidate) => typeof candidate === 'string' && candidate !== '')
}

/** Run one process and settle with its exit status and captured output. */
function run(command, args, options) {
  return new Promise((settle) => {
    execFile(command, args, { ...options, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error === null) {
        settle({ ok: true, stdout, stderr, code: 0, timedOut: false, message: '' })
        return
      }
      const code = typeof error.code === 'number' ? error.code : error.code === 'ENOENT' ? 'ENOENT' : 1
      settle({ ok: false, stdout, stderr, code, timedOut: error.killed === true, message: error.message })
    })
  })
}

/**
 * Locate a working Pandoc and report its version and Lua support.
 * @param explicit - `pandocPath` from the row configuration, if any.
 * @returns the executable, its version, and whether it advertises `+lua`.
 * @throws when no candidate answers `--version`.
 */
async function findPandoc(explicit) {
  const tried = []
  for (const candidate of pandocCandidates(explicit)) {
    const result = await run(candidate, ['--version'], { timeout: 20_000 })
    if (result.ok) {
      return {
        command: candidate,
        version: /^pandoc\s+(\S+)/m.exec(result.stdout)?.[1] ?? 'unknown',
        lua: /^Features:.*\+lua/m.test(result.stdout),
      }
    }
    tried.push(candidate)
  }
  throw new Error(
    'pandoc was not found. Install it (https://pandoc.org/installing.html), '
    + `put it on PATH, or set pandocPath in this plugin's config. Tried: ${tried.join(', ')}`,
  )
}

/**
 * Snapshot the image files under `directory` as absolute path to "size:mtime".
 *
 * The output directory is usually a project `docs` folder that may already hold
 * images from earlier conversions, so what this run produced is found by
 * comparing two snapshots rather than by counting everything present afterwards.
 * @param directory - the output directory, which must exist.
 * @returns the image files present at this moment.
 */
function snapshotImages(directory) {
  const found = new Map()
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile() && IMAGE_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        const stat = statSync(full)
        found.set(full, `${stat.size}:${stat.mtimeMs}`)
      }
    }
  }
  walk(directory)
  return found
}

/**
 * The images this run created or rewrote, and the folders that hold them.
 * @param before - snapshot taken before the conversion.
 * @param after - snapshot taken after it.
 * @param directory - the output directory the folders are reported relative to.
 * @returns the extracted image count and the relative image folders.
 */
function extractedImages(before, after, directory) {
  const folders = new Set()
  let images = 0
  for (const [path, stamp] of after) {
    if (before.get(path) === stamp) continue
    images += 1
    folders.add(relative(directory, dirname(path)).split(sep).join('/') || '.')
  }
  return { images, folders: [...folders].sort() }
}

/**
 * Drop any remaining Pandoc `{width="..." height="..."}` attribute after an
 * image, unwrap Word's highlight marks, and count `[TABLE]` placeholders left by
 * a writer that could not express a table.
 * @param markdownPath - the file Pandoc wrote.
 * @param settings - resolved settings.
 * @returns what was rewritten, for the result and its warnings.
 */
function tidy(markdownPath, settings) {
  const original = readFileSync(markdownPath, 'utf8')
  let strippedImageAttributes = 0
  let text = original
  if (settings.stripImageAttributes) {
    text = original.replace(/(!\[[^\]]*\]\([^)]*\))\{[^}\n]*\}/g, (whole, image) => {
      strippedImageAttributes += 1
      return image
    })
  }
  /* Word highlight marks reach Markdown as raw inline spans. A renderer without
   * raw HTML shows the tags as literal text, so the tags are removed and the
   * highlighted text is kept; the highlight itself is presentation, not content. */
  let highlightMarksRemoved = 0
  text = text.replace(/<span class="mark">([\s\S]*?)<\/span>/g, (whole, inner) => {
    highlightMarksRemoved += 1
    return inner
  })
  const tablePlaceholderLines = text.split('\n').filter((line) => line.trim() === '[TABLE]').length
  if (text !== original) writeFileSync(markdownPath, text)
  return { strippedImageAttributes, highlightMarksRemoved, tablePlaceholderLines, markdownBytes: Buffer.byteLength(text) }
}

/**
 * Validate the requested conversion and resolve it to absolute paths.
 * @param args - `docxPath`, optional `outputDir`, optional `overwrite`.
 * @param baseDir - directory a relative `docxPath` or `outputDir` resolves from.
 * @returns the source, output directory and Markdown target.
 */
function resolvePaths(args, baseDir) {
  if (typeof args.docxPath !== 'string' || args.docxPath.trim() === '') {
    throw new Error('docxPath is required and must be a non-empty string')
  }
  const source = isAbsolute(args.docxPath) ? args.docxPath : resolve(baseDir, args.docxPath)
  if (!existsSync(source)) throw new Error(`no such file: ${source}`)
  if (!statSync(source).isFile()) throw new Error(`not a file: ${source}`)

  const extension = extname(source).toLowerCase()
  if (extension === '.doc') {
    throw new Error(
      `legacy .doc is not supported by pandoc. Open ${basename(source)} in Word and `
      + 'save it as .docx (Word 2007-365 format), then convert that file.',
    )
  }
  if (!OPENXML_EXTENSIONS.has(extension)) {
    throw new Error(`expected a Word document (${[...OPENXML_EXTENSIONS].join(' or ')}), got "${extension || basename(source)}"`)
  }

  const outputDir = typeof args.outputDir === 'string' && args.outputDir.trim() !== ''
    ? (isAbsolute(args.outputDir) ? args.outputDir : resolve(baseDir, args.outputDir))
    : dirname(source)
  const outputName = `${basename(source, extension)}.md`
  const markdownPath = join(outputDir, outputName)
  if (existsSync(markdownPath) && args.overwrite === false) {
    throw new Error(`${markdownPath} already exists. Pass overwrite: true to replace it, or choose another output directory.`)
  }
  return { source, outputDir, markdownPath }
}

/**
 * Convert one Word document, creating the output directory if needed.
 * @param settings - resolved settings.
 * @param args - `docxPath`, optional `outputDir`, optional `format`, optional `overwrite`.
 * @returns the same value object the tool's output schema describes.
 * @throws on any rejected input, missing pandoc, or pandoc failure.
 */
async function convert(settings, args) {
  if (settings.configError !== undefined) throw new Error(settings.configError)
  const requestedFormat = typeof args.format === 'string' ? args.format : settings.format
  const format = FORMATS[requestedFormat]
  if (format === undefined) {
    throw new Error(`unknown format "${requestedFormat}"; expected one of ${Object.keys(FORMATS).join(', ')}`)
  }

  const { source, outputDir, markdownPath } = resolvePaths(args, args.baseDir ?? process.cwd())
  mkdirSync(outputDir, { recursive: true })

  const pandoc = await findPandoc(settings.pandocPath)
  const warnings = []
  const pandocArgs = [
    source,
    '-f', 'docx',
    '-t', format.writer,
    '--extract-media=.',
    '-o', relative(outputDir, markdownPath).split(sep).join('/') || basename(markdownPath),
  ]
  if (settings.wrap === 'none') pandocArgs.push('--wrap=none')
  if (settings.stripImageAttributes && pandoc.lua) {
    pandocArgs.push(`--lua-filter=${LUA_FILTER}`)
  } else if (settings.stripImageAttributes && !pandoc.lua) {
    warnings.push('This pandoc was built without Lua, so picture sizes could not be stripped; a Markdown writer that cannot express them may emit raw <img> tags for some images.')
  }

  const before = snapshotImages(outputDir)
  const result = await run(pandoc.command, pandocArgs, { cwd: outputDir, timeout: settings.timeoutMs })
  if (!result.ok) {
    const detail = (result.stderr || result.stdout || result.message || '').trim().split('\n').slice(-8).join('\n')
    if (result.timedOut) {
      throw new Error(`pandoc exceeded ${settings.timeoutMs} ms and was stopped. Raise timeoutMs in this plugin's config for very large documents.\n${detail}`)
    }
    throw new Error(`pandoc exited with ${result.code}.\n${detail}`)
  }
  if (!existsSync(markdownPath)) throw new Error(`pandoc reported success but wrote no ${markdownPath}`)

  const { images, folders } = extractedImages(before, snapshotImages(outputDir), outputDir)
  const { strippedImageAttributes, highlightMarksRemoved, tablePlaceholderLines, markdownBytes } = tidy(markdownPath, settings)

  if (tablePlaceholderLines > 0) {
    warnings.push(
      `${tablePlaceholderLines} table(s) could not be expressed in "${format.writer}" and Pandoc wrote a "[TABLE]" placeholder instead, so their content is missing. Re-run with format "gfm" or "markdown" to keep them.`,
    )
  }
  if (images === 0) warnings.push('The document embeds no images, so no image folder was created.')
  if (strippedImageAttributes > 0) {
    warnings.push(`Removed ${strippedImageAttributes} pandoc {width=...} attribute(s) from image links; set stripImageAttributes: false to keep them.`)
  }
  if (highlightMarksRemoved > 0) {
    warnings.push(`Removed ${highlightMarksRemoved} Word highlight mark(s); the highlighted text is kept, the highlight is not.`)
  }

  return {
    markdownPath,
    mediaDir: folders.join(', '),
    images,
    markdownBytes,
    format: format.writer,
    pandocVersion: pandoc.version,
    strippedImageAttributes,
    tablePlaceholderLines,
    warnings,
  }
}

/**
 * The workspace root a command should write under.
 *
 * The session's own working directory is the authority. It is reached as
 * `agent.session.header.cwd`, which is exactly how the `@file` completion provider
 * (`dsh-file-reference-local`) resolves an agent's working directory — so a
 * mention and this command agree on what a relative path means. The other
 * candidates are defensive fallbacks, and the result is reported back to the user
 * so a wrong guess is visible.
 * @param agent - the receiving agent, if the runtime supplied one.
 * @returns an absolute directory, and which source it came from.
 */
function resolveWorkspaceRoot(agent) {
  const candidates = [
    ['session.header.cwd', agent?.session?.header?.cwd],
    ['session.cwd', agent?.session?.cwd],
    ['session.meta.cwd', agent?.session?.meta?.cwd],
    ['agent.cwd', agent?.cwd],
    ['workspace.cwd', agent?.workspace?.cwd],
    ['workspace.root', agent?.workspace?.root],
  ]
  for (const [label, value] of candidates) {
    if (typeof value === 'string' && value !== '') return { root: resolve(value), source: label }
  }
  return { root: process.cwd(), source: 'process.cwd()' }
}

/**
 * Split a command line into arguments, keeping quoted spans together.
 *
 * The mention grammar quotes a path only when it contains whitespace
 * (`@"my spec.docx"`), so a plain whitespace split would tear such a path in
 * half and file the result under a mangles name.
 * @param rawInput - the text after the command name.
 * @returns the arguments, with their surrounding quotes removed.
 */
function tokenize(rawInput) {
  const tokens = []
  /* A quoted span is matched before the bare-token alternative, which would
   * otherwise swallow the opening quote (`@"my` instead of `my spec.docx`). */
  const pattern = /@?"([^"]*)"|'([^']*)'|(\S+)/g
  let match
  while ((match = pattern.exec(rawInput)) !== null) {
    const token = match[1] ?? match[2] ?? match[3]
    if (token !== '') tokens.push(token)
  }
  return tokens
}

/**
 * Read one command-line token as a path.
 *
 * A `@file` mention — the plain text the composer's completion inserts — is
 * marked with a leading `@`, which is not part of the path. Relative paths
 * resolve from the workspace root, matching the `@` reference contract the model
 * is given.
 * @param token - one tokenized argument.
 * @returns the referenced path text.
 */
function mentionPath(token) {
  return token.startsWith('@') ? token.slice(1) : token
}

/**
 * Whether a token plausibly names a directory.
 *
 * The second argument is the output directory, so a stray word — a user writing
 * "convert this" after the path — must not silently become a folder name.
 * @param token - the candidate argument.
 * @returns true for an absolute path or one containing a separator.
 */
function looksLikePath(token) {
  return isAbsolute(token) || token.includes('/') || token.includes('\\') || token.startsWith('.')
}

/**
 * A short Chinese rendering of one `convert()` warning.
 *
 * The warnings are written for the model in the tool result; the command's reply
 * is shown to a person, so it says the same thing in the interface language.
 * @param warning - one warning from the conversion.
 * @returns the human-facing text.
 */
function warningText(warning) {
  const highlight = /^Removed (\d+) Word highlight mark/.exec(warning)
  if (highlight !== null) return `已剥离 ${highlight[1]} 处 Word 高亮标记（文字保留）`
  const attribute = /^Removed (\d+) pandoc \{width/.exec(warning)
  if (attribute !== null) return `已剥离 ${attribute[1]} 处图片尺寸属性`
  const tables = /^(\d+) table\(s\) could not be expressed/.exec(warning)
  if (tables !== null) return `${tables[1]} 张表该方言无法表达，已写成 [TABLE] 占位（内容丢失）`
  if (warning.startsWith('The document embeds no images')) return '该文档没有内嵌图片'
  if (warning.startsWith('This pandoc was built without Lua')) return '该 pandoc 无 Lua 支持，图片尺寸未能剥离'
  return warning
}

/**
 * The `/word2md` command: convert a referenced Word document into the workspace's
 * docs folder, without creating a model message.
 *
 * Input is a path — normally the `@file` mention the composer's completion
 * inserts — resolved from the workspace root, exactly as a mention is.
 * @param ctx - a context whose `commands` service is available.
 * @param settings - resolved settings.
 */
function registerCommand(ctx, settings) {
  ctx.commands.register({
    name: COMMAND_NAME,
    /* The `/` menu shows this string verbatim: the client localizes only the six
     * built-in commands, from its own hardcoded table, and falls back to the Host
     * description for every other row. Writing it in the interface language is the
     * only way a third-party command gets a Chinese menu entry. */
    description: '把 Word 文档转成 Markdown 并提取图片，输出到工作区 docs/',
    input: {
      hint: '@文件.docx [输出目录]',
    },
    async handler(invocation) {
      const { agent, rawInput } = invocation
      const tokens = tokenize(rawInput).map(mentionPath)

      /**
       * Shape one reply for the transcript.
       *
       * The first line is the collapsed summary, and because the client only
       * offers its disclosure when the text contains a newline, the detail lines
       * are what make the whole reply reachable by clicking the row. A reply with
       * a single long line would be truncated with nothing left to expand.
       * @param summary - the one-line summary shown while collapsed.
       * @param detail - the lines revealed by expanding.
       * @returns the reply text.
       */
      const reply = (summary, ...detail) => [summary, ...detail].join('\n')

      const usage = `用法：/${COMMAND_NAME} @<文件.docx> [输出目录]`
      if (tokens.length === 0) {
        return {
          kind: 'error',
          text: reply('❌ 缺少文件参数', usage, '在输入框里打 @ 会有路径补全，相对路径按工作区根目录解析'),
        }
      }

      const workspace = resolveWorkspaceRoot(agent)
      const [requestedPath, outputOverride] = tokens
      if (tokens.length > 2) {
        return {
          kind: 'error',
          text: reply(`❌ 参数过多（多出 ${tokens.length - 2} 个）`, usage),
        }
      }
      if (outputOverride !== undefined && !looksLikePath(outputOverride)) {
        return {
          kind: 'error',
          text: reply(
            '❌ 未转换：第二个参数不像路径',
            `参数："${outputOverride}"`,
            '已停下，以免把结果写进一个名为该词的目录',
            usage,
          ),
        }
      }
      const outputDir = outputOverride !== undefined
        ? (isAbsolute(outputOverride) ? outputOverride : resolve(workspace.root, outputOverride))
        : join(workspace.root, settings.docsDir)

      let failures = 0
      let summary
      const detail = []
      try {
        const value = await convert(settings, { docxPath: requestedPath, outputDir, baseDir: workspace.root })
        summary = `✅ 转换完成 · ${value.markdownBytes} 字节 · ${value.images} 张图 · ${value.format}`
        detail.push(`输入：${requestedPath}`)
        detail.push(`输出：${value.markdownPath}`)
        if (value.images > 0) detail.push(`图片目录：${join(dirname(value.markdownPath), value.mediaDir)}`)
        for (const warning of value.warnings) detail.push(`⚠️ ${warningText(warning)}`)
      } catch (error) {
        failures += 1
        summary = `❌ 转换失败：${requestedPath}`
        detail.push(`原因：${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
      }
      detail.push(`根目录来源：${workspace.source}`)
      const text = reply(summary, ...detail)
      return failures === 0 ? { kind: 'success', text } : { kind: 'error', text }
    },
  })
}

/**
 * Tool parameters, as the JSON Schema `defineTool` would have produced from a
 * parameter spec.
 *
 * Only keywords in the registry's enforced subset are used, because
 * `ctx.tools.register` validates every schema with `assertSupportedJsonSchema`
 * (which, for example, rejects a `type` array).
 */
const parameters = {
  type: 'object',
  additionalProperties: false,
  properties: {
    docxPath: {
      type: 'string',
      description: 'Path to the Word document (.docx or .docm). Absolute, or relative to the working directory.',
    },
    outputDir: {
      type: 'string',
      description: "Directory to write the .md file and the extracted images into. Defaults to the source file's own directory.",
    },
    format: {
      type: 'string',
      enum: ['gfm', 'markdown', 'gfm-raw_html'],
      description: 'Markdown dialect. "gfm" (default) keeps every table, writing the ones Markdown cannot express as HTML <table>, and keeps images as ![](path). "markdown" emits no HTML at all, using pandoc grid tables. "gfm-raw_html" is purest but replaces tables it cannot express with "[TABLE]", losing them.',
    },
    overwrite: {
      type: 'boolean',
      description: 'Replace an existing .md file at the target path. Defaults to true; pass false to refuse instead of overwriting.',
    },
  },
  required: ['docxPath'],
}

/** Tool output schema, in the JSON Schema form the registry validates. */
const outputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    markdownPath: { type: 'string', description: 'The Markdown file that was written.' },
    mediaDir: { type: 'string', description: 'Folder(s) holding the extracted images, relative to the Markdown file, comma-separated; an empty string when the document embeds no images.' },
    images: { type: 'integer', description: 'Number of image files extracted.' },
    markdownBytes: { type: 'integer', description: 'Byte length of the Markdown file.' },
    format: { type: 'string', description: 'Markdown dialect used.' },
    pandocVersion: { type: 'string', description: 'Version of the pandoc that performed the conversion.' },
    strippedImageAttributes: { type: 'integer', description: 'Number of pandoc {width=...} attributes removed from image links.' },
    tablePlaceholderLines: { type: 'integer', description: 'Number of "[TABLE]" placeholders left because the dialect cannot express those tables.' },
    warnings: { type: 'array', items: { type: 'string' }, description: 'Conditions the caller should know about; empty when there are none.' },
  },
  required: ['markdownPath', 'mediaDir', 'images', 'markdownBytes', 'format', 'pandocVersion', 'strippedImageAttributes', 'tablePlaceholderLines', 'warnings'],
}

/**
 * Register the `word_to_markdown` tool, and the `/word2md` command once a
 * commands service is present.
 * @param ctx - registrant context carrying the tool registry.
 * @param config - the row's configuration, of unknown shape.
 */
export function apply(ctx, config) {
  const settings = readConfig(config)

  ctx.tools.register({
    name: TOOL_NAME,
    description: [
      'Convert a Word document (.docx) into a Markdown file, extracting the images embedded in it into a',
      'folder beside the Markdown and linking each one with Markdown image syntax.',
      'Use this whenever the user supplies a Word file and wants Markdown out of it.',
      'Writes <name>.md plus the image folder, and returns their paths, the image count, the dialect used,',
      'and warnings (for example tables the dialect could not express).',
      'Needs pandoc installed on the Host. Legacy .doc must be saved as .docx first.',
    ].join(' '),
    parameters,
    output: {
      schema: outputSchema,
      render(_args, value) {
        const lines = [
          `Wrote ${value.markdownPath} (${value.markdownBytes} bytes, ${value.format}).`,
          value.images === 0
            ? 'The document embeds no images.'
            : `Extracted ${value.images} image${value.images === 1 ? '' : 's'} into ${value.mediaDir}.`,
        ]
        for (const warning of value.warnings) lines.push(`Warning: ${warning}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args) {
      return convert(settings, args)
    },
  })

  /* The command is registered only once its service exists, so a profile without
   * a commands service still gets the tool rather than losing the whole plugin. */
  ctx.inject(['commands'], (commandCtx) => {
    registerCommand(commandCtx, settings)
  })
}
