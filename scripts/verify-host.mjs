/**
 * Host-half check: mount the plugin on a real Cordis context with the real tool
 * registry, and assert what the model would see plus the behaviour the seam has
 * to preserve.
 *
 * Run it from this plugin's directory; `tsconfig.json` points `@deepseek-ai/*`
 * at the harness checkout beside it, and tsx resolves those paths from the
 * working directory.
 *
 *   npm run verify:host
 */
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools/src/json-schema.ts'
import * as mysqlReadOnly from '../src/index.ts'
import { dialectCatalog } from '../src/index.ts'
import { DatabaseAccess } from '../src/connection.ts'
import * as mysqlDialect from '../dialects/mysql/src/index.ts'
import { MYSQL_DIALECT } from '../dialects/mysql/src/index.ts'

const TOOL_NAMES = ['db_databases', 'db_tables', 'db_describe', 'db_query']

/**
 * The caller context the host builds for one tool call.
 *
 * Every tool reads `exec.signal`, so a call without it is not a call the host
 * would ever make; a never-aborted signal is the faithful stand-in.
 */
const CALL = { signal: new AbortController().signal }

/**
 * Assert one tool's result satisfies the output schema it declares.
 *
 * A real call validates this in the host, so a mismatch between a schema and
 * what a tool returns is a failure only a running deployment would show. This
 * check moves that failure here, where the tool that caused it is named.
 */
function assertOutput(ctx, name, value) {
  const tool = ctx.tools.get(name)
  assert.ok(tool, `${name} is registered`)
  const violations = validateJsonSchemaValue(tool.output.schema, value, 'value')
  assert.deepEqual(violations, [], `${name} returns what its output schema declares`)
}

/** Bytes one card's metadata may take once serialized into the session log. */
const CARD_META_BYTES = 32 * 1024

/**
 * Assert one tool's card metadata is shaped the way the client reads it.
 *
 * The client re-checks every field before drawing, because a replayed session can
 * carry metadata an older version wrote; this is that contract seen from the side
 * that writes it.
 * @param ctx - the context holding the tool.
 * @param name - the tool whose metadata is checked.
 * @param args - the validated arguments of the call it describes.
 * @param value - the canonical value that call returned.
 * @param card - the discriminating value the metadata must carry.
 * @returns the metadata, so a check can read further fields off it.
 */
function assertMeta(ctx, name, args, value, card) {
  const tool = ctx.tools.get(name)
  assert.ok(tool, `${name} is registered`)
  assert.equal(typeof tool.output.presentationMeta, 'function', `${name} declares presentation metadata`)
  const meta = tool.output.presentationMeta(args, value)
  assert.equal(typeof meta, 'object', `${name}'s metadata is an object`)
  assert.equal(Array.isArray(meta), false, `${name}'s metadata is not an array`)
  assert.equal(meta.card, card, `${name}'s metadata carries card=${card}`)
  assert.equal(typeof meta.truncated, 'boolean', `${name}'s metadata says whether it was cut`)
  if (card === 'table') {
    assert.ok(Array.isArray(meta.columns), `${name}'s metadata lists columns`)
    assert.ok(meta.columns.every(column => typeof column === 'string'), `${name}'s columns are names`)
    assert.ok(Array.isArray(meta.rows), `${name}'s metadata carries rows`)
    assert.ok(meta.rows.every(row => Array.isArray(row) && row.length === meta.columns.length),
      `${name}'s rows match its columns`)
    assert.ok(meta.rows.every(row => row.every(cell => cell === null
      || typeof cell === 'string' || typeof cell === 'number' || typeof cell === 'boolean')),
    `${name}'s cells are scalars a column can draw`)
    assert.ok(Number.isInteger(meta.rowCount), `${name}'s metadata carries a row count`)
  } else {
    assert.ok(Array.isArray(meta.items), `${name}'s metadata carries items`)
    assert.ok(meta.items.every(item => typeof item.name === 'string'), `${name}'s items are named`)
    assert.ok(meta.items.every(item => item.detail === undefined || typeof item.detail === 'string'),
      `${name}'s item details are text`)
    assert.ok(Number.isInteger(meta.total), `${name}'s metadata carries a total`)
  }
  assert.ok(JSON.stringify(meta).length <= CARD_META_BYTES, `${name}'s metadata stays within its bound`)
  return meta
}

/**
 * The descriptions this plugin shipped before the dialect seam existed. The
 * seam composes them from the dialect now, so these exact strings are what
 * proves that composition did not change what the model reads.
 */
