# @local/dsh-right-click-row-menu

English | [中文](README.zh.md)

Right-click a **Workspace** or **Session** row in the Harness sidebar and its
"..." menu opens directly, instead of having to hover the row and click the
ellipsis icon.

## What it does

- Capture-phase `contextmenu` listener on the document.
- When the right-click lands inside a sidebar row (`data-row-key` starting with
  `session:` or `workspace:`), the native browser menu is suppressed and the
  row's shipped "..." trigger is clicked, which opens the normal row menu with
  all of its usual entries (rename, fork, pin, archive, plus any plugin-added
  entries).
- A row whose menu is already open is left open; a row that has no menu, or
  whose trigger cannot be identified, is left completely alone — the native
  context menu still appears and no other control is clicked.
- Clicking "..." still works exactly as before. The plugin only adds a second
  way to activate the same trigger.

## Why it clicks the shipped trigger

The menu and its open state are private React state inside
`@deepseek-ai/dsh-client-ui-workspace`, and the menu items are slot entries
registered by that package. A separate plugin cannot set that state or reuse
those actions, so the only public way to open the shipped menu is to activate
the shipped trigger. This is deliberately the whole of the coupling.

The DOM contract this relies on, verified against the shipped
`dsh-client-ui-workspace` client bundle:

| Assumption | Shipped value |
|---|---|
| Row element | `div[data-row-key]` = `session:<id>` or `workspace:<key>`, `role="treeitem"` |
| Actions strip | element whose CSS-module class ends in `rowActions` |
| Menu trigger | the strip's button named by `actions.workspace.aria` / `actions.session.aria` |
| Shipped dictionaries | `zh` (`工作区“X”的操作` / `会话“X”的操作`) and `en` (`Workspace/Session actions for X`) |
| Menu open flag | a `menuOpen` class on the row |

Every step degrades to "do nothing" when a selector does not match, so an
upstream rename can only make the feature stop working, never mis-click an
unrelated control.

A first-class version of this feature would instead be a one-line
`onContextMenu` on the row in `packages/client/ui-workspace/src/client`, which
is both simpler and upgrade-proof; that belongs upstream, not in this repo.

## Files

| File | Role |
|---|---|
| `package.json` | Bundle manifest: `dsh.bundle.patch`, plus `dsh.client` for the browser half |
| `cordis.patch.yml` | Inserts the bundle's Loader row |
| `index.js` | Host half — inert; the feature is entirely client-side |
| `client.js` | Browser half: the `contextmenu` handler |
| `test/client.test.mjs` | Regression test against a minimal DOM mock of the contract above |
| `tools/plugin-url.mjs` | Prints this bundle's revision URL under `/plugins` for probing |

## Install

```sh
dsh plugin --profile <profile> add "link:<absolute path to this directory>"
```

`dsh plugin` forwards to pnpm in the profile and then selects any newly
installed bundle, appending it to `dsh.profile.bundles`. The `link:` spec keeps
this directory as the live source, so edits here take effect after a reload
without reinstalling.

To remove it: `dsh plugin --profile <profile> remove @local/dsh-right-click-row-menu`,
and drop the name from `dsh.profile.bundles` if it remains.

## Verify

```sh
node test/client.test.mjs   # 10/10 passing
node tools/plugin-url.mjs   # current /plugins revision URL
```

The test covers the matching logic and its failure modes. It does not prove
what a browser renders: the DOM mock is built from the contract, not from a
real page. Confirm visually by right-clicking a sidebar row, and confirm the
row menu is unchanged by clicking "..." as before.

## Known limits

- The trigger is recognized by its accessible-name shape, which covers the two
  shipped dictionaries (`zh`, `en`). A future language would silently disable
  the feature there — never mis-click. Extend `ACTIONS_LABEL` in `client.js` to
  cover another language.
- The actions strip is `display:none` until the row is hovered. A right-click
  always hovers the row, so this is only handled as a safety net: the strip is
  shown for the click when it measures zero-sized, then restored.

Dependencies: none. The browser half imports nothing — not even React.
