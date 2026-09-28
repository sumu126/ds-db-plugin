/**
 * Client check: run the browser half's `apply` for real.
 *
 * The other checks either mount the Host or read the card model in isolation, so
 * nothing executed the client entry: slot registration, locale dictionaries, the
 * settings-scope binding, and the inject faces the settings page renders from
 * were only ever exercised in a live browser. This mounts the client half against
 * node doubles of the five services it injects and asserts what it registered —
 * including that disposing the owning fiber takes every registration away, which
 * is the property a hot reload depends on.
 *
 * The harness mounts no DOM: `apply` registers and binds, it does not render.
 *
 * Run it from this plugin's directory.
 *
 *   npm run verify:client
 */
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { load, resolve } from './css-stub.mjs'

// The component files import their stylesheets, which only the build's CSS
// Modules pipeline can compile. Registering the stub before the client modules
// are imported keeps this check about what `apply` registers.
registerHooks({ resolve, load })

const { apply, inject } = await import('../src/client/index.ts')
const { DB_SETTINGS_NAMESPACE } = await import('../src/contract.ts')
const { en: pageEn, zh: pageZh } = await import('../src/client/locales.ts')
const { TOOL_NS } = await import('../src/client/tool-locales.ts')
const { TOOL_ROW_KEYS } = await import('../src/client/card-model.ts')

/** One registration the fake slot service accepted, keyed by a minted seat id. */
const seats = new Map()
/** The next seat id the fake slot service mints. */
let nextSeat = 0
/** Locale namespaces registered, by namespace, with the dictionaries handed over. */
const dictionaries = new Map()
/** Namespaces bound through the fake settings scope. */
const bound = []

/** The translate seat the locale service hands back, with `{name}` interpolation. */
function translate(dict, key, params) {
  const template = dict?.[key]
  if (typeof template !== 'string') throw new Error(`missing copy for "${String(key)}"`)
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/gu, (match, name) => (name in params ? String(params[name]) : match))
}

/**
 * One fake context carrying the five services the client half injects.
 *
 * Every effect body runs immediately and the disposer it returns is owned here,
 * so `dispose()` reproduces what the framework does on unload. The slot service
 * owns its registrations the same way — the real `slots.inject` installs them
 * under `ctx.effect`, which is why unloading the fiber takes them with it even
 * though `apply` discards the returned disposer.
 */
function makeContext() {
  const disposers = []
  /** Run one effect and keep its disposer, as the framework does. */
  const effect = (callback) => {
    const disposer = callback()
    if (disposer !== undefined) disposers.push(disposer)
    return () => {}
  }
  const locale = {
    register(ns, dict) {
      dictionaries.set(ns, dict)
      return () => { dictionaries.delete(ns) }
    },
    bind(ns) {
      return (key, params) => translate(dictionaries.get(ns)?.zh, key, params)
    },
  }
  const slots = {
    /**
     * The declaration-aware inject seat: a slot this plugin does not itself
     * declare is treated as already declared, which is what the real registry
     * does once the owning package is up.
     *
     * A generator registrant is driven to completion and its `return` called on
     * teardown, mirroring the transactional effect the real `slots.inject` gives
     * it: the plugin registers its four tool rows that way.
     * @param name - slot key the registration targets.
     * @param callback - the registrant, called with the declaration in place.
     * @returns a disposer the caller owns; the registration also dies with the fiber.
     */
    inject(name, callback) {
      effect(() => {
        const owned = []
        const created = callback()
        let generator
        if (created !== null && typeof created === 'object' && typeof created.next === 'function') {
          generator = created
          for (let step = generator.next(); step.done !== true; step = generator.next()) {
            owned.push(step.value)
          }
        } else if (created !== undefined) {
          owned.push(created)
        }
        return () => {
          for (const dispose of owned) dispose()
          generator?.return?.()
        }
      })
      // The plugin discards this; the framework owns the registration either way.
      return () => {}
    },
    register(options, component) {
      const id = nextSeat++
      seats.set(id, { options, component })
      return () => { seats.delete(id) }
    },
  }
  const scope = {
    getSnapshot: () => ({
      status: 'ready',
      value: { connections: [], activeId: '' },
      base: undefined,
      user: undefined,
      revision: 1,
      writable: true,
      mode: 'host',
    }),
    subscribe: () => () => {},
    mutate: async () => {},
    set: async () => {},
    unset: async () => {},
  }
  const remote = {
    credentials: {
      describe: async refs => ({ ok: true, value: Object.fromEntries(refs.map(ref => [ref, { configured: false, writable: true }])) }),
      set: async () => ({ ok: true, value: undefined }),
    },
  }
  const ctx = {
    effect,
    locale,
    slots,
    remote,
    settingsScope: {
      bind(spec) {
        bound.push(spec.namespace)
        return scope
      },
    },
  }
  return {
    ctx,
    async dispose() {
      // Reverse order, as a fiber unloads its effects.
      for (const disposer of [...disposers].reverse()) await disposer?.()
    },
  }
}

