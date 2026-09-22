/**
 * Regression test for the right-click row menu client half.
 *
 * No browser is available in this environment, so the shipped Workspace
 * browser's markup is reproduced here as a minimal DOM mock using the exact
 * contract recorded in `../client.js` (row `data-row-key`, the `rowActions`
 * strip, the locale-shaped accessible name, and the row's `menuOpen` class).
 * The test pins this plugin's behavior and those coupling assumptions; it does
 * not prove what a real browser renders.
 *
 * Run with: node test/client.test.mjs
 */
import assert from 'node:assert/strict'

/* ------------------------------------------------------------------ *
 * Minimal DOM
 * ------------------------------------------------------------------ */

class MockHTMLElement {
  constructor(tag, attrs = {}, classes = [], children = []) {
    this.tagName = tag.toUpperCase()
    this.attrs = { ...attrs }
    this.children = []
    this.parentNode = null
    /* A CSSStyleDeclaration reports '' for an unset property, and assigning '' clears it. */
    this.style = { display: '' }
    this.clickCount = 0
    this.width = 100
    this.classes = [...classes]
    this.classList = {
      add: (...names) => this.classes.push(...names),
      contains: (name) => this.classes.includes(name),
      toString: () => this.classes.join(' '),
      [Symbol.iterator]: () => this.classes[Symbol.iterator](),
    }
    for (const child of children) this.append(child)
  }

  append(child) {
    child.parentNode = this
    this.children.push(child)
    return child
  }

  getAttribute(name) {
    if (name === 'class') return this.classes.join(' ') || null
    return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null
  }

  getBoundingClientRect() {
    return { width: this.width, height: 16, top: 0, left: 0, right: this.width, bottom: 16 }
  }

  click() {
    this.clickCount += 1
  }

  descendants() {
    return this.children.flatMap((child) => [child, ...child.descendants()])
  }

  querySelector(selector) {
    return this.descendants().find((el) => matches(el, selector)) ?? null
  }

  querySelectorAll(selector) {
    return this.descendants().filter((el) => matches(el, selector))
  }

  closest(selector) {
    let node = this
    while (node !== null) {
      if (matches(node, selector)) return node
      node = node.parentNode
    }
    return null
  }
}

const ATTR_RE = /\[([a-zA-Z-]+)(?:(\^=|\*=|=)"([^"]*)")?\]/g

function matchesSimple(el, selector) {
  const tag = /^[a-zA-Z]+/.exec(selector)
  const rest = selector.slice(tag === null ? 0 : tag[0].length)
  if (tag !== null && el.tagName !== tag[0].toUpperCase()) return false
  ATTR_RE.lastIndex = 0
  let match
  while ((match = ATTR_RE.exec(rest)) !== null) {
    const [, name, operator, value] = match
    const actual = el.getAttribute(name)
    if (actual === null) return false
    if (operator === '^=' && !actual.startsWith(value)) return false
    if (operator === '*=' && !actual.includes(value)) return false
    if (operator === '=' && actual !== value) return false
  }
  return true
}

function matches(el, selector) {
  return selector.split(',').some((part) => matchesSimple(el, part.trim()))
}

/* ------------------------------------------------------------------ *
 * Harness
 * ------------------------------------------------------------------ */

const listeners = new Map()
const frames = []
let loadCount = 0
let plugin

globalThis.Element = MockHTMLElement
globalThis.HTMLElement = MockHTMLElement
globalThis.window = {
  __ModuleLoader__: {
    load(registration) {
      loadCount += 1
      plugin = registration.factory()
    },
  },
}
globalThis.document = {
  addEventListener(type, handler, capture) {
    listeners.set(`${type}:${capture === true}`, handler)
  },
  removeEventListener(type, handler, capture) {
    const key = `${type}:${capture === true}`
    if (listeners.get(key) === handler) listeners.delete(key)
  },
}
globalThis.requestAnimationFrame = (callback) => {
  frames.push(callback)
  return frames.length
}

await import('../client.js')

/** Mount the plugin the way the client module system does; return its disposer. */
function mount() {
  const disposers = []
  plugin.apply({
    effect(register) {
      disposers.push(register())
    },
  })
  return () => disposers.forEach((dispose) => dispose())
}

/** Raise a right-click on `target`, flush a frame, and report what happened. */
function rightClick(target) {
  const handler = listeners.get('contextmenu:true')
  assert.ok(handler, 'the plugin must register a capture-phase contextmenu listener')
  let prevented = false
  handler({ target, preventDefault: () => { prevented = true } })
  while (frames.length > 0) frames.shift()()
  return { prevented }
}

const buttonsOf = (row) => row.querySelectorAll('button')

/** A Workspace group row: actions strip holds the "..." trigger, then New Session. */
function workspaceRow(label, { ariaLabel = `Workspace actions for ${label}`, withMenu = true } = {}) {
  const row = new MockHTMLElement('div', { 'data-row-key': `workspace:${label}` }, ['YDXeBa_projectRow'])
  const strip = new MockHTMLElement('span', {}, ['YDXeBa_rowActions'])
  if (withMenu) {
    strip.append(new MockHTMLElement('span', {}, ['abc_root'], [
      new MockHTMLElement('button', { 'aria-label': ariaLabel }, ['YDXeBa_iconButton']),
    ]))
  }
  strip.append(new MockHTMLElement('span', {}, ['abc_root'], [
    new MockHTMLElement('button', { 'aria-label': `New Session for ${label}` }, ['YDXeBa_iconButton']),
  ]))
  row.append(strip)
  return { row, strip }
}

