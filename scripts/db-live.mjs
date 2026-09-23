/**
 * Live database check: run this plugin's read-only tools against a real server.
 *
 * Every other check runs without a database. The host checks point at a port
 * nothing listens on, and the card check feeds the model hand-written values — so
 * the shapes this plugin assumes have only ever been read off the code and the
 * docs. Two of them are load-bearing:
 *
 * - a result row is an object keyed by column name (`DbRow` is a type, and the
 *   client's `cardRow` blanks every cell of a row that is not one);
 * - a declared capability really answers. A dialect that claims `indexes` and
 *   then returns none is wrong in a way no stub can show.
 *
 * This check is the one that puts them in front of a server. It reports a ledger:
 * every assertion and the number it measured, for a person to read.
 *
 *   npm run db:live -- "<saved connection name>" ["<another saved connection>"]
 *
 * Deliberate constraints:
 * - only this plugin's read-only tools are called. A writing statement would be
 *   refused by `sql-guard` anyway, and this script never issues one;
 * - the connection is named on the command line; an unknown name, or a server
 *   that will not answer, fails loudly rather than passing quietly;
 * - no business data is asserted — a live table's row count changes. What is
 *   asserted is shape, cross-source agreement, and self-consistency;
 * - it is not part of `verify:*`: it needs a real database and real credentials.
 */
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import CredentialsLocal from '@deepseek-ai/dsh-credentials-local'
import SettingsFile from '@deepseek-ai/dsh-settings-file'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { DB_SETTINGS_NAMESPACE } from '../src/contract.ts'
import * as mysqlReadOnly from '../src/index.ts'
import * as mysqlDialect from '../dialects/mysql/src/index.ts'
import { dbCardModel } from '../src/client/card-model.ts'

const names = process.argv.slice(2)
if (names.length === 0) {
  console.error('usage: npm run db:live -- "<saved connection name>" ["<another saved connection>"]')
  process.exit(2)
}

// The real services, not stubs: the settings document is the user's own, and the
// credentials come from the store a deployment installs — so a connection whose
// password is missing fails here the way it would fail in a session.
const ctx = new Context()
await ctx.plugin(SystemPrompt, {})
await ctx.plugin(ToolRuntime, { mode: 'native', maxParallelSubCalls: 1 })
await ctx.plugin(SettingsFile, {})
await ctx.plugin(CredentialsLocal, {})
await ctx.plugin(mysqlDialect, {})
await ctx.plugin(mysqlReadOnly, {})
for (let attempt = 0; attempt < 200 && ctx.tools.get('db_query') === undefined; attempt++) {
  await new Promise(resolve => setTimeout(resolve, 10))
}

/**
 * Call one of this plugin's tools the way the host does.
 * @param name - the tool to call.
 * @param args - its validated arguments.
 * @returns the tool's canonical value.
 */
async function call(name, args) {
  const tool = ctx.tools.get(name)
  assert.ok(tool !== undefined, `${name} is registered`)
  return await tool.execute(args, { signal: new AbortController().signal })
}

/**
 * A settled root call carrying one metadata object, as the chat layer freezes it.
 * @param meta - the persisted metadata.
 * @returns the frozen call node.
 */
function settledCall(meta) {
  return {
    kind: 'tool-result',
    seq: 1,
    time: 0,
    callId: 'live-1',
    call: { name: 'db_query', argsRaw: '{}' },
    callTime: 0,
    content: [],
    isError: false,
    subCalls: [],
    meta,
  }
}

/** The columns a result row has to carry, whatever it holds. */
function assertRowShape(rows, columns, what) {
  assert.ok(rows.length > 0, `${what} answered at least one row`)
  for (const row of rows) {
    assert.equal(typeof row, 'object', `${what}: a result row is an object`)
    assert.equal(row !== null, true, `${what}: a result row is not null`)
    assert.equal(Array.isArray(row), false, `${what}: a result row is not an array`)
    for (const column of columns) {
      assert.ok(Object.hasOwn(row, column), `${what}: the row carries the column "${column}"`)
    }
  }
}

