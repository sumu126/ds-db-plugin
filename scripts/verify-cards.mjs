/**
 * Card check: the first guard over the browser half of this plugin.
 *
 * The other checks mount the Host; this one mounts the Host *and* the card model
 * the browser runs, then walks the metadata from one to the other. What it
 * proves is the contract between the two halves: a card the Host writes is a card
 * the client reads back the same way, and every way a call can fail to be a card
 * falls back to the generic row instead of drawing something wrong.
 *
 * The model imports no React and touches no DOM, which is why this runs in Node.
 *
 * Run it from this plugin's directory; `tsconfig.json` points `@deepseek-ai/*`
 * at the harness checkout beside it, and tsx resolves those paths from the
 * working directory.
 *
 *   npm run verify:cards
 */
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import * as mysqlReadOnly from '../src/index.ts'
import * as mysqlDialect from '../dialects/mysql/src/index.ts'
import { TOOL_ROW_KEYS, callText, dbCardModel, errorText, genericText } from '../src/client/card-model.ts'
import { CARD_BYTES } from '../src/tools.ts'

const ctx = new Context()
await ctx.plugin(SystemPrompt, {})
await ctx.plugin(ToolRuntime, { mode: 'native', maxParallelSubCalls: 1 })
await ctx.plugin(mysqlDialect, {})
await ctx.plugin(mysqlReadOnly, { host: '127.0.0.1', port: 1, user: 'nobody', database: '' })
for (let attempt = 0; attempt < 100 && ctx.tools.get('db_query') === undefined; attempt++) {
  await new Promise(resolve => setTimeout(resolve, 10))
}

// The keys the client claims have to be tools that really exist: a rename on the
// Host side would otherwise leave the browser drawing rows for nothing, and the
// generic fallback would hide it.
for (const key of TOOL_ROW_KEYS) {
  assert.ok(ctx.tools.get(key), `${key} is a registered tool`)
}
console.log(`claimed keys: ${TOOL_ROW_KEYS.join(', ')}`)

/**
 * A settled root call carrying one metadata object, as the chat layer freezes it.
 * Only the fields a card model reads are set.
 * @param meta - the persisted metadata, or undefined for a call that has none.
 * @param overrides - fields the case wants in a different state.
 * @returns the frozen call node.
 */
function settledCall(meta, overrides = {}) {
  return {
    kind: 'tool-result',
    seq: 1,
    time: 0,
    callId: 'call-1',
    call: { name: 'db_query', argsRaw: '{}' },
    callTime: 0,
    content: [{ type: 'text', text: 'rows' }],
    isError: false,
    subCalls: [],
    ...meta === undefined ? {} : { meta },
    ...overrides,
  }
}

/** The metadata one tool would persist for one canonical value. */
function metaOf(name, args, value) {
  const tool = ctx.tools.get(name)
  assert.ok(tool, `${name} is registered`)
  return tool.output.presentationMeta(args, value)
}

// The Host writes a card and the client reads it back: same columns in the same
// order, the same rows flattened to cells, and the same facts beside them.
const queryValue = {
  columns: ['id', 'name'],
  rows: [{ id: 1, name: 'a' }, { id: 2, name: 'b' }],
  rowCount: 2,
  truncated: false,
  elapsedMs: 4,
}
const queryCard = dbCardModel(settledCall(metaOf('db_query', { sql: 'SELECT id, name' }, queryValue)))
assert.equal(queryCard.kind, 'table', 'a query result draws a table')
assert.deepEqual(queryCard.columns, ['id', 'name'], 'the columns keep the order the server answered')
assert.deepEqual(queryCard.rows, [[1, 'a'], [2, 'b']], 'the rows arrive flattened against the columns')
assert.equal(queryCard.rowCount, 2, 'the count the server answered travels')
assert.equal(queryCard.truncated, false)
assert.equal(queryCard.elapsedMs, 4)
console.log(`round trip: db_query ${String(queryCard.rows.length)} row(s) read back`)