const SHIPPED_DESCRIPTIONS = {
  db_databases: "List the MySQL databases this connection can see, with each one's default character set and collation.",
  db_tables: 'List the tables and views of one MySQL database, with engine, row-count estimate, and table comment.',
  db_describe: 'Describe one MySQL table: its columns, its indexes, and the statement that creates it.',
  db_query: "Run one read-only MySQL statement and return its rows as JSON. "
    + 'Only SELECT, SHOW, DESCRIBE, EXPLAIN, TABLE, and VALUES are accepted; a single statement per call. '
    + "Results are cut at the deployment's row cap, so ask for the rows you need with WHERE, ORDER BY, and LIMIT.",
}

/** A port nothing listens on: every connection attempt fails fast. */
const UNREACHABLE = { host: '127.0.0.1', port: 1, user: 'nobody', database: '' }

/**
 * Mount a context with the tool registry, the dialect package, and the plugin.
 *
 * The dialect is mounted as a plugin of its own, in the order the bundle patch
 * uses: it waits for the registry the plugin provides, and the plugin registers
 * its tools once the dialect is registered. Nothing here reads MySQL from the
 * plugin's own source, because the plugin no longer contains any database type.
 */
async function mount(config) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime, { mode: 'native', maxParallelSubCalls: 1 })
  await ctx.plugin(mysqlDialect, {})
  await ctx.plugin(mysqlReadOnly, config)
  // The tools appear when the dialect registers; that activation is a fiber
  // transition, so the check waits for the observable it asserts on.
  for (let attempt = 0; attempt < 100 && ctx.tools.get('db_query') === undefined; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  return ctx
}

const ctx = await mount(UNREACHABLE)

for (const name of TOOL_NAMES) {
  const definition = ctx.tools.get(name)
  assert.ok(definition, `${name} is registered`)
  assert.equal(definition.description, SHIPPED_DESCRIPTIONS[name], `${name} keeps the description it shipped with`)
}
console.log(`registered tools: ${TOOL_NAMES.join(', ')}`)
console.log('descriptions: unchanged from the pre-seam strings')

// The dialect-derived parameter text has to keep saying what it said before.
assert.equal(
  ctx.tools.get('db_databases').parameters.properties.include_system.description,
  "Include the server's own schemas (information_schema, mysql, performance_schema, sys). Defaults to false.",
)
assert.equal(
  ctx.tools.get('db_tables').parameters.properties.database.description,
  'Database to list. Defaults to the default database of the connection in use.',
)
console.log('dialect-derived parameter text: unchanged')

// The plugin provides the registry; the dialect package mounted above fills it.
assert.deepEqual(ctx.databaseDialects.names(), ['mysql'])
assert.equal(ctx.databaseDialects.get('mysql'), MYSQL_DIALECT)
console.log(`dialect registry: ${ctx.databaseDialects.names().join(', ')}`)

const query = ctx.tools.get('db_query')
const write = await query.execute({ sql: 'DROP TABLE users' }, CALL).then(() => undefined, error => error)
assert.ok(write instanceof Error, 'a write statement is refused')
assert.match(write.message, /read-only/)
console.log(`write refusal: ${write.message}`)

const tables = ctx.tools.get('db_tables')
const noDatabase = await tables.execute({}, CALL).then(() => undefined, error => error)
assert.ok(noDatabase instanceof Error, 'no default database is an actionable refusal')
assert.match(noDatabase.message, /no database selected/)
console.log(`database refusal: ${noDatabase.message}`)

const reach = await tables.execute({ database: 'app' }, CALL).then(() => undefined, error => error)
assert.ok(reach instanceof Error, 'an unreachable server fails the call')
// The refusal names the connection it used, so a model can act on it.
assert.match(reach.message, /MySQL statement on nobody@127\.0\.0\.1:1 failed: connect ECONNREFUSED/)
console.log(`connection refusal: ${reach.message}`)

// A dialect name nothing registers is reported by the call that needs it, with
// what is registered, rather than by a load that cannot know about later layers.
const second = await mount({ ...UNREACHABLE, dialect: 'postgres' })
assert.deepEqual(second.databaseDialects.names(), ['mysql'], 'the mounted dialect package is still registered')
const unresolved = await second.tools.get('db_tables').execute({ database: 'app' }, CALL)
  .then(() => undefined, error => error)