/** The first value of a row, whatever the server called its column. */
function firstValue(row) {
  return Object.values(row)[0]
}

/** Shape: what a result row is, on a server rather than in a type declaration. */
async function checkShapes(name) {
  const value = await call('db_query', {
    connection: name,
    sql: "SELECT 1 AS one, NULL AS nothing, 'text' AS label, 1.5 AS exact_value",
    // The row is what is under test, not the bounding: this result is one row.
  })
  assert.deepEqual(value.columns, ['one', 'nothing', 'label', 'exact_value'], 'the columns come back as asked')
  assertRowShape(value.rows, value.columns, 'db_query')
  console.log(`  shape: db_query — ${String(value.rows.length)} row, ${String(value.columns.length)} columns,`
    + ' every column keyed on the row')

  const tables = await call('db_tables', { connection: name })
  if (tables.tables.length === 0) {
    console.log('  shape: db_sample — skipped, the default database has no tables')
    return
  }
  const first = tables.tables[0].name
  const sample = await call('db_sample', { connection: name, table: first, rows: 2 })
  assert.ok(sample.columns.length > 0, 'db_sample answered columns')
  assertRowShape(sample.rows, sample.columns, 'db_sample')
  console.log(`  shape: db_sample — ${String(sample.rows.length)} row(s) of "${first}", keyed the same way`)
}

/** Cross-source: two code paths that must agree, with different SQL under them. */
async function checkCrossSource(name) {
  const listed = await call('db_tables', { connection: name })
  const shown = await call('db_query', { connection: name, sql: 'SHOW FULL TABLES' })
  assert.equal(listed.tables.length, shown.rows.length, 'db_tables and SHOW FULL TABLES agree on how many there are')
  const fromTool = new Set(listed.tables.map(table => table.name))
  for (const row of shown.rows) {
    const table = firstValue(row)
    assert.ok(fromTool.has(table), `SHOW FULL TABLES listed "${table}" and db_tables listed it too`)
  }
  console.log(`  cross-source: db_tables ${String(listed.tables.length)} = SHOW FULL TABLES ${String(shown.rows.length)}`)

  // The system schemas are included on the tool side so the two answer the same
  // question: `information_schema` is as visible to SHOW DATABASES as any other.
  const databases = await call('db_databases', { include_system: true })
  const showDatabases = await call('db_query', { sql: 'SHOW DATABASES' })
  const namedByTool = databases.databases.map(database => database.name).sort()
  const namedByShow = showDatabases.rows.map(row => String(firstValue(row))).sort()
  assert.deepEqual(namedByTool, namedByShow, 'db_databases matches SHOW DATABASES, name for name')
  console.log(`  cross-source: db_databases ${String(namedByTool.length)} = SHOW DATABASES ${String(namedByShow.length)}`)
}

/** Cards: the metadata a client reads back, against the value the server answered. */
async function checkCards(name) {
  const args = { connection: name, sql: "SELECT 1 AS one, NULL AS nothing, 'text' AS label" }
  const value = await call('db_query', args)
  const meta = ctx.tools.get('db_query').output.presentationMeta(args, value)
  const card = dbCardModel(settledCall(meta))
  assert.equal(card.kind, 'table', 'the metadata reads back as a table')
  assert.deepEqual(card.columns, value.columns, 'the card keeps the column order the server answered')
  assert.equal(card.rows.length, value.rows.length, 'the card carries every row of this small result')
  for (const [index, row] of card.rows.entries()) {
    assert.equal(row.length, card.columns.length, 'every card row is as wide as its columns')
    for (const [columnIndex, column] of card.columns.entries()) {
      const raw = value.rows[index][column]
      const cell = row[columnIndex]
      if (raw === null || typeof raw !== 'object') {
        assert.equal(cell, raw, `cell "${column}" of row ${String(index)} is the value the server answered`)
      } else {
        // A non-scalar travels as its JSON text; what is asserted is that it
        // arrives at all, not the spelling the client and the host agree on.
        assert.equal(typeof cell, 'string', `a non-scalar cell "${column}" travels as text`)
        assert.ok(cell.length > 0, `and "${column}" is not empty`)
      }
    }
  }
  console.log(`  cards: ${String(card.columns.length)} columns × ${String(card.rows.length)} row(s)`
    + ' match the canonical value the same call returned')
}

