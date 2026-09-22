# DeepSeek Harness plugins

English | [中文](README.zh.md)

Plugin bundles for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness),
written as ordinary workspace packages and installed into a Harness profile with
`dsh plugin`. Everything here is a bundle: a package whose `package.json`
declares `dsh.bundle.patch`, whose patch inserts its own Loader row, and which
may additionally declare `dsh.client` to run code in the Web page.

## Plugins

| Plugin | What it does | Profile | Dependencies |
|---|---|---|---|
| [`right-click-row-menu`](plugins/right-click-row-menu/README.md) | Right-click a Workspace or Session row in the sidebar to open its "..." menu, instead of hovering and clicking the ellipsis icon. | `web` | none |
| [`word-to-markdown`](plugins/word-to-markdown/README.md) | Converts a Word `.docx` into Markdown, extracting its embedded images as `![](path)`: a `word_to_markdown` tool for the agent, and a `/word2md` slash command that takes an `@`-referenced path and writes into the workspace `docs/` folder. | `web` | pandoc on the Host |

## Install

Install one plugin into the profile you run, from this repository root:

```sh
dsh plugin --profile web add "link:$PWD/plugins/right-click-row-menu"
```

`dsh plugin` forwards to pnpm inside the profile directory and then selects any
newly installed bundle, appending it to `dsh.profile.bundles`. Installing a new
bundle can activate through HMR; reloading the page picks up a new client
bundle.

The `link:` spec keeps the checkout as the live source: edit a plugin here,
reload, and the change is live with no reinstall. Swap it for a published
version or a `git+` spec when a plugin should come from a registry instead.

Remove one with:

```sh
dsh plugin --profile web remove @local/<package-name>
```

## Layout

```
plugins/<name>/
  package.json         bundle manifest: dsh.bundle.patch (+ dsh.client for Web UI)
  cordis.patch.yml     the Loader patch this bundle contributes
  index.js             Host half (plugin entry: apply / inject / Config)
  client.js            Browser half (window.__ModuleLoader__.load({ id, factory }))
  test/                tests that run without a Harness instance
  tools/               development helpers
  README.md            English documentation
  README.zh.md         中文文档
  README.i18n.yaml     bilingual-pair hash record
```

Conventions followed here, matching the Harness packages themselves:

- **Bilingual documentation.** Every `README.md` has a `README.zh.md`
  counterpart; both sides carry equal authority and must be edited together.
  `README.i18n.yaml` records the git blob hash of each side at the last
  confirmed-consistent state, so an unpaired edit is detectable.
- **No `export default` in a Host plugin.** The Loader's `unwrapExports`
  collapses a module with a default export and drops `inject`; use named
  `export function apply` / `export const inject` / `export const Config`.
- **Client bundles import nothing unnecessary.** React and the static UI
  libraries come from the browser module table; declare any other runtime
  import in `dsh.client.external`.
- **Resources are registered in `apply`** with `ctx.effect` / `ctx.on`, and
  return their cleanup.

## Adding a plugin

1. Copy the closest existing plugin, or start from the templates shipped with
   the `cordis-plugin-development` skill.
2. Give the package a unique name, set the patch row's `id` and `name`, and keep
   the client bundle's `window.__ModuleLoader__.load({ id })` equal to the
   package name.
3. Install it with `dsh plugin --profile <profile> add "link:<path>"`.
4. Verify the capability itself before reporting it done — inspect the composed
   tree with `dsh --profile <profile> --dump-config` and exercise it in the UI.

## Verify a checkout

Each plugin carries its own tests and states its verification limits in its
README; run them from the plugin directory, for example:

```sh
cd plugins/right-click-row-menu
node test/client.test.mjs
```

Tests here must run without a Harness instance and without network access. A
plugin whose behavior can only be confirmed visually says so in its README
rather than substituting a mock for the real page.