assert.ok(unresolved instanceof Error, 'an unregistered dialect fails the call')
assert.match(unresolved.message, /database dialect "postgres" is not registered; registered dialects: mysql/)
console.log(`dialect refusal: ${unresolved.message}`)

/** The last statement the stand-in dialect was asked to run. */
const seen = { sql: '' }

/**
 * A stand-in second dialect: enough of the seam to prove another server runs
 * through the same tools, and nothing of a real driver. Its row bound is spelled
 * the way a different server spells it, which is what makes the assertions
 * below discriminate this dialect from MySQL's.
 */
function standInDialect(label, version, name = 'postgres') {
  /**
   * What the checks watch: sessions opened and closed, so a check can tell reuse
   * from reopen; deaths, so one check can make a session die exactly once; and
   * switches that hold a statement or a close open long enough to be interrupted
   * or waited for.
   */
  const state = {
    opens: 0, closes: 0, deaths: 0,
    holdVersion: false, holdClose: false, closeFinished: false,
  }
  /**
   * One deferred per kind of held statement. A check registers interest before
   * starting the call and awaits it, so it knows the statement is running
   * instead of sleeping and hoping the timing came out right.
   *
   * Single-slot per kind: watching a kind twice before the first arrives replaces
   * the first watcher. That is enough for these checks, not a general signal.
   */
  const watchers = new Map()
  const watch = (kind) => {
    const { promise, resolve } = Promise.withResolvers()
    watchers.set(kind, resolve)
    return promise
  }
  const arrive = (kind) => {
    watchers.get(kind)?.()
    watchers.delete(kind)
  }
  const query = (sql, project) => ({ statement: { sql, values: [] }, project })
  const rowsFor = (sql) => {
    if (sql.includes('pg_database')) return [{ name: 'app' }]
    if (sql.includes('pg_tables')) return [{ name: 'events', type: 'BASE TABLE' }]
    if (sql.includes('information_schema.columns')) return [{ name: 'id' }]
    if (sql.includes('version')) return [{ version }]
    return []
  }
  return {
    name,
    label,
    rules: MYSQL_DIALECT.rules,
    // Every ability but `createStatement`: this server has no way to render
    // one, and the seam says so instead of returning a guess.
    capabilities: new Set(['databases', 'tables', 'columns', 'indexes', 'estimatedRows', 'charset', 'version', 'sample', 'explain']),
    configFields: [{ key: 'serviceName', kind: 'text', default: 'ORCL', required: true, label: 'Service name' }],
    rowBoundHint: 'FETCH FIRST',
    systemDatabases: [],
    // Counted so a check can tell a reused session from a reopened one, and a
    // closed session from one merely forgotten.
    state,
    watch,
    async open() {
      state.opens += 1
      // Per session: one that retired itself is unusable even though the call it
      // was running came back with rows.
      let retired = false
      return {
        async run(statement) {
          // A stand-in that honours the signal proves the tools forward it: if
          // they did not, a cancelled call would run to completion instead.
          if (statement.signal?.aborted === true) throw new Error('the call was cancelled')

          if (statement.sql.includes('unstable')) {
            // MySQL's failure path: the cancellation retires the session *and*
            // fails the call, so both the "cancelled" and the "unusable" rules
            // point at it — the shape that decides whether a retry happens.
            const held = new Promise((resolve, reject) => {
              const timer = setTimeout(resolve, 5000)
              statement.signal?.addEventListener('abort', () => {
                clearTimeout(timer)
                retired = true
                reject(new Error('the call was cancelled and the session retired'))
              }, { once: true })
            })
            arrive('unstable')
            await held
          }

          if (state.holdVersion && statement.sql.includes('version')) {
            // Held so a probe can be cancelled while it waits for the version.
            const held = new Promise((resolve, reject) => {
              const timer = setTimeout(resolve, 5000)
              statement.signal?.addEventListener('abort', () => {
                clearTimeout(timer)
                reject(new Error('the probe was cancelled'))
              }, { once: true })
            })
            arrive('probe')
            await held
          }

          if (statement.sql.includes('slow')) {
            // Cancellation fails the call, the way a driver that can interrupt
            // does. Held open so the cancellation arrives in flight.
            const held = new Promise((resolve, reject) => {
              // A backstop, so a check that forgets to cancel fails an assertion
              // instead of hanging the command.
              const timer = setTimeout(resolve, 5000)
              statement.signal?.addEventListener('abort', () => {
                clearTimeout(timer)
                reject(new Error('the call was cancelled in flight'))
              }, { once: true })
            })
            arrive('slow')
            await held
          }

          if (statement.sql.includes('late')) {
            // Cancellation lets the statement finish, the way MySQL does: ending
            // its pool queues a COM_QUIT behind the running statement instead of
            // interrupting it, so the call returns rows and the session is gone.
            const held = new Promise((resolve) => {
              const timer = setTimeout(resolve, 5000)
              statement.signal?.addEventListener('abort', () => {
                clearTimeout(timer)
                resolve()
              }, { once: true })
            })
            arrive('late')
            await held
            retired = true
          }

          // Dies exactly once, so the retry the runner performs has a healthy
          // session to land on — a driver's pool closed outside this plugin.
          if (statement.sql.includes('dead') && state.deaths === 0) {
            state.deaths += 1
            retired = true
            throw new Error('the session is no longer usable')
          }

          seen.sql = statement.sql
          return { rows: rowsFor(statement.sql), columns: [] }
        },
        // A session that retired itself says so, which is what lets the runner
        // evict it rather than failing every call until the plugin reloads.
        usable: () => !retired,
        async close() {
          if (state.holdClose) {
            // Held, so a check can assert that `dispose` waited for it.
            await new Promise(resolve => setTimeout(resolve, 25))
            state.closeFinished = true
          }
          state.closes += 1
        },
      }
    },
    applyRowLimit: (sql, maxRows) => `${sql}\nFETCH FIRST ${maxRows + 1} ROWS ONLY`,
    quoteIdentifier: name => `"${name}"`,
    databases: () => query('SELECT datname AS name FROM pg_database', row => ({
      name: String(row.name), charset: '', collation: '',
    })),
    tables: () => query('SELECT tablename AS name, \'BASE TABLE\' AS type FROM pg_tables', row => ({
      name: String(row.name), type: String(row.type), engine: null, estimatedRows: null, comment: '',
    })),
    // The projections have to be real: the plugin's own output schema validates
    // what a tool returns, so a dialect that reports half-shaped rows fails the
    // call in a deployment, not here.
    columns: () => query('SELECT * FROM information_schema.columns', () => ({
      name: 'id', type: 'integer', nullable: false, default: null, key: '', extra: '', comment: '',
    })),
    indexes: () => query('SELECT * FROM pg_indexes', () => ({
      name: 'events_pkey', unique: true, type: 'BTREE', columnName: 'id',
    })),
    createStatement: () => query('SELECT pg_get_tabledef()', () => ''),
    version: () => query('SELECT version() AS version', row => String(row.version ?? '')),
    // The two optional abilities, so the tools that only exist for a dialect
    // declaring them have an output a check can validate.
    sample: (database, table, rows) => query(`SELECT * FROM "${database}"."${table}" LIMIT ${rows}`, row => row),
    explain: (sql) => query(`EXPLAIN ${sql}`, row => JSON.stringify(row)),
  }
}

