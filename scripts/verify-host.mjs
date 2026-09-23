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
function standInDialect(label, version) {
  /** Sessions opened and closed by this stand-in, so a check can tell reuse from reopen. */
  const state = { opens: 0, closes: 0 }
  const query = (sql, project) => ({ statement: { sql, values: [] }, project })
  const rowsFor = (sql) => {
    if (sql.includes('pg_database')) return [{ name: 'app' }]
    if (sql.includes('pg_tables')) return [{ name: 'events', type: 'BASE TABLE' }]
    if (sql.includes('information_schema.columns')) return [{ name: 'id' }]
    if (sql.includes('version')) return [{ version }]
    return []
  }
  return {
    name: 'postgres',
    label,
    rules: MYSQL_DIALECT.rules,
    // Every ability but `createStatement`: this server has no way to render
    // one, and the seam says so instead of returning a guess.
    capabilities: new Set(['databases', 'tables', 'columns', 'indexes', 'estimatedRows', 'charset', 'version']),
    configFields: [{ key: 'serviceName', kind: 'text', default: 'ORCL', required: true, label: 'Service name' }],
    rowBoundHint: 'FETCH FIRST',
    systemDatabases: [],
    // Counted so a check can tell a reused session from a reopened one, and a
    // closed session from one merely forgotten.
    state,
    async open() {
      state.opens += 1
      return {
        async run(statement) {
          // A stand-in that honours the signal proves the tools forward it: if
          // they did not, a cancelled call would run to completion instead.
          if (statement.signal?.aborted === true) throw new Error('the call was cancelled')
          // A statement the checks hold open, so a cancellation can arrive while
          // it is in flight rather than before it starts — the two take
          // different paths through the runner.
          if (statement.sql.includes('slow')) {
            await new Promise((resolve, reject) => {
              const timer = setTimeout(resolve, 5000)
              statement.signal?.addEventListener('abort', () => {
                clearTimeout(timer)
                reject(new Error('the call was cancelled in flight'))
              }, { once: true })
            })
          }
          seen.sql = statement.sql
          return { rows: rowsFor(statement.sql), columns: [] }
        },
        async close() { state.closes += 1 },
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
  }
}

// A dialect that arrives after this plugin — the shape a separately packaged
// dialect has, since the registry is provided here — runs every call after it.
const postgres = standInDialect('PostgreSQL', '16.3')
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
const pending = second.tools.get('db_query').execute({ sql: 'SELECT slow' }, { signal: inFlight.signal })
await new Promise(resolve => setTimeout(resolve, 20))
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