// The declaration the framework would wait on before calling `apply`.
assert.deepEqual(inject, ['slots', 'locale', 'remote', 'remote.credentials', 'settingsScope'], 'the client declares the services it reads')

const harness = makeContext()
apply(harness.ctx)

// Both dictionaries land, and under the namespaces the renderer looks up. A page
// whose copy never registered throws on the first read in a real browser, so the
// two keys are asserted by name rather than by count.
assert.ok(dictionaries.has('settings.db'), 'the page namespace registers')
assert.ok(dictionaries.has(TOOL_NS), 'the tool-row namespace registers')
assert.deepEqual(Object.keys(dictionaries.get('settings.db').zh).sort(), Object.keys(pageZh).sort(), 'the Chinese page dictionary is handed over whole')
assert.deepEqual(Object.keys(dictionaries.get('settings.db').en).sort(), Object.keys(pageEn).sort(), 'and its English counterpart keys the same copy')

const allSeats = () => [...seats.values()]
const section = allSeats().find(seat => seat.options.name === 'settings.section')
assert.ok(section, 'the settings page claims a settings.section seat')
assert.equal(section.options.id, DB_SETTINGS_NAMESPACE, 'the seat id is the settings namespace the Host serves')
assert.equal(section.options.locale, 'settings.db', 'the seat resolves its copy from this plugin namespace')
assert.ok(typeof section.options.label === 'function', 'the nav label is a thunk, so it follows a locale switch')
assert.equal(section.options.label(), pageZh.nav, 'the nav label is translated through the seat, not a literal')
assert.ok(section.options.order > 10, 'the page sorts after the shipped sections')

// The inject face is what the page renders from: a `hooks` compartment the
// renderer turns into a selector hook, plus the actions it may call.
const face = section.options.inject()
assert.ok(face.hooks?.dbPage, 'the inject face carries a hooks compartment holding the page source')
assert.ok(typeof face.hooks.dbPage.getSnapshot === 'function', 'the hooks member is a bare observable source, not a value')
// The opening projection: the namespace the Host resolved is writable, no
// connection is saved yet, and no dialog is open.
const opening = face.hooks.dbPage.getSnapshot()
assert.equal(opening.available, true, 'the page reports the settings namespace as available')
assert.equal(opening.writable, true, 'and as writable')
assert.deepEqual(opening.cards, [], 'a namespace holding no connection opens with an empty card list')
assert.deepEqual(opening.dialog, { kind: 'closed' }, 'and no dialog open')
for (const action of ['openNew', 'openEdit', 'closeDialog', 'chooseDialect', 'editField', 'editExtra', 'editPassword', 'testDraft', 'saveDialog', 'activate', 'testSaved', 'remove']) {
  assert.ok(typeof face[action] === 'function', `the inject face exposes the "${action}" action`)
}
assert.deepEqual(bound, [DB_SETTINGS_NAMESPACE], 'the page reads and writes the one settings namespace it owns')

// One seat per claimed tool key, keyed by the wire name the shell matches.
const rows = allSeats().filter(seat => seat.options.name === 'tool.call.toolview')
assert.deepEqual(rows.map(seat => seat.options.key).sort(), [...TOOL_ROW_KEYS].sort(), 'a row is claimed for exactly the tools this plugin draws cards for')
for (const row of rows) {
  assert.equal(row.options.locale, TOOL_NS, `the "${String(row.options.key)}" row resolves its copy from the tool namespace`)
  assert.equal(typeof row.component, 'function', `the "${String(row.options.key)}" row is a component`)
}
console.log(`registered: settings.section + ${String(rows.length)} tool row(s) (${rows.map(row => String(row.options.key)).join(', ')})`)

// The reload property: an unload takes every registration with it. A seat that
// outlives its fiber is a duplicate contribution on the next load.
await harness.dispose()
assert.equal(seats.size, 0, 'disposing the fiber removes every slot registration')
assert.equal(dictionaries.size, 0, 'and every dictionary it registered')
console.log('disposal: unloading the fiber removed every registration')

// A second mount is a clean one: nothing from the first run survives into it.
const second = makeContext()
apply(second.ctx)
assert.equal(allSeats().filter(seat => seat.options.name === 'tool.call.toolview').length, TOOL_ROW_KEYS.length, 'a remount registers the rows again, once each')
await second.dispose()
assert.equal(seats.size, 0, 'and unloads cleanly again')
console.log('reload: a second mount registers once each and unloads clean')

console.log('client check passed')