// A dialect that arrives after this plugin — the shape a separately packaged
// dialect has, since the registry is provided here — runs every call after it.
const postgres = standInDialect('PostgreSQL', '16.3')

/**
 * A DatabaseAccess of its own, so the checks addressing `probe` and `dispose`
 * directly do not disturb the sessions the tool calls above are using.
 * @param dialect - the dialect its sessions open through.
 * @returns the access, with a face that resolves the profile straight through.
 */
function ownAccess(dialect) {
  return new DatabaseAccess({
    connection: async profile => ({
      host: profile.host,
      port: profile.port,
      user: profile.user,
      password: 'not-a-real-password',
      database: profile.database,
      extra: profile.extra,
      connectTimeoutMs: profile.connectTimeoutMs,
      queryTimeoutMs: profile.queryTimeoutMs,
      maxRows: profile.maxRows,
    }),
    dialect: () => dialect,
    warn: () => {},
  })
}
const dispose = second.databaseDialects.register(postgres)
const listed = await second.tools.get('db_tables').execute({ database: 'app' }, CALL)
assert.deepEqual(listed, {
  database: 'app',
  tables: [{ name: 'events', type: 'BASE TABLE', engine: null, estimatedRows: null, comment: '' }],
})
assertOutput(second, 'db_tables', listed)
console.log(`second dialect ran the tools: ${JSON.stringify(listed)}`)