/** `db_explain`: the tool no session in the recorded logs had ever called. */
async function checkExplain(name) {
  const plan = await call('db_explain', { connection: name, sql: 'SELECT 1' })
  assert.equal(Array.isArray(plan.plan), true, 'db_explain answers a plan')
  assert.ok(plan.plan.length > 0, 'and the plan is not empty')
  console.log(`  db_explain: ${String(plan.plan.length)} plan row(s)`)
}

/**
 * How many connections the server holds for this account.
 *
 * Read through the plugin's own tools, which means through the same pool the
 * calls under test use: the number says whether that pool is holding more
 * connections than it started with, not how many the server has in total.
 * @param name - the connection to look through.
 * @returns the count.
 */
async function openConnections(name) {
  const value = await call('db_query', {
    connection: name,
    sql: 'SELECT COUNT(*) AS open_connections FROM information_schema.processlist'
      + " WHERE USER = SUBSTRING_INDEX(CURRENT_USER(), '@', 1)",
  })
  return Number(firstValue(value.rows[0]))
}

/**
 * Wait until the server is really running a statement that sleeps.
 *
 * Reading the server is how a check learns a call is in flight. Sleeping instead
 * races the machine: on a slow one the statement may already be finished, and the
 * cancellation would land after the call rather than during it — measuring a
 * different path than the one this claims to.
 * @param name - the connection to look through.
 * @param seconds - the sleep the statement is expected to be running.
 * @returns how many polls it took to see it.
 * @throws {Error} when no such statement appears.
 */
async function waitForSleeping(name, seconds) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = await call('db_query', {
      connection: name,
      sql: 'SELECT COUNT(*) AS sleeping FROM information_schema.processlist'
        + ` WHERE USER = SUBSTRING_INDEX(CURRENT_USER(), '@', 1) AND INFO LIKE 'SELECT SLEEP(${String(seconds)}%'`,
    })
    if (Number(firstValue(value.rows[0])) > 0) return attempt
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`no statement sleeping for ${String(seconds)} s appeared on the server`)
}

/**
 * Cancellation, against a real pool: what aborting does, and what survives it.
 *
 * The seam's own note says a cancellation retires the session rather than
 * interrupting the statement — mysql2's promise pool has no `destroy()`, so
 * `end()` queues a COM_QUIT behind the statement already running. So this
 * measures that instead of asserting the call ends promptly: it asserts the call
 * comes back **after** the statement would have finished, and that the next call
 * works. The second half is the repair N9 made, and this is its first time
 * against a real driver.
 * @param name - the saved connection to cancel a call on.
 */
async function checkCancellation(name) {
  const sleepSeconds = 4
  const before = await openConnections(name)
  const controller = new AbortController()
  const pending = ctx.tools.get('db_query').execute(
    { connection: name, sql: `SELECT SLEEP(${String(sleepSeconds)}) AS slept` },
    { signal: controller.signal },
  )
  // A cancellation in flight, not one before the call: the server says when.
  const polls = await waitForSleeping(name, sleepSeconds)
  const at = Date.now()
  controller.abort()
  const outcome = await pending.then(() => undefined, error => error)
  const elapsed = Date.now() - at

  assert.ok(
    elapsed >= sleepSeconds * 1000 * 0.5,
    `the call outlives the cancellation, as the seam documents (came back after ${String(elapsed)} ms)`,
  )
  console.log(`  cancellation: aborted in flight, call returned ${String(elapsed)} ms later`
    + ` — a ${String(sleepSeconds)}s statement, cancelled by retiring the session, not by interrupting it`)
  if (outcome instanceof Error) {
    console.log(`  cancellation: it ended as "${outcome.message.split('\n')[0].slice(0, 100)}"`)
  }

  const after = await call('db_query', { connection: name, sql: 'SELECT 1 AS one' })
  assert.equal(after.rows.length, 1, 'the next call reconnects and works')
  console.log('  cancellation: the next call succeeded — a retired session is replaced, not reused')

  // A reading, not an assertion: whether the pool holds a different number of
  // server connections after a cancellation. It is here because it is the
  // obvious-looking way to tell "the session was retired" from "the signal did
  // nothing", and the number says whether that way works.
  const connections = await openConnections(name)
  console.log(`  cancellation: server connections ${String(before)} → ${String(connections)},`
    + ` statement seen running after ${String(polls)} poll(s)`)
}