/** A Session row: actions strip holds the "..." trigger, then a hover action button. */
function sessionRow(title, { ariaLabel = `Session actions for ${title}`, withMenu = true } = {}) {
  const row = new MockHTMLElement('div', { 'data-row-key': `session:${title}` }, ['YDXeBa_sessionRow'])
  const titleElement = new MockHTMLElement('span', {}, ['YDXeBa_title'])
  row.append(titleElement)
  const strip = new MockHTMLElement('span', {}, ['YDXeBa_rowActions'])
  if (withMenu) {
    strip.append(new MockHTMLElement('span', {}, ['abc_root'], [
      new MockHTMLElement('button', { 'aria-label': ariaLabel }, ['YDXeBa_iconButton']),
    ]))
  }
  strip.append(new MockHTMLElement('button', { 'aria-label': `Pin ${title}` }, ['YDXeBa_iconButton']))
  row.append(strip)
  return { row, strip, titleElement }
}

/* ------------------------------------------------------------------ *
 * Cases
 * ------------------------------------------------------------------ */

const tests = []
const test = (name, fn) => tests.push([name, fn])

test('registers one factory and a capture-phase listener, released on dispose', () => {
  assert.equal(loadCount, 1, 'client.js must register exactly one factory')
  assert.equal(listeners.size, 0, 'no listener may exist before apply')
  const dispose = mount()
  assert.ok(listeners.has('contextmenu:true'), 'the listener is registered in apply')
  dispose()
  assert.equal(listeners.size, 0, 'dispose must release the listener')
})

test('right-click on a Session row clicks the shipped "..." trigger', () => {
  const dispose = mount()
  const { row } = sessionRow('Fix the tests')
  const trigger = buttonsOf(row)[0]
  const result = rightClick(row)
  assert.equal(result.prevented, true, 'the native menu is suppressed')
  assert.equal(trigger.clickCount, 1, 'the menu trigger is activated exactly once')
  assert.equal(buttonsOf(row)[1].clickCount, 0, 'the hover action button is untouched')
  dispose()
})

test('right-click on a row descendant still resolves to the row', () => {
  const dispose = mount()
  const { row, titleElement } = sessionRow('Rename me')
  const trigger = buttonsOf(row)[0]
  const result = rightClick(titleElement)
  assert.equal(result.prevented, true)
  assert.equal(trigger.clickCount, 1)
  dispose()
})

test('right-click on a Workspace row opens its menu, never New Session', () => {
  const dispose = mount()
  const { row } = workspaceRow('MyProject')
  const [menuTrigger, newSession] = buttonsOf(row)
  assert.equal(menuTrigger.getAttribute('aria-label'), 'Workspace actions for MyProject')
  assert.equal(newSession.getAttribute('aria-label'), 'New Session for MyProject')
  const result = rightClick(row)
  assert.equal(result.prevented, true)
  assert.equal(menuTrigger.clickCount, 1)
  assert.equal(newSession.clickCount, 0)
  dispose()
})

test('matches the shipped Chinese dictionary shape', () => {
  const dispose = mount()
  const { row: session } = sessionRow('修复测试', { ariaLabel: '会话“修复测试”的操作' })
  assert.equal(rightClick(session).prevented, true)
  assert.equal(buttonsOf(session)[0].clickCount, 1)
  const { row: workspace } = workspaceRow('项目', { ariaLabel: '工作区“项目”的操作' })
  assert.equal(rightClick(workspace).prevented, true)
  assert.equal(buttonsOf(workspace)[0].clickCount, 1)
  dispose()
})

test('right-click outside any row is left to the browser', () => {
  const dispose = mount()
  const outside = new MockHTMLElement('div', {}, [], [
    new MockHTMLElement('span', { 'data-row-key': 'empty' }),
  ])
  assert.equal(rightClick(outside).prevented, false)
  dispose()
})

test('an already-open row menu is left open instead of toggled closed', () => {
  const dispose = mount()
  const { row } = sessionRow('Pinned session')
  row.classList.add('YDXeBa_menuOpen')
  const trigger = buttonsOf(row)[0]
  const result = rightClick(row)
  assert.equal(result.prevented, true, 'the native menu stays suppressed')
  assert.equal(trigger.clickCount, 0, 'the open menu is not toggled shut')
  dispose()
})

test('a row without a menu never activates another control', () => {
  const dispose = mount()
  const { row } = workspaceRow('No actions', { withMenu: false })
  const newSession = buttonsOf(row)[0]
  const result = rightClick(row)
  assert.equal(result.prevented, false, 'leave the native menu when nothing can be opened')
  assert.equal(newSession.clickCount, 0, 'the New Session button must not be activated')
  dispose()
})

test('an unrecognized trigger label is refused instead of guessed', () => {
  const dispose = mount()
  const { row } = sessionRow('Unknown locale', { ariaLabel: 'Acciones de la sesión' })
  const result = rightClick(row)
  assert.equal(result.prevented, false)
  assert.equal(buttonsOf(row)[0].clickCount, 0)
  dispose()
})

test('a hover-hidden actions strip is revealed for the click, then restored', () => {
  const dispose = mount()
  const { row, strip } = sessionRow('Hidden strip')
  strip.width = 0
  const trigger = buttonsOf(row)[0]
  const result = rightClick(row)
  assert.equal(result.prevented, true)
  assert.equal(trigger.clickCount, 1)
  assert.equal(strip.style.display, '', 'the strip style must be restored')
  dispose()
})

let failures = 0
for (const [name, fn] of tests) {
  try {
    fn()
    console.log(`ok   ${name}`)
  } catch (error) {
    failures += 1
    console.error(`FAIL ${name}`)
    console.error(error)
  }
}
console.log(`\n${tests.length - failures}/${tests.length} passed`)
process.exit(failures === 0 ? 0 : 1)