// Its own statement, projection, and syntax win over the ones this plugin was
// registered with: the bound below is spelled the second dialect's way.
const databases = await second.tools.get('db_databases').execute({}, CALL)
assert.deepEqual(databases, { databases: [{ name: 'app', charset: '', collation: '' }] })
assertOutput(second, 'db_databases', databases)
const bounded = await second.tools.get('db_query').execute({ sql: 'SELECT 1' }, CALL)
assert.match(seen.sql, /FETCH FIRST 201 ROWS ONLY/, 'the second dialect bounded the statement')
assert.equal(bounded.rowCount, 0)
assertOutput(second, 'db_query', bounded)
console.log(`second dialect bounded a query: ${JSON.stringify(seen.sql)}`)

// The call's cancellation reaches the dialect, so a long statement ends with
// the caller's signal rather than running out its timeout.
const cancelled = new AbortController()
cancelled.abort()
const aborted = await second.tools.get('db_query')
  .execute({ sql: 'SELECT 1' }, { signal: cancelled.signal })
  .then(() => undefined, error => error)
assert.ok(aborted instanceof Error, 'a cancelled call fails instead of running')
assert.match(aborted.message, /cancelled/)
console.log(`cancellation: ${aborted.message}`)

// Cancelling a call that is already in flight takes the other path: the session
// may survive the cancellation — a driver that honours the signal leaves its
// connection usable — so it has to be closed, not merely dropped. A dropped
// session sits in no cache and `dispose` no longer sees it, which is a pool
// leaked for the life of the process.
const closesBefore = postgres.state.closes
const inFlight = new AbortController()
const slowRunning = postgres.watch('slow')
const pending = second.tools.get('db_query').execute({ sql: 'SELECT slow' }, { signal: inFlight.signal })
// Waits for the statement to be running rather than sleeping: on a slow machine
// the cancellation would otherwise arrive before the call started, and the check
// would be measuring a different path than the one it claims to.
await slowRunning
inFlight.abort()
const cancelledInFlight = await pending.then(() => undefined, error => error)
assert.ok(cancelledInFlight instanceof Error, 'a call cancelled in flight fails')
assert.match(cancelledInFlight.message, /cancelled in flight/)
assert.equal(postgres.state.closes, closesBefore + 1, 'the cancelled session was closed, not only forgotten')

// And the next call opens a fresh session rather than reusing the cancelled one:
// the cancelled session was dropped from the cache as well as closed.
const opensAfterCancel = postgres.state.opens
const afterCancel = await second.tools.get('db_query').execute({ sql: 'SELECT 1' }, CALL)
assert.equal(postgres.state.opens, opensAfterCancel + 1, 'the next call opened a new session')
assertOutput(second, 'db_query', afterCancel)
console.log(`cancellation in flight: session closed, next call reopened (${String(postgres.state.opens)} opens)`)

// A cancellation that also retires the session is where the two rules meet, and
// it must not be retried: the first failure is the one that names the connection,
// and a retry would open another session for a call the caller already gave up
// on and report a "cancelled before it ran" in place of the real reason.
const unstable = new AbortController()
const unstableRunning = postgres.watch('unstable')
const unstableCall = second.tools.get('db_query').execute({ sql: 'SELECT unstable' }, { signal: unstable.signal })
await unstableRunning
unstable.abort()
const unstableError = await unstableCall.then(() => undefined, error => error)
assert.ok(unstableError instanceof Error, 'a cancelled call fails')
assert.match(unstableError.message, /the call was cancelled and the session retired/, 'the first failure is the one reported')
assert.match(unstableError.message, /nobody@127\.0\.0\.1:1/, 'and it names the connection it happened on')
const opensBeforeUnstable = postgres.state.opens
await second.tools.get('db_query').execute({ sql: 'SELECT 1' }, CALL)
assert.equal(postgres.state.opens, opensBeforeUnstable + 1, 'the cancellation was not retried')
console.log('cancellation with a retired session: one failure, no retry')

// The cancellation MySQL really performs: the pool is ended to interrupt, which
// queues a COM_QUIT behind the statement already running, so that statement
// finishes and the call returns rows — and the session is gone anyway. The
// success path has to evict it too, or every later call on that connection keeps
// failing with the driver's own "pool is closed" and nothing pointing at why.
const late = new AbortController()
const lateRunning = postgres.watch('late')
const lateCall = second.tools.get('db_query').execute({ sql: 'SELECT late' }, { signal: late.signal })
await lateRunning
late.abort()
const lateRows = await lateCall
assertOutput(second, 'db_query', lateRows)
const opensAfterLate = postgres.state.opens
await second.tools.get('db_query').execute({ sql: 'SELECT 1' }, CALL)
assert.equal(postgres.state.opens, opensAfterLate + 1, 'the retired session was replaced, not kept')
console.log('cancellation that cannot interrupt: the retired session was replaced')