/**
 * The query timeout, on a context whose connection asks for a short one.
 *
 * It gets a context of its own because the timeout belongs to the connection: the
 * user's own connections carry the deployment's 30 s, and borrowing one of those
 * would make this check wait half a minute to prove a one-and-a-half-second rule.
 * @param base - a saved connection to copy, addressed by the composition layer.
 */
async function checkTimeout(base) {
  const timing = new Context()
  await timing.plugin(SystemPrompt, {})
  await timing.plugin(ToolRuntime, { mode: 'native', maxParallelSubCalls: 1 })
  await timing.plugin(CredentialsLocal, {})
  await timing.plugin(mysqlDialect, {})
  await timing.plugin(mysqlReadOnly, {
    connections: [{ ...base, id: 'timing', name: 'timing', queryTimeoutMs: 1500 }],
  })
  for (let attempt = 0; attempt < 200 && timing.tools.get('db_query') === undefined; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  const started = Date.now()
  const outcome = await timing.tools.get('db_query')
    .execute({ sql: 'SELECT SLEEP(5) AS slept' }, { signal: new AbortController().signal })
    .then(() => undefined, error => error)
  const elapsed = Date.now() - started
  assert.ok(outcome instanceof Error, 'a statement past the query timeout fails instead of hanging')
  assert.ok(elapsed < 4500, `and it fails before the statement would have finished (${String(elapsed)} ms)`)
  console.log(`  timeout: a 1.5 s timeout ended a 5 s statement after ${String(elapsed)} ms`
    + ` (measured on "${base.name}" only — the timeout lives on a connection)`)
  await timing.fiber.dispose()
}

const listed = await call('db_connections', {})
const saved = new Map(listed.connections.map(connection => [connection.name, connection]))
for (const name of names) {
  if (!saved.has(name)) {
    console.error(`no saved connection is named "${name}"; saved: ${[...saved.keys()].join(', ')}`)
    process.exit(2)
  }
}
console.log(`connections: ${names.join(', ')} of ${String(saved.size)} saved`)

for (const name of names) {
  const connection = saved.get(name)
  console.log(`\n=== ${name} — ${connection.host}:${String(connection.port)}/${connection.database || '(no default)'} ===`)
  await checkShapes(name)
  await checkCrossSource(name)
  await checkCards(name)
  await checkExplain(name)
  // Last on this connection: cancelling retires that connection's session, so
  // every check needing a healthy one has already run.
  await checkCancellation(name)
}

// The timing context opens a connection of its own, and it runs last of all so
// nothing of the user's is still in flight while a timeout is provoked.
const profiles = ctx.settings.section(DB_SETTINGS_NAMESPACE)?.connections ?? []
const base = profiles.find(profile => profile.name === names[0])
assert.ok(base !== undefined, `the settings section holds a profile named "${names[0]}"`)
await checkTimeout(base)

console.log(`\nsettings section: ${String(profiles.length)} connection(s)`)
console.log('live database check passed')

// The settings service watches its file and a credentials store watches theirs;
// the checks are done, so the process ends on its own terms.
await ctx.fiber.dispose()
process.exit(0)
