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
const { DB_COLUMNS_PATH, DB_DATABASES_PATH, DB_DIALECTS_PATH, DB_QUERY_PATH, DB_SETTINGS_NAMESPACE, DB_TABLES_PATH } = await import('../src/contract.ts')
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
/** Right-sidebar tab types registered, by the identity the shell dispatches on. */
const tabTypes = new Map()

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
function makeContext(settings = { connections: [], activeId: '' }) {
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
      value: settings,
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
  // The tab-type registry the shell dispatches page types through: the guide is
  // its entry point, so what a type contributes there is what a check can see.
  const sidebarRightTabs = {
    register(definition) {
      tabTypes.set(definition.id, definition)
      return () => { tabTypes.delete(definition.id) }
    },
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
    sidebarRightTabs,
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
assert.deepEqual(inject, ['slots', 'locale', 'remote', 'remote.credentials', 'settingsScope', 'sidebarRightTabs'], 'the client declares the services it reads')

// ---- The stubbed routes and browser globals ------------------------------

/** The MySQL dialect's own catalog entry, as the Host describes it. */
const MYSQL_DESCRIPTOR = {
  name: 'mysql',
  label: 'MySQL',
  description: 'MySQL',
  capabilities: ['databases', 'tables', 'columns', 'indexes', 'estimatedRows', 'charset', 'version'],
  configFields: [],
  // The dialect names a reference, which is exactly why seeding a new
  // connection from it must not hand every connection the same one.
  connectionDefaults: { host: '127.0.0.1', port: 3306, user: 'root', passwordEnv: 'DSH_MYSQL_PASSWORD' },
  systemDatabases: ['information_schema', 'mysql', 'performance_schema', 'sys'],
}

/** The payloads this plugin's four routes answer with, by path. */
const ANSWERS = new Map([
  [DB_DIALECTS_PATH, { installed: [MYSQL_DESCRIPTOR], known: [] }],
  [DB_DATABASES_PATH, { connection: 'A', databases: [{ name: 'app', charset: 'utf8mb4', collation: 'utf8mb4_bin' }] }],
  [DB_TABLES_PATH, { connection: 'A', database: 'app', tables: [{ name: 'events', type: 'BASE TABLE', engine: 'InnoDB', estimatedRows: 12, comment: '' }] }],
  [DB_COLUMNS_PATH, { connection: 'A', database: 'app', table: 'events', columns: [{ name: 'id', type: 'bigint', nullable: false, default: null, key: 'PRI', extra: 'auto_increment', comment: '' }] }],
])

/** Every route call this check caused, in order. */
const calls = []

/**
 * The payload the query route answers with, per request body.
 *
 * A check replaces it, so one run can be answered with rows, the next with the
 * sentence a refused statement comes back as, and a third with nothing at all —
 * which is what a statement the server is still working on looks like.
 */
let queryReply = () => ({
  columns: ['id', 'name'],
  rows: [{ id: 1, name: 'a' }],
  rowCount: 1,
  truncated: false,
  elapsedMs: 4,
})

/** The signal the last query run carried, so a cancel can be asserted on it. */
let querySignal

// The client reads through `fetch` on the page's own origin, so these stand in
// for the two browser globals a Node check does not have — and answer with the
// payloads the Host routes are written to send.
globalThis.window = { location: { origin: 'http://127.0.0.1:3099' } }
globalThis.fetch = async (url, init = {}) => {
  // A bare path, which is how the page reads the dialect catalog, resolves
  // against the page origin the way a browser resolves it.
  const address = new URL(String(url), 'http://127.0.0.1:3099')
  if (address.pathname === DB_QUERY_PATH) {
    const body = JSON.parse(init.body)
    querySignal = init.signal
    calls.push({ path: address.pathname, query: {}, method: 'POST', body })
    const answer = queryReply(body)
    // A held run answers nothing yet; `Response.json` would settle it at once.
    return answer instanceof Promise ? answer : Response.json(answer)
  }
  calls.push({ path: address.pathname, query: Object.fromEntries(address.searchParams), method: 'GET' })
  const body = ANSWERS.get(address.pathname)
  return body === undefined ? new Response('not stubbed', { status: 404 }) : Response.json(body)
}

/** Let the reads a gesture started land. */
async function settle() {
  for (let attempt = 0; attempt < 5; attempt++) await new Promise(resolve => setTimeout(resolve, 0))
}

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
for (const action of ['openNew', 'openEdit', 'closeDialog', 'chooseDialect', 'editField', 'newPasswordRef', 'editExtra', 'editPassword', 'testDraft', 'saveDialog', 'activate', 'testSaved', 'remove']) {
  assert.ok(typeof face[action] === 'function', `the inject face exposes the "${action}" action`)
}
assert.deepEqual([...new Set(bound)], [DB_SETTINGS_NAMESPACE], 'the page and the panel read the one settings namespace they both own')

// A new connection must not seed a credential reference another one already
// carries: the store holds one secret per reference, so a shared name means one
// connection's password silently replaces the other's — while the page reports
// both as configured.
const seededReferences = []
for (let round = 0; round < 2; round++) {
  face.openNew()
  await settle()
  face.chooseDialect('mysql')
  seededReferences.push(face.hooks.dbPage.getSnapshot().dialog.fields.passwordEnv)
}
assert.equal(
  new Set(seededReferences).size,
  seededReferences.length,
  `two connections seeded from one dialect must not share a reference (got ${seededReferences.join(', ')})`,
)
console.log(`credential references: two new connections seed ${seededReferences.join(' and ')}`)

// The refresh control is what a user reaches for once the page has told them a
// reference is shared, so it has to hand back a name nothing else is on — the
// same name again would leave the two connections sharing one password.
const beforeNewRef = face.hooks.dbPage.getSnapshot().dialog.fields.passwordEnv
face.newPasswordRef()
const afterNewRef = face.hooks.dbPage.getSnapshot().dialog.fields.passwordEnv
assert.notEqual(afterNewRef, beforeNewRef, 'the reference control mints a name of its own')
assert.ok(!seededReferences.includes(afterNewRef), 'and one no connection was already seeded with')
console.log(`credential references: the reference control then mints ${afterNewRef}`)

// One seat per claimed tool key, keyed by the wire name the shell matches.
const rows = allSeats().filter(seat => seat.options.name === 'tool.call.toolview')
assert.deepEqual(rows.map(seat => seat.options.key).sort(), [...TOOL_ROW_KEYS].sort(), 'a row is claimed for exactly the tools this plugin draws cards for')
for (const row of rows) {
  assert.equal(row.options.locale, TOOL_NS, `the "${String(row.options.key)}" row resolves its copy from the tool namespace`)
  assert.equal(typeof row.component, 'function', `the "${String(row.options.key)}" row is a component`)
}
console.log(`registered: settings.section + ${String(rows.length)} tool row(s) (${rows.map(row => String(row.options.key)).join(', ')})`)

// The browser catalog: a right-sidebar page type, its guide card, and the two
// seats the shell dispatches its body and its chip through.
assert.deepEqual(
  [...tabTypes.keys()].sort(),
  ['dsh-ds-db', 'dsh-ds-db-query'],
  'the catalog and the query window are registered, under the identities the shell dispatches on',
)
const tabType = tabTypes.get('dsh-ds-db')
assert.equal(tabType.kind, 'database', 'opened by kind, since a catalog has no resource address')
assert.equal(tabType.title(), pageZh.panelTitle, 'the chip label is translated at use, so a language switch reaches it')
// The guide is the only way a page type is reached: the strip's add control
// opens the guide, so a type without a card there cannot be opened at all.
assert.deepEqual(tabType.guide.map(entry => entry.id), ['database'], 'the type contributes exactly one guide card')
assert.equal(tabType.guide[0].title(), pageZh.panelTitle)
assert.equal(tabType.guide[0].description(), pageZh.guideEntryHint)
assert.equal(typeof tabType.guide[0].icon, 'function', 'the card carries its own glyph')

const queryType = tabTypes.get('dsh-ds-db-query')
assert.equal(queryType.kind, 'query', 'the query window is opened by its own kind')
assert.equal(queryType.title(), pageZh.queryTitle)
assert.deepEqual(queryType.guide.map(entry => entry.id), ['query'], 'and contributes exactly one guide card')
assert.equal(queryType.guide[0].title(), pageZh.queryTitle)
assert.equal(queryType.guide[0].description(), pageZh.queryGuideHint)
assert.equal(typeof queryType.guide[0].icon, 'function', 'the card carries its own glyph')
// A distinct guide order, so the two cards keep a stable order between loads.
assert.notEqual(queryType.guide[0].order, tabType.guide[0].order)

/** The one seat a name and a key address, now that two page types claim them. */
const seatFor = (name, key) => allSeats()
  .find(seat => seat.options.name === name && seat.options.key === key)

const body = seatFor('sidebar.right.pane.tab', 'dsh-ds-db')
assert.ok(body, 'the panel claims a right-sidebar tab body')
assert.equal(body.options.locale, 'settings.db', 'the panel resolves its copy from this plugin namespace')
const chip = seatFor('sidebar.right.pane.tab.title', 'dsh-ds-db')
assert.ok(chip, 'and a chip title seat, so an open chip follows a language switch')
const browseFace = body.options.inject()
assert.ok(browseFace.hooks?.dbBrowse, 'the inject face carries the panel source')
assert.ok(typeof browseFace.hooks.dbBrowse.getSnapshot === 'function', 'the hooks member is a bare observable source, not a value')
for (const action of ['chooseConnection', 'editFilter', 'refresh', 'toggleDatabase', 'toggleTable']) {
  assert.ok(typeof browseFace[action] === 'function', `the inject face exposes the "${action}" action`)
}
console.log(`registered: sidebar.right.pane.tab + title for the "${String(tabType.kind)}" type, one guide card`)

// The query window claims the same two seats under its own key, with the
// actions its editor and its Run control call.
const queryBody = seatFor('sidebar.right.pane.tab', 'dsh-ds-db-query')
assert.ok(queryBody, 'the query window claims a right-sidebar tab body')
assert.equal(queryBody.options.locale, 'settings.db', 'and resolves its copy from the same namespace')
assert.ok(seatFor('sidebar.right.pane.tab.title', 'dsh-ds-db-query'), 'with a chip title seat of its own')
const queryFace = queryBody.options.inject()
assert.ok(queryFace.hooks?.dbQuery, 'the inject face carries the window source')
assert.ok(typeof queryFace.hooks.dbQuery.getSnapshot === 'function', 'the hooks member is a bare observable source, not a value')
for (const action of ['chooseConnection', 'editSql', 'run', 'cancel']) {
  assert.ok(typeof queryFace[action] === 'function', `the window's inject face exposes the "${action}" action`)
}
console.log('registered: sidebar.right.pane.tab + title for the "query" type, one guide card')

// The reload property: an unload takes every registration with it. A seat that
// outlives its fiber is a duplicate contribution on the next load.
await harness.dispose()
assert.equal(seats.size, 0, 'disposing the fiber removes every slot registration')
assert.equal(dictionaries.size, 0, 'and every dictionary it registered')
assert.equal(tabTypes.size, 0, 'and the tab type the shell dispatches through')
console.log('disposal: unloading the fiber removed every registration')

// A second mount is a clean one: nothing from the first run survives into it.
const second = makeContext()
apply(second.ctx)
assert.equal(allSeats().filter(seat => seat.options.name === 'tool.call.toolview').length, TOOL_ROW_KEYS.length, 'a remount registers the rows again, once each')
await second.dispose()
assert.equal(seats.size, 0, 'and unloads cleanly again')
console.log('reload: a second mount registers once each and unloads clean')

// ---- The panel's read path -----------------------------------------------

// The page's own gestures above logged their reads too; from here the log holds
// what applying the plugin reads at boot, and then what the panel reads.
calls.length = 0

/** One saved connection, complete enough that the settings page can resolve it. */
const CONNECTION = {
  id: 'a', name: 'A', dialect: 'mysql', extra: {},
  host: '127.0.0.1', port: 3306, user: 'reader', database: '',
  passwordEnv: 'A_PASSWORD', connectTimeoutMs: 10000, queryTimeoutMs: 30000, maxRows: 200,
}

/**
 * A second saved connection, so the query window can be moved off the one in
 * use: addressing another is what drops the outcome on screen.
 */
const CONNECTION_B = { ...CONNECTION, id: 'b', name: 'B', passwordEnv: 'B_PASSWORD' }

const browsing = makeContext({ connections: [CONNECTION, CONNECTION_B], activeId: 'a' })
apply(browsing.ctx)
await settle()

const panel = seatFor('sidebar.right.pane.tab', 'dsh-ds-db').options.inject()
const snapshot = () => panel.hooks.dbBrowse.getSnapshot()

assert.equal(snapshot().connection, 'a', 'the panel opens on the connection the tools address')
// Two reads at boot: the page describes the dialects it offers, and the panel
// the databases of the connection in use — by name, on that route alone.
assert.deepEqual(calls, [
  { path: DB_DIALECTS_PATH, query: {}, method: 'GET' },
  { path: DB_DATABASES_PATH, query: { connection: 'A' }, method: 'GET' },
], 'the page describes the registered dialects, and the panel reads the connection in use by name')
assert.deepEqual(snapshot().databases, {
  status: 'ready',
  rows: [{ name: 'app', charset: 'utf8mb4', collation: 'utf8mb4_bin' }],
})
console.log('panel read: the databases of the connection in use')

panel.toggleDatabase('app')
await settle()
assert.deepEqual(calls[2], { path: DB_TABLES_PATH, query: { connection: 'A', database: 'app' }, method: 'GET' })
assert.deepEqual(snapshot().open.app.tables.rows.map(row => row.name), ['events'], 'a database reads its tables when it is opened')
panel.toggleDatabase('app')
assert.equal(snapshot().open.app.open, false, 'and collapsing keeps what it read')
console.log('panel read: tables on first open, kept through a collapse')

panel.toggleDatabase('app')
panel.toggleTable('app', 'events')
await settle()
assert.deepEqual(calls[3], { path: DB_COLUMNS_PATH, query: { connection: 'A', database: 'app', table: 'events' }, method: 'GET' })
assert.deepEqual(snapshot().open.app.openTables.events.columns.rows.map(row => row.name), ['id'])
console.log('panel read: columns on first open')

// Filtering is a view over what is already read: it issues no read of its own.
const before = calls.length
panel.editFilter('even')
assert.equal(calls.length, before, 'filtering names calls no route')
panel.editFilter('')
console.log('panel read: the filter is client-side')

// ---- The query window's state machine ------------------------------------

const queryWindow = seatFor('sidebar.right.pane.tab', 'dsh-ds-db-query').options.inject()
const window_ = () => queryWindow.hooks.dbQuery.getSnapshot()

assert.equal(window_().connection, 'a', 'the window opens on the connection the tools address')
assert.equal(window_().sql, '', 'with an empty statement')
assert.deepEqual(window_().phase, { status: 'idle' }, 'and nothing shown yet')

queryWindow.editSql('SELECT id, name FROM events')
assert.equal(window_().sql, 'SELECT id, name FROM events', 'the statement is taken exactly as typed')
assert.deepEqual(window_().phase, { status: 'idle' }, 'and typing shows no outcome of its own')

const beforeRun = calls.length
queryWindow.run()
// The run is in flight before its answer lands, which is what the window shows
// a spinner for.
assert.deepEqual(window_().phase, { status: 'running' }, 'a run shows itself in flight')
await settle()
assert.deepEqual(calls[beforeRun], {
  path: DB_QUERY_PATH,
  query: {},
  method: 'POST',
  body: { connection: 'A', sql: 'SELECT id, name FROM events' },
}, 'the run addresses the connection by name and carries the statement')
const done = window_().phase
assert.equal(done.status, 'done', 'the answer replaces the running phase')
assert.deepEqual(done.answer.columns, ['id', 'name'])
assert.deepEqual(done.answer.rows, [{ id: 1, name: 'a' }])
assert.equal(done.answer.rowCount, 1)
assert.equal(done.answer.truncated, false)
console.log(`query window: ran one statement, ${String(done.answer.rowCount)} row(s)`)

// A run the server refuses is shown as the sentence it came back with, in place
// of the rows — and it is a value, not a failed request.
queryReply = () => ({
  columns: [], rows: [], rowCount: 0, truncated: false, elapsedMs: 0,
  message: 'sql must be exactly one statement: multiple statements are refused because this plugin is read-only',
})
queryWindow.editSql('SELECT 1; DROP TABLE users')
queryWindow.run()
await settle()
assert.deepEqual(window_().phase, {
  status: 'failed',
  message: 'sql must be exactly one statement: multiple statements are refused because this plugin is read-only',
}, 'a refusal replaces the rows with its own sentence')
console.log('query window: a refused statement is shown as its sentence')

// The run in flight can be ended. The stub answers nothing and never settles,
// which is what a statement the server is still working on looks like.
queryReply = () => new Promise(() => {})
queryWindow.editSql('SELECT slow')
queryWindow.run()
await settle()
assert.deepEqual(window_().phase, { status: 'running' }, 'a held run is still in flight')
const heldSignal = querySignal
assert.equal(heldSignal.aborted, false, 'and nothing has cancelled it yet')
queryWindow.cancel()
assert.equal(heldSignal.aborted, true, 'the window cancelled the request it was waiting on')
assert.deepEqual(window_().phase, { status: 'idle' }, 'and shows nothing in its place')
console.log('query window: a run in flight was cancelled')

// Addressing another connection drops the outcome: rows read from one server
// must not stay on screen under another one's name.
queryReply = () => ({ columns: ['id'], rows: [{ id: 1 }], rowCount: 1, truncated: false, elapsedMs: 1 })
queryWindow.editSql('SELECT id FROM events')
queryWindow.run()
await settle()
assert.equal(window_().phase.status, 'done', 'the statement answered')
queryWindow.chooseConnection('a')
assert.equal(window_().phase.status, 'done', 're-picking the connection already addressed keeps the rows')
queryWindow.chooseConnection('b')
assert.equal(window_().connection, 'b', 'the window moved to the other connection')
assert.deepEqual(window_().phase, { status: 'idle' }, 'and dropped the outcome it was showing')
queryWindow.run()
await settle()
assert.deepEqual(calls[calls.length - 1].body, { connection: 'B', sql: 'SELECT id FROM events' }, 'the next run addresses the connection now chosen')
console.log('query window: addressing another connection drops the previous outcome')

await browsing.dispose()
assert.equal(seats.size, 0, 'and the browsing mount unloads clean too')

console.log('client check passed')