// A session that dies without a cancellation — a pool closed outside this plugin
// — would otherwise fail that call with the driver's own "pool is closed", which
// tells a model nothing it can act on. Every statement reaching the runner has
// passed the read-only rules, so it is retried once on a fresh session and the
// model never sees the failure.
const opensBeforeDead = postgres.state.opens
const deathsBefore = postgres.state.deaths
const recovered = await second.tools.get('db_query').execute({ sql: 'SELECT dead' }, CALL)
assertOutput(second, 'db_query', recovered)
assert.equal(postgres.state.deaths, deathsBefore + 1, 'the dead session was reached once')
assert.equal(postgres.state.opens, opensBeforeDead + 1, 'the retry opened a fresh session')
console.log('dead session: the read-only call was retried and succeeded')

// Every tool's output has to satisfy the schema it declares, not only the four
// the description checks cover. `db_connections` is the one whose schema broke
// before, and the two optional tools exist only because the dialect in force
// declares the ability, so nothing else exercises their schemas.
const connections = await second.tools.get('db_connections').execute({}, CALL)
assertOutput(second, 'db_connections', connections)

// `db_sample` and `db_explain` exist only for a dialect declaring the ability, and
// the tools are described from the dialect the *active connection* names — so an
// instance whose active connection names a dialect nothing registers has neither
// tool, by design (`second` above is exactly that). An instance whose only dialect
// is the stand-in is the shape a deployment with one third-party dialect has, and
// there both tools are registered and can answer.
const solo = new Context()
await solo.plugin(SystemPrompt, {})
await solo.plugin(ToolRuntime, { mode: 'native', maxParallelSubCalls: 1 })
await solo.plugin(mysqlReadOnly, {
  // Long enough that registering the dialect below is what wakes the wait, not
  // the fallback timer: the check then depends on an event, not on timing.
  dialectWaitMs: 5000,
  connections: [{
    id: 'lite', name: 'Lite', dialect: 'lite', extra: {},
    host: '127.0.0.1', port: 1, user: 'nobody', database: 'app',
    passwordEnv: 'LITE_PASSWORD', connectTimeoutMs: 1000, queryTimeoutMs: 1000, maxRows: 200,
  }],
})
// Registering it wakes the plugin's wait, so the tools are described from the
// dialect that is really there instead of the refusing stand-in.
const disposeLite = solo.databaseDialects.register(standInDialect('Lite', '1.0', 'lite'))
for (let attempt = 0; attempt < 100 && solo.tools.get('db_query') === undefined; attempt++) {
  await new Promise(resolve => setTimeout(resolve, 10))
}
assert.ok(solo.tools.get('db_sample'), 'a dialect declaring sample registers the tool')
const sample = await solo.tools.get('db_sample').execute({ database: 'app', table: 'events', rows: 2 }, CALL)
assertOutput(solo, 'db_sample', sample)
const plan = await solo.tools.get('db_explain').execute({ sql: 'SELECT 1' }, CALL)
assertOutput(solo, 'db_explain', plan)
const sampleMeta = assertMeta(solo, 'db_sample', { database: 'app', table: 'events', rows: 2 }, sample, 'table')
assert.equal(sampleMeta.database, 'app', 'a sample card names the database it read')
assert.equal(sampleMeta.table, 'events', 'a sample card names the table it read')
console.log('output schemas: db_connections, db_sample, db_explain all satisfied')

// The card metadata is what the Web client draws in place of the generic row. It
// is written into the session log, so both every field's type and the whole
// thing's size are contract here, not presentation taste.
const queryMeta = assertMeta(second, 'db_query', { sql: 'SELECT 1' }, bounded, 'table')
const databasesMeta = assertMeta(second, 'db_databases', {}, databases, 'list')
const tablesMeta = assertMeta(second, 'db_tables', { database: 'app' }, listed, 'list')
assert.deepEqual(databasesMeta.items, [{ name: 'app' }], 'a database with no charset carries no detail')
assert.equal(tablesMeta.items[0].detail.includes('BASE TABLE'), true, 'a table detail says what the item is')
assert.equal(tablesMeta.database, 'app', 'a table card names the database it listed')

