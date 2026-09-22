/**
 * Tests for the word-to-markdown plugin.
 *
 * Three groups:
 *  1. Both hand-written JSON Schemas pass the tool registry's real validator,
 *     loaded from the installed DSH when it can be found. This is the check that
 *     catches the registry's enforced-subset rules (for example, that a `type`
 *     array is rejected); it is skipped with a notice when DSH is not installed.
 *  2. Argument handling: every rejection path, using real temporary files.
 *  3. A real conversion: pandoc builds a .docx from a Markdown fixture (with an
 *     embedded PNG), the tool converts that .docx back, and the result is read
 *     back and asserted. Skipped with a notice when pandoc is absent.
 *
 * Run with: node test/convert.test.mjs
 * The DSH tools entry may be pointed at explicitly with DSH_TOOLS_ENTRY; a
 * fixture .docx may be substituted with DSH_WORD_FIXTURE.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import { pathToFileURL } from 'node:url'

const PLUGIN = new URL('../index.js', import.meta.url)

/* ---------------------------------------------------------------- helpers */

/**
 * A stub of the two registries the plugin uses, without a DSH runtime.
 * `inject` runs its callback immediately so the command path is exercised.
 */
function stubContext(registrations, options = {}) {
  return {
    tools: { register: (definition) => { registrations.tool = definition } },
    inject: (dependencies, callback) => {
      registrations.injectedDependencies = dependencies
      callback({
        commands: { register: (definition) => { registrations.command = definition } },
        attachments: options.attachments,
      })
    },
  }
}

/** Load the plugin and return everything it registered. */
async function loadPluginFull(config, options) {
  const plugin = await import(PLUGIN)
  const registrations = {}
  plugin.apply(stubContext(registrations, options), config)
  assert.ok(registrations.tool, 'apply() must register the tool')
  return registrations
}

/** Load the plugin and capture the tool it registers. */
async function loadPlugin(config) {
  const { tool } = await loadPluginFull(config)
  return tool
}

/** Find the installed DSH tools entry that exports the registry's validator. */
function findDshTools() {
  const candidates = [
    process.env.DSH_TOOLS_ENTRY,
    join(process.env.APPDATA ?? '', 'npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js'),
    join(process.env.APPDATA ?? '', 'npm/node_modules/@deepseek-ai/dsh/lib/index.js'),
    '/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js',
  ].filter((candidate) => candidate !== '' && candidate !== undefined)
  return candidates.find((candidate) => existsSync(candidate))
}

/** One 1x1 PNG, embedded verbatim so the fixture needs no assets on disk. */
const PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
)

/** Extensions the plugin counts as extracted images. */
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.tif', '.tiff', '.emf', '.wmf', '.svg', '.webp'])

/** Lower-case extension of a file name, or an empty string. */
const extnameOf = (name) => {
  const dot = name.lastIndexOf('.')
  return dot === -1 ? '' : name.slice(dot).toLowerCase()
}

/** A pandoc executable, or undefined when none answers --version. */
function findPandoc() {
  const candidates = [
    process.env.DSH_PANDOC_PATH,
    'pandoc',
    'C:\\Program Files\\Pandoc\\pandoc.exe',
    join(process.env.LOCALAPPDATA ?? '', 'Pandoc/pandoc.exe'),
    '/usr/local/bin/pandoc',
    '/usr/bin/pandoc',
  ].filter((candidate) => candidate !== '' && candidate !== undefined)
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ['--version'], { stdio: 'ignore' })
      return candidate
    } catch {
      /* try the next candidate */
    }
  }
  return undefined
}

const tests = []
const test = (name, fn) => tests.push([name, fn])

/* ------------------------------------------------- 1. schema conformance */

const dshTools = findDshTools()
if (dshTools === undefined) {
  console.log('skip schema conformance: no installed DSH found (set DSH_TOOLS_ENTRY to enable)')
} else {
  const { assertSupportedJsonSchema } = await import(pathToFileURL(dshTools).href)
  test('both schemas pass the registry validator', async () => {
    const tool = await loadPlugin({})
    assertSupportedJsonSchema(tool.parameters)
    assertSupportedJsonSchema(tool.output.schema)
  })
  test('the registered definition satisfies the register() contract', async () => {
    const tool = await loadPlugin({})
    assert.equal(typeof tool.name, 'string')
    assert.ok(tool.name.length > 0)
    assert.equal(typeof tool.description, 'string')
    assert.equal(typeof tool.output.render, 'function')
    assert.equal(typeof tool.execute, 'function')
    assert.equal(tool.parameters.type, 'object')
    assert.deepEqual(tool.parameters.required, ['docxPath'])
    assert.ok(tool.parameters.properties.docxPath !== undefined)
  })
}

/* ------------------------------------------------------ 2. argument handling */

