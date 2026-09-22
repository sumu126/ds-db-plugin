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
import * as mysqlReadOnly from '../src/index.ts'
import { MYSQL_DIALECT } from '../src/dialect-mysql.ts'

const TOOL_NAMES = ['db_databases', 'db_tables', 'db_describe', 'db_query']

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

/** Mount a context with the tool registry and this plugin. */
async function mount(config) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime, { mode: 'native', maxParallelSubCalls: 1 })
  await ctx.plugin(mysqlReadOnly, config)
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
  'Database to list. Defaults to the database configured on the MySQL settings page.',
)
console.log('dialect-derived parameter text: unchanged')

// The plugin provides the registry and registers its own dialect into it.
assert.deepEqual(ctx.databaseDialects.names(), ['mysql'])
assert.equal(ctx.databaseDialects.get('mysql'), MYSQL_DIALECT)
console.log(`dialect registry: ${ctx.databaseDialects.names().join(', ')}`)

const query = ctx.tools.get('db_query')
const write = await query.execute({ sql: 'DROP TABLE users' }, undefined).then(() => undefined, error => error)
assert.ok(write instanceof Error, 'a write statement is refused')
assert.match(write.message, /read-only/)
console.log(`write refusal: ${write.message}`)

const tables = ctx.tools.get('db_tables')
const noDatabase = await tables.execute({}, undefined).then(() => undefined, error => error)
assert.ok(noDatabase instanceof Error, 'no default database is an actionable refusal')
assert.match(noDatabase.message, /no database selected/)
console.log(`database refusal: ${noDatabase.message}`)

const reach = await tables.execute({ database: 'app' }, undefined).then(() => undefined, error => error)
assert.ok(reach instanceof Error, 'an unreachable server fails the call')
// The refusal names the connection it used, so a model can act on it.
assert.match(reach.message, /MySQL statement on nobody@127\.0\.0\.1:1 failed: connect ECONNREFUSED/)
console.log(`connection refusal: ${reach.message}`)

// A dialect name nothing registers is reported by the call that needs it, with
// what is registered, rather than by a load that cannot know about later layers.
const second = await mount({ ...UNREACHABLE, dialect: 'postgres' })
assert.deepEqual(second.databaseDialects.names(), ['mysql'], 'the plugin still registers its own dialect')
const unresolved = await second.tools.get('db_tables').execute({ database: 'app' }, undefined)
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
  const query = (sql, project) => ({ statement: { sql, values: [] }, project })
  const rowsFor = (sql) => {
    if (sql.includes('pg_database')) return [{ name: 'app' }]
    if (sql.includes('pg_tables')) return [{ name: 'events', type: 'BASE TABLE' }]
    if (sql.includes('version')) return [{ version }]
    return []
  }
  return {
    name: 'postgres',
    label,
    rules: MYSQL_DIALECT.rules,
    rowBoundHint: 'FETCH FIRST',
    systemDatabases: [],
    async open() {
      return {
        async run(statement) {
          seen.sql = statement.sql
          return { rows: rowsFor(statement.sql), columns: [] }
        },
        async close() {},
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
    columns: () => query('SELECT * FROM information_schema.columns', () => ({})),
    indexes: () => query('SELECT * FROM pg_indexes', () => ({})),
    createStatement: () => query('SELECT pg_get_tabledef()', () => ''),
    version: () => query('SELECT version() AS version', row => String(row.version ?? '')),
  }
}

// A dialect that arrives after this plugin — the shape a separately packaged
// dialect has, since the registry is provided here — runs every call after it.
const dispose = second.databaseDialects.register(standInDialect('PostgreSQL', '16.3'))
const listed = await second.tools.get('db_tables').execute({ database: 'app' }, undefined)
assert.deepEqual(listed, {
  database: 'app',
  tables: [{ name: 'events', type: 'BASE TABLE', engine: null, estimatedRows: null, comment: '' }],
})
console.log(`second dialect ran the tools: ${JSON.stringify(listed)}`)

// Its own statement, projection, and syntax win over the ones this plugin was
// registered with: the bound below is spelled the second dialect's way.
const databases = await second.tools.get('db_databases').execute({}, undefined)
assert.deepEqual(databases, { databases: [{ name: 'app', charset: '', collation: '' }] })
const bounded = await second.tools.get('db_query').execute({ sql: 'SELECT 1' }, undefined)
assert.match(seen.sql, /FETCH FIRST 201 ROWS ONLY/, 'the second dialect bounded the statement')
assert.equal(bounded.rowCount, 0)
console.log(`second dialect bounded a query: ${JSON.stringify(seen.sql)}`)

// Registration is an effect: disposing it takes the dialect away again.
dispose()
const gone = await second.tools.get('db_tables').execute({ database: 'app' }, undefined)
  .then(() => undefined, error => error)
assert.match(gone.message, /database dialect "postgres" is not registered/)
console.log('dialect disposal: the registered dialect is gone again')

// Unload through the framework, so the session's disposers run.
await ctx.fiber.dispose()
await second.fiber.dispose()
console.log('host check passed')