// A card past its bounds says so and stays within them: an unbounded one is a
// session log that grows with every row a query happened to return.
const many = {
  columns: ['id', 'name'],
  rows: Array.from({ length: 500 }, (_, index) => ({ id: index, name: `row-${String(index)}` })),
  rowCount: 500,
  truncated: false,
  elapsedMs: 3,
}
const manyMeta = assertMeta(second, 'db_query', { sql: 'SELECT id, name' }, many, 'table')
assert.equal(manyMeta.truncated, true, 'a card past the row bound says it was cut')
assert.equal(manyMeta.rows.length, 50, 'a card carries at most the row bound')
assert.equal(manyMeta.rowCount, 500, 'the count still reports what the server answered')

// Wide cells reach the byte bound before the row bound does.
const huge = {
  columns: ['blob'],
  rows: Array.from({ length: 500 }, () => ({ blob: 'x'.repeat(4096) })),
  rowCount: 500,
  truncated: false,
  elapsedMs: 1,
}
const hugeMeta = assertMeta(second, 'db_query', { sql: 'SELECT blob' }, huge, 'table')
assert.equal(hugeMeta.truncated, true, 'a card past the byte bound says it was cut')
assert.equal(hugeMeta.rows.length < 50, true, 'the byte bound cut it before the row bound did')
console.log(`cards: db_query ${String(queryMeta.columns.length)} columns, db_tables ${String(tablesMeta.items.length)} items, bounds hold`)
await solo.fiber.dispose()
disposeLite()

// The probe route hands the request's signal down to the version query, so a page
// that navigated away stops waiting instead of holding a session to its timeout.
const probeProfile = {
  id: 'probe', name: 'Probe', dialect: 'postgres', extra: {},
  host: '127.0.0.1', port: 1, user: 'nobody', database: '',
  passwordEnv: 'PROBE_PASSWORD', connectTimeoutMs: 1000, queryTimeoutMs: 1000, maxRows: 200,
}
const probeAccess = ownAccess(postgres)
postgres.state.holdVersion = true
const probeCancel = new AbortController()
const probeRunning = postgres.watch('probe')
const probing = probeAccess.probe(probeProfile, probeCancel.signal)
await probeRunning
probeCancel.abort()
const cancelledProbe = await probing.then(() => undefined, error => error)
assert.ok(cancelledProbe instanceof Error, 'a cancelled probe fails instead of waiting out its timeout')
assert.match(cancelledProbe.message, /the probe was cancelled/)
postgres.state.holdVersion = false
const opensBeforeProbe = postgres.state.opens
const probed = await probeAccess.probe(probeProfile, CALL.signal)
assert.equal(probed.version, '16.3', 'the next probe answered a version')
assert.equal(postgres.state.opens, opensBeforeProbe + 1, 'the cancelled probe session was evicted')
console.log('probe cancellation: session evicted, the next probe opened one')

// `dispose` waits for a session a cancellation already dropped: it left the
// cache, but the process must not let go while its pool is still closing.
postgres.state.holdClose = true
postgres.state.closeFinished = false
const disposeAccess = ownAccess(postgres)
const disposeCancel = new AbortController()
const disposeRunning = postgres.watch('slow')
const heldCall = disposeAccess.query(probeProfile, 'SELECT slow', [], disposeCancel.signal)
await disposeRunning
disposeCancel.abort()
await heldCall.then(() => undefined, () => undefined)
await disposeAccess.dispose()
assert.equal(postgres.state.closeFinished, true, 'dispose waited for the dropped session to close')
postgres.state.holdClose = false
console.log('dispose: waited for a session a cancellation had dropped')

// A dialect that cannot produce a create statement omits the field: the seam
// degrades instead of running a statement the server does not have.
const described = await second.tools.get('db_describe').execute({ database: 'app', table: 'events' }, CALL)
assert.equal(described.createStatement, undefined, 'a dialect without createStatement omits it')
assert.equal(described.table, 'events')
assertOutput(second, 'db_describe', described)
console.log('capability degradation: db_describe omitted createStatement')

// The page's type chooser reads the registered dialects plus what a deployment
// could install, so a dialect package shows up without being known in advance.
const catalog = dialectCatalog(second.databaseDialects)
assert.deepEqual(catalog.installed.map(entry => entry.name), ['mysql', 'postgres'])
assert.deepEqual(catalog.installed.find(entry => entry.name === 'postgres').configFields.map(field => field.key), ['serviceName'])
// `postgres` is registered above, so it is no longer offered as installable:
// the known list is what this deployment is missing, not a static catalog.
assert.deepEqual(catalog.known.map(entry => entry.name), ['oracle'])