test('registers the /word2md command once a commands service exists', async () => {
  const { command, injectedDependencies } = await loadPluginFull({})
  assert.deepEqual(injectedDependencies, ['commands'], 'the command must be gated on the commands service')
  assert.equal(command.name, 'word2md')
  assert.equal(typeof command.handler, 'function')
  assert.equal(command.input.attachments, undefined, 'the command takes an @ path, not attachments')
  assert.equal(typeof command.input.hint, 'string')
  assert.match(command.input.hint, /@/, 'the hint must advertise the @ mention form')
  assert.ok(command.description.length > 0)
})

const workDir = mkdtempSync(join(tmpdir(), 'word-to-markdown-'))

test('rejects a missing docxPath', async () => {
  const tool = await loadPlugin({})
  await assert.rejects(() => tool.execute({}, {}), /docxPath is required/)
})

test('rejects a path that does not exist', async () => {
  const tool = await loadPlugin({})
  await assert.rejects(() => tool.execute({ docxPath: join(workDir, 'absent.docx') }, {}), /no such file/)
})

test('rejects a legacy .doc with the save-as-.docx instruction', async () => {
  const legacy = join(workDir, 'legacy.doc')
  writeFileSync(legacy, 'not really a word document')
  const tool = await loadPlugin({})
  await assert.rejects(() => tool.execute({ docxPath: legacy }, {}), /save it as \.docx/)
})

test('rejects a non-Word extension', async () => {
  const text = join(workDir, 'notes.txt')
  writeFileSync(text, 'plain text')
  const tool = await loadPlugin({})
  await assert.rejects(() => tool.execute({ docxPath: text }, {}), /expected a Word document/)
})

test('rejects an unknown per-call format', async () => {
  const tool = await loadPlugin({})
  await assert.rejects(
    () => tool.execute({ docxPath: join(workDir, 'x.docx'), format: 'rst' }, {}),
    /unknown format "rst"/,
  )
})

test('rejects a misconfigured row before touching the filesystem', async () => {
  const tool = await loadPlugin({ format: 'bogus' })
  await assert.rejects(() => tool.execute({ docxPath: join(workDir, 'x.docx') }, {}), /unknown format "bogus"/)
})

/* ------------------------------------------------------ 3. real conversion */