// A listing, whose detail is the part a reader scans for.
const databasesCard = dbCardModel(settledCall(metaOf('db_databases', {}, {
  databases: [
    { name: 'app', charset: 'utf8mb4', collation: 'utf8mb4_general_ci' },
    { name: 'internal', charset: '', collation: '' },
  ],
})))
assert.equal(databasesCard.kind, 'list')
assert.deepEqual(databasesCard.items, [
  { name: 'app', detail: 'utf8mb4/utf8mb4_general_ci' },
  { name: 'internal' },
], 'a listing carries each item and its detail, and no detail when there is none')
assert.equal(databasesCard.total, 2)
assert.equal(databasesCard.label, 'databases')
console.log('round trip: db_databases listing read back')

// A header never shows a wire tool name: a card that knows what it read says the
// name, and one that does not falls back to copy a dictionary carries.
const sampleCard = dbCardModel(settledCall(metaOf('db_sample', { table: 'events' }, {
  database: 'app', table: 'events', columns: ['id'], rows: [[1]],
})))
const tablesCard = dbCardModel(settledCall(metaOf('db_tables', { database: 'app' }, {
  database: 'app', tables: [{ name: 'events', type: 'BASE TABLE', engine: 'InnoDB', estimatedRows: 3, comment: '' }],
})))
assert.equal(queryCard.title.scope, undefined, 'a bare query has no name of its own')
assert.equal(queryCard.title.key, 'result', 'so it falls back to the copy for a query result')
assert.equal(sampleCard.title.scope, 'app.events', 'a sample says what it read')
assert.equal(databasesCard.title.key, 'databases', 'a listing says what it lists')
assert.equal(tablesCard.title.key, 'tables')
assert.equal(tablesCard.title.scope, undefined)
for (const card of [queryCard, sampleCard, databasesCard, tablesCard]) {
  assert.equal(
    (card.title.scope ?? card.title.key).startsWith('db_'),
    false,
    'no header is a wire tool name',
  )
}
console.log('headers: named when named, copy otherwise, never a wire tool name')

// Every way metadata can fail to describe a card: the generic row, never a
// half-drawn one. These are the payloads a replayed session can really carry.
const table = { card: 'table', columns: ['id'], rows: [[1]], rowCount: 1, truncated: false }
assert.equal(dbCardModel(settledCall(undefined)), null, 'a call with no metadata')
assert.equal(dbCardModel(settledCall({ card: 'sparkline', truncated: false })), null, 'a discriminator this version does not know')
assert.equal(dbCardModel(settledCall({ ...table, columns: 'id' })), null, 'columns that is not a list')
assert.equal(dbCardModel(settledCall({ ...table, columns: [7] })), null, 'a column name that is not a name')
assert.equal(dbCardModel(settledCall({ ...table, rows: [[{ nested: true }]] })), null, 'a cell that is not a scalar')
assert.equal(dbCardModel(settledCall({ ...table, rows: [[]] })), null, 'a row that is shorter than the columns')
assert.equal(dbCardModel(settledCall({ ...table, rows: [[1, 2]] })), null, 'a row that is longer than the columns')
assert.equal(dbCardModel(settledCall({ ...table, rowCount: 0.5 })), null, 'a row count that is not a whole number')
assert.equal(dbCardModel(settledCall({ ...table, truncated: 'yes' })), null, 'a truncated flag that is not a flag')
assert.equal(dbCardModel(settledCall({ ...table, card: 'list', label: 'tables', items: [{ name: 3 }], total: 1 })), null, 'an item whose name is not a name')
assert.equal(dbCardModel(settledCall({ ...table, card: 'list', label: 'views', items: [], total: 0 })), null, 'a listing whose label is neither')
console.log('malformed metadata: twelve payloads, all falling back')

// The states a call itself can be in, which no metadata can rescue.
const goodMeta = metaOf('db_query', { sql: 'SELECT 1' }, queryValue)
const running = {
  callId: 'c', name: 'db_query', argsRaw: '{"sql":"SELECT SLEEP(6)"}', turn: 1, step: 1, time: 0, subCalls: [],
}
assert.equal(dbCardModel(settledCall(goodMeta, { isError: true })), null, 'a call that failed')
assert.equal(dbCardModel(running), null, 'a call still running')
assert.equal(dbCardModel(settledCall(goodMeta, { parentCallId: 'parent' })), null, 'a call dispatched inside another')
console.log('call states: failed, running, and nested all fall back')

