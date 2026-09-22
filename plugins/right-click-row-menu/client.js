/**
 * Client half of the right-click row menu bundle.
 *
 * The sidebar's Workspace and Session rows reveal their actions strip on
 * hover; that strip holds a "..." button whose click toggles the row menu
 * rendered by `@deepseek-ai/dsh-client-ui-workspace`. The menu's open state is
 * private React state inside that package, so a separate plugin cannot set it
 * directly: the only public way to open the shipped menu is to activate the
 * shipped trigger. This plugin therefore listens for `contextmenu` on the rows
 * and clicks that trigger, which makes right-click behave exactly like
 * clicking "..." — including the existing menu contents and dismissal rules.
 *
 * DOM contract relied on here (all verified against the shipped
 * `@deepseek-ai/dsh-client-ui-workspace` client bundle):
 *
 * - A row is `div[data-row-key]`, valued `session:<id>` or `workspace:<key>`,
 *   with `role="treeitem"`.
 * - The actions strip is a `span` whose CSS-module class ends in
 *   `rowActions`, hidden until the row is hovered or its menu is open.
 * - The menu trigger is the strip's button whose accessible name comes from
 *   the locale keys `actions.workspace.aria` / `actions.session.aria`; the
 *   shipped dictionaries are `zh` and `en`, hence the two label shapes below.
 * - Opening the menu toggles a `menuOpen` class on the row, which is how this
 *   plugin tells an already-open menu from a closed one.
 *
 * Everything degrades to "do nothing" (leaving the browser's own context menu
 * in place) when the contract does not match, so an upstream change can only
 * disable this feature, never mis-click an unrelated control.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-right-click-row-menu',
  factory() {
    /** Rows the sidebar browser owns: Workspace groups and Sessions. */
    const ROW_SELECTOR = '[data-row-key^="session:"], [data-row-key^="workspace:"]'
    /** The hover-revealed actions strip inside a row. */
    const ACTIONS_STRIP_SELECTOR = '[class*="rowActions"]'
    /**
     * Accessible names of the row menu trigger in every shipped dictionary:
     * en "Workspace actions for X" / "Session actions for X" and
     * zh "工作区“X”的操作" / "会话“X”的操作".
     */
    const ACTIONS_LABEL = /^(?:Workspace|Session) actions for |的操作$/

    /**
     * Whether the row already shows its menu, recognized by the `menuOpen`
     * class the browser adds to the row rather than by any global menu lookup.
     * @param row - the row element.
     * @returns true when the row's menu is already open.
     */
    function isMenuOpen(row) {
      return Array.from(row.classList).some((name) => name === 'menuOpen' || name.endsWith('_menuOpen'))
    }

    /**
     * The row's "..." button, found by its accessible name so that a row
     * without a menu (no actions, blank or overflow rows) yields nothing
     * instead of the neighbouring New Session control.
     * @param row - the row element.
     * @returns the trigger button, or null when this row has no menu.
     */
    function findMenuTrigger(row) {
      const strip = row.querySelector(ACTIONS_STRIP_SELECTOR)
      if (strip === null) return null
      for (const button of strip.querySelectorAll('button')) {
        if (ACTIONS_LABEL.test(button.getAttribute('aria-label') ?? '')) return button
      }
      return null
    }

    /**
     * Click the trigger, keeping it measurable first. The actions strip is
     * display:none until hover, and a contextmenu raised without a pointer over
     * the row would measure as zero-sized and place the portalled menu in the
     * corner, so the strip is shown for the click when needed and restored on
     * the next frame.
     * @param trigger - the row menu trigger.
     */
    function activate(trigger) {
      const strip = trigger.closest(ACTIONS_STRIP_SELECTOR)
      if (!(strip instanceof HTMLElement) || strip.getBoundingClientRect().width > 0) {
        trigger.click()
        return
      }
      const previous = strip.style.display
      strip.style.display = 'inline-flex'
      try {
        trigger.click()
      } finally {
        requestAnimationFrame(() => {
          strip.style.display = previous
        })
      }
    }

    /**
     * Open the row menu for a right-click on a Workspace or Session row.
     * @param event - the document-level contextmenu event.
     */
    function onContextMenu(event) {
      const target = event.target
      if (!(target instanceof Element)) return
      const row = target.closest(ROW_SELECTOR)
      if (!(row instanceof HTMLElement)) return
      if (isMenuOpen(row)) {
        event.preventDefault()
        return
      }
      const trigger = findMenuTrigger(row)
      if (trigger === null) return
      event.preventDefault()
      activate(trigger)
    }

    return {
      apply(ctx) {
        ctx.effect(() => {
          document.addEventListener('contextmenu', onContextMenu, true)
          return () => {
            document.removeEventListener('contextmenu', onContextMenu, true)
          }
        })
      },
    }
  },
})