// The port and the account are the dialect's own declarations: the plugin
// names no database type, so it cannot carry a default for either.
const mysqlEntry = catalog.installed.find(entry => entry.name === 'mysql')
assert.equal(mysqlEntry.connectionDefaults.port, 3306, 'the dialect names its own port')
assert.equal(mysqlEntry.connectionDefaults.user, 'root', 'the dialect names its own account')
assert.equal(typeof mysqlEntry.description, 'string', 'the dialect describes itself')
console.log(`dialect catalog: installed ${catalog.installed.map(entry => entry.name).join(', ')}`)

// Registration is an effect: disposing it takes the dialect away again.
dispose()
const gone = await second.tools.get('db_tables').execute({ database: 'app' }, CALL)
  .then(() => undefined, error => error)
assert.match(gone.message, /database dialect "postgres" is not registered/)
console.log('dialect disposal: the registered dialect is gone again')

// With several saved connections, `activeId` picks the one the tools address:
// the refusal names the connection it used, so it discriminates the pick.
const third = await mount({
  connections: [
    { id: 'a', name: 'A', dialect: 'mysql', host: '10.0.0.1', port: 1, user: 'a', database: '', passwordEnv: 'A_PASSWORD', connectTimeoutMs: 10000, queryTimeoutMs: 30000, maxRows: 200 },
    { id: 'b', name: 'B', dialect: 'mysql', host: '10.0.0.2', port: 1, user: 'b', database: '', passwordEnv: 'B_PASSWORD', connectTimeoutMs: 10000, queryTimeoutMs: 30000, maxRows: 200 },
  ],
  activeId: 'b',
})
const picked = await third.tools.get('db_tables').execute({ database: 'app' }, CALL)
  .then(() => undefined, error => error)
assert.ok(picked instanceof Error, 'the active connection is what the call reaches')
assert.match(picked.message, /b@10\.0\.0\.2:1/, 'the tools addressed the active connection, not the first')
console.log('active connection: the tools addressed b@10.0.0.2:1')

// A call may address any saved connection by name, not only the default one.
const byName = await third.tools.get('db_tables').execute({ database: 'app', connection: 'A' }, CALL)
  .then(() => undefined, error => error)
assert.match(byName.message, /a@10\.0\.0\.1:1/, 'naming a connection addressed that one')
console.log(`named connection: ${byName.message}`)

// A name nothing carries is refused, and the refusal lists what is saved.
const unknown = await third.tools.get('db_tables').execute({ database: 'app', connection: 'nope' }, CALL)
  .then(() => undefined, error => error)
assert.match(unknown.message, /no saved connection is named "nope"; saved connections: A, B/)
console.log(`unknown connection: ${unknown.message}`)

// The listing is how a model discovers the names it can address.
const savedConnections = await third.tools.get('db_connections').execute({}, CALL)
assert.deepEqual(savedConnections.connections.map(connection => connection.name), ['A', 'B'])
assert.equal(savedConnections.active, 'B', 'the listing names the default connection')
// A listing a model reads carries no credential reference, only where it reaches.
assert.deepEqual(
  Object.keys(savedConnections.connections[0]).sort(),
  ['active', 'database', 'dialect', 'host', 'id', 'name', 'port'],
)
assertOutput(third, 'db_connections', savedConnections)
console.log(`connections: ${savedConnections.active} is the default of ${savedConnections.connections.length}`)

// A composition layer that names no port leaves it to the dialect, and the
// listing reports the port the connection really reaches rather than the 0 the
// document carries.
const unsetPort = await mount({ host: '127.0.0.1', user: 'nobody', database: '' })
const listedUnset = await unsetPort.tools.get('db_connections').execute({}, CALL)
assertOutput(unsetPort, 'db_connections', listedUnset)
assert.equal(listedUnset.connections[0].port, 3306, 'an unset port reports the dialect default')
assert.equal(listedUnset.connections[0].host, '127.0.0.1')
console.log(`unset port: reported as ${String(listedUnset.connections[0].port)}`)
await unsetPort.fiber.dispose()

// An undeclared capability is refused at registration, not silently accepted.
assert.throws(
  () => third.databaseDialects.register({ ...MYSQL_DIALECT, name: 'bogus', capabilities: new Set(['teleport']) }),
  /declares unknown capability "teleport"/,
)
console.log('capability check: an unknown capability is refused at registration')

// Unload through the framework, so the session's disposers run.
await ctx.fiber.dispose()
await second.fiber.dispose()
await third.fiber.dispose()
console.log('host check passed')