// And a running call still says what it is doing. Claiming the key took the
// shell's row away, so the arguments are the only place the statement appears —
// a six-second query that shows nothing but its tool name reads as a call with no
// input at all.
assert.equal(callText(running), '{"sql":"SELECT SLEEP(6)"}', 'a running call shows the arguments it was given')
assert.equal(callText(settledCall(undefined)), 'rows', 'a settled call shows its result text')
console.log('running text: the statement stays visible while the call is in flight')

// The text the generic row shows, so the fallback is never an empty box.
assert.equal(genericText(settledCall(undefined)), 'rows', 'the generic row shows the result text')
assert.equal(errorText(settledCall(undefined)), '', 'a call that did not fail has no failure text')
assert.equal(
  errorText(settledCall(undefined, { isError: true, error: { name: 'Error', code: 'E_FAIL', reason: 'the pool is closed' } })),
  'the pool is closed',
  'a failed call shows why it failed',
)
assert.equal(
  errorText(settledCall(undefined, { isError: true, error: { name: 'Error', code: 'E_FAIL' } })),
  'E_FAIL',
  'a failure with no reason shows its code',
)
console.log('fallback text: a row that fell back is never empty')

// The metadata is written into the session log, so an unbounded card is a session
// log that grows with whatever a query happened to return.
const many = {
  columns: ['id'],
  rows: Array.from({ length: 500 }, (_, index) => ({ id: index })),
  rowCount: 500,
  truncated: false,
  elapsedMs: 1,
}
const manyMeta = metaOf('db_query', { sql: 'SELECT id' }, many)
assert.equal(manyMeta.truncated, true, 'a card past its bound says it was cut')
assert.ok(manyMeta.rows.length < 500, 'a card carries fewer rows than the server answered')
assert.ok(Buffer.byteLength(JSON.stringify(manyMeta), 'utf8') <= CARD_BYTES, 'a card stays within the byte bound')

// A card that was cut keeps the call's own text beside it: the card trims for
// display, while the whole result is still the text the model read — so it opens
// in place rather than being lost to the reader or fetched again.
const manyCard = dbCardModel(settledCall(manyMeta))
assert.equal(manyCard.truncated, true, 'the client reads the cut back')
assert.equal(manyCard.recovery, 'rows', 'a cut card carries the whole result text')
assert.equal(queryCard.recovery, undefined, 'a card that was not cut carries none')
assert.equal(
  dbCardModel(settledCall(manyMeta, { content: [] })).recovery,
  '',
  'a cut card with no result text carries an empty one, which the view does not offer',
)
console.log('recovery: a cut card carries the full text, an intact one carries none')

// The bound is bytes, not UTF-16 code units: a CJK cell costs three bytes per
// character, so a card whose rows fit by string length can be well over budget —
// and the session log would then carry every one of those bytes.
const cjk = '中文测试'.repeat(40)
const wide = {
  columns: ['wide_cell', 'id'],
  rows: Array.from({ length: 200 }, (_, index) => ({ wide_cell: cjk, id: index })),
  rowCount: 200,
  truncated: false,
  elapsedMs: 5,
}
const wideMeta = metaOf('db_query', { sql: 'SELECT wide_cell, id' }, wide)
const wideBytes = Buffer.byteLength(JSON.stringify(wideMeta), 'utf8')
assert.equal(wideMeta.truncated, true, 'a card of wide CJK cells says it was cut')
assert.ok(wideMeta.rows.length < 50, 'the byte bound cut it before the row bound did')
assert.ok(wideBytes <= CARD_BYTES, `a card of CJK text stays within the bound (${String(wideBytes)} bytes)`)
console.log(`bounds: ${String(manyMeta.rows.length)} of 500 rows, ${String(wideMeta.rows.length)} of 200 wide rows, ${String(wideBytes)} utf8 bytes`)

await ctx.fiber.dispose()
console.log('card check passed')
process.exit(0)