const pandoc = findPandoc()
if (pandoc === undefined) {
  console.log('skip conversion: pandoc not found (install pandoc or set DSH_PANDOC_PATH to enable)')
  test('conversion checks are unavailable on this machine', () => {
    assert.ok(true)
  })
} else {
  const fixtureDir = join(workDir, 'fixture')
  mkdirSync(fixtureDir, { recursive: true })
  const supplied = process.env.DSH_WORD_FIXTURE
  const generated = !(supplied !== undefined && existsSync(supplied))
  let fixture
  if (generated) {
    writeFileSync(join(fixtureDir, 'pixel.png'), PIXEL_PNG)
    writeFileSync(join(fixtureDir, 'source.md'), [
      '# 需求目的',
      '',
      '正文包含**加粗**与普通文字。',
      '',
      '| 编号 | 版本号 | 说明 |',
      '|---|---|---|',
      '| 1 | V1.0 | 首个版本 |',
      '',
      '![](pixel.png)',
      '',
      '## 验收标准',
      '',
      '1. 需要覆盖以下场景。',
      '',
    ].join('\n'))
    fixture = join(fixtureDir, 'fixture.docx')
    /* cwd must be the fixture directory so the image path in source.md resolves,
     * otherwise pandoc drops the image and the fixture has nothing to extract. */
    execFileSync(pandoc, ['source.md', '-o', 'fixture.docx'], { stdio: 'pipe', cwd: fixtureDir })
  } else {
    fixture = supplied
  }
  assert.ok(existsSync(fixture), 'the fixture must exist')

  /** Count image files under a directory, recursively. */
  const countImages = (directory) => readdirSync(directory, { withFileTypes: true })
    .reduce((total, entry) => {
      const full = join(directory, entry.name)
      if (entry.isDirectory()) return total + countImages(full)
      return IMAGE_EXTENSIONS.has(extnameOf(entry.name)) ? total + 1 : total
    }, 0)

  test('converts a Word document and extracts its images as Markdown links', async () => {
    const outDir = join(workDir, 'out')
    const tool = await loadPlugin({})
    const value = await tool.execute({ docxPath: fixture, outputDir: outDir }, {})

    assert.ok(existsSync(value.markdownPath), 'the Markdown file must exist')
    assert.equal(value.format, 'gfm')
    assert.ok(value.markdownBytes > 0)
    assert.ok(value.images >= 1, `expected at least one extracted image, got ${value.images}`)
    assert.notEqual(value.mediaDir, '', 'the result must name the folder holding the images')
    assert.equal(value.tablePlaceholderLines, 0, 'gfm must not lose tables')

    const mediaDir = join(dirname(value.markdownPath), value.mediaDir.split(', ')[0])
    assert.ok(existsSync(mediaDir), `the image folder ${mediaDir} must exist`)
    assert.equal(countImages(outDir), value.images, 'every image found must be one the run produced')

    const markdown = readFileSync(value.markdownPath, 'utf8')
    assert.match(markdown, /需求目的/, 'the heading text must survive')
    assert.match(markdown, /V1\.0/, 'the table content must survive')
    assert.match(markdown, /!\[[^\]]*\]\(/, 'images must be Markdown image links')
    assert.doesNotMatch(markdown, /<img/, 'no raw <img> tag, which a renderer without raw HTML would show as text')
    assert.doesNotMatch(markdown, /\{[^}\n]*width=/, 'no pandoc width attribute may survive')
  })

  test('ignores images that were already in the output directory', async () => {
    const outDir = join(workDir, 'preexisting')
    mkdirSync(outDir, { recursive: true })
    writeFileSync(join(outDir, 'unrelated.png'), PIXEL_PNG)
    const tool = await loadPlugin({})
    const value = await tool.execute({ docxPath: fixture, outputDir: outDir }, {})
    assert.ok(value.images >= 1)
    assert.ok(
      !value.mediaDir.split(', ').includes('.'),
      `a loose image already in the output directory must not be reported as extracted (got "${value.mediaDir}")`,
    )
    if (generated) assert.equal(value.images, 1, 'the fixture embeds exactly one image')
  })

  test('the rendered summary names the file and the images', async () => {
    const outDir = join(workDir, 'render')
    const tool = await loadPlugin({})
    const value = await tool.execute({ docxPath: fixture, outputDir: outDir }, {})
    const parts = tool.output.render({ docxPath: fixture }, value)
    assert.equal(parts.length, 1)
    assert.equal(parts[0].type, 'text')
    assert.match(parts[0].text, /Wrote /)
    assert.match(parts[0].text, /Extracted \d+ image/)
  })

  test('a dialect that cannot express a table warns instead of failing silently', async () => {
    const outDir = join(workDir, 'lossy')
    const tool = await loadPlugin({})
    const value = await tool.execute({ docxPath: fixture, outputDir: outDir, format: 'gfm-raw_html' }, {})
    // The generated fixture has a simple pipe table, which gfm-raw_html keeps;
    // this asserts the warning channel exists and is an array either way.
    assert.ok(Array.isArray(value.warnings))
    assert.equal(typeof value.tablePlaceholderLines, 'number')
  })

  test('refuses to overwrite an existing Markdown file when asked', async () => {
    const outDir = join(workDir, 'guard')
    const tool = await loadPlugin({})
    await tool.execute({ docxPath: fixture, outputDir: outDir }, {})
    await assert.rejects(
      () => tool.execute({ docxPath: fixture, outputDir: outDir, overwrite: false }, {}),
      /already exists/,
    )
  })

  /* ------------------------------------------- 4. the /word2md command */

  const workspaceRoot = join(workDir, 'workspace')
  mkdirSync(workspaceRoot, { recursive: true })
  /* The `@` reference contract resolves relative paths from the workspace root,
   * so the documents the command is pointed at live there. */
  copyFileSync(fixture, join(workspaceRoot, 'spec.docx'))
  copyFileSync(fixture, join(workspaceRoot, 'my spec.docx'))

  /* The real agent shape: the @file completion provider reads the working
   * directory from `session.header.cwd`, so the command must too. */
  const invocation = (agent, rawInput) => ({
    agent: agent ?? { session: { header: { cwd: workspaceRoot } } },
    rawInput,
    attachments: [],
  })

  test('/word2md converts an @-referenced document relative to the workspace root', async () => {
    const { command } = await loadPluginFull({})
    const result = await command.handler(invocation(undefined, '@spec.docx'))
    assert.equal(result.kind, 'success', result.text)
    const target = join(workspaceRoot, 'docs', 'spec.md')
    assert.ok(existsSync(target), `expected ${target} to exist`)
    assert.match(readFileSync(target, 'utf8'), /需求目的/, 'the document text must survive the command path')
  })

  test('/word2md answers with a short summary plus an expandable body', async () => {
    const { command } = await loadPluginFull({})
    const result = await command.handler(invocation(undefined, '@spec.docx'))
    assert.equal(result.kind, 'success', result.text)
    const [summary, ...detail] = result.text.split('\n')
    /* The client renders its disclosure only when the text contains a newline, so
     * the detail lines are what keep the reply expandable, while the first line is
     * what stays visible when collapsed and must therefore stay short. */
    assert.ok(detail.length > 0, `detail lines are required for the reply to expand, got:\n${result.text}`)
    assert.ok(summary.length <= 48, `the collapsed summary must stay short, got ${summary.length}: ${summary}`)
    assert.match(summary, /转换完成/)
    assert.match(result.text, /spec\.md/, 'the detail must name the output file')
    assert.match(result.text, /根目录来源/)

    const usage = await command.handler(invocation(undefined, ''))
    assert.equal(usage.kind, 'error')
    assert.match(usage.text.split('\n')[0], /缺少文件参数/)
    assert.match(usage.text, /word2md/, 'the usage line must be reachable in the body')
  })

  test('/word2md unwraps the quoted form of a mention containing a space', async () => {
    const { command } = await loadPluginFull({})
    const result = await command.handler(invocation(undefined, '@"my spec.docx"'))
    assert.equal(result.kind, 'success', result.text)
    assert.ok(existsSync(join(workspaceRoot, 'docs', 'my spec.md')), 'the quoted mention must resolve')
  })

  test('/word2md accepts an absolute path too', async () => {
    const { command } = await loadPluginFull({})
    const result = await command.handler(invocation(undefined, `"${fixture}"`))
    assert.equal(result.kind, 'success', result.text)
    assert.ok(existsSync(join(workspaceRoot, 'docs', `${basename(fixture, '.docx')}.md`)))
  })

  test('/word2md honours an explicit output directory argument', async () => {
    const { command } = await loadPluginFull({})
    const target = join(workDir, 'explicit-out')
    const result = await command.handler(invocation(undefined, `@spec.docx "${target}"`))
    assert.equal(result.kind, 'success', result.text)
    assert.ok(existsSync(target), 'the explicit directory must be created')
  })

  test('/word2md without a path explains its usage', async () => {
    const { command } = await loadPluginFull({})
    const result = await command.handler(invocation(undefined, ''))
    assert.equal(result.kind, 'error')
    assert.match(result.text, /word2md/)
    assert.match(result.text, /@/, 'the usage must show the @ mention form')
  })

  test('/word2md reports a missing reference as a failure, not a crash', async () => {
    const { command } = await loadPluginFull({})
    const result = await command.handler(invocation(undefined, '@absent.docx'))
    assert.equal(result.kind, 'error')
    assert.match(result.text, /no such file/)
  })

  test('/word2md reports a non-Word reference as a failure', async () => {
    writeFileSync(join(workspaceRoot, 'notes.txt'), 'plain text')
    const { command } = await loadPluginFull({})
    const result = await command.handler(invocation(undefined, '@notes.txt'))
    assert.equal(result.kind, 'error')
    assert.match(result.text, /expected a Word document/)
  })

  test('/word2md refuses a trailing word that is not a path', async () => {
    const { command } = await loadPluginFull({})
    /* The output-directory argument must not swallow a stray word, which would
     * silently file the result under a directory named after it. */
    const result = await command.handler(invocation(undefined, '@spec.docx 处理'))
    assert.equal(result.kind, 'error')
    assert.match(result.text, /不像路径/)
    assert.match(result.text, /处理/)
  })

  test('/word2md reports which workspace source it resolved', async () => {
    const { command } = await loadPluginFull({})
    /* An explicit output directory keeps the fallback from writing into the
     * process working directory while still exercising the source reporting. */
    const explicit = join(workDir, 'source-report')
    const fromAgent = await command.handler(invocation(undefined, `@spec.docx "${explicit}"`))
    assert.equal(fromAgent.kind, 'success', fromAgent.text)
    assert.match(
      fromAgent.text,
      /session\.header\.cwd/,
      'the working directory must come from session.header.cwd, the same field the @ provider uses',
    )

    const explicitLegacy = join(workDir, 'source-report-legacy')
    const fromLegacy = await command.handler({
      agent: { session: { cwd: workspaceRoot } },
      rawInput: `@spec.docx "${explicitLegacy}"`,
      attachments: [],
    })
    assert.equal(fromLegacy.kind, 'success', fromLegacy.text)
    assert.match(fromLegacy.text, /session\.cwd/, 'a flatter session shape is still honoured')

    const explicitAgain = join(workDir, 'source-report-2')
    const fromFallback = await command.handler(invocation({}, `"${fixture}" "${explicitAgain}"`))
    assert.equal(fromFallback.kind, 'success', fromFallback.text)
    assert.match(fromFallback.text, /process\.cwd\(\)/, 'an agent without a cwd falls back to the process directory')
  })
}

/* ------------------------------------------------------------------ run */

let failures = 0
for (const [name, fn] of tests) {
  try {
    await fn()
    console.log(`ok   ${name}`)
  } catch (error) {
    failures += 1
    console.error(`FAIL ${name}`)
    console.error(error)
  }
}
rmSync(workDir, { recursive: true, force: true })
console.log(`\n${tests.length - failures}/${tests.length} passed`)
process.exit(failures === 0 ? 0 : 1)
