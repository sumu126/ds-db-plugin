/**
 * Live-card check: read a recorded session and measure the cards really in it.
 *
 * Every other check builds its own inputs. This one reads what a deployment
 * actually persisted, which is the only way to see what a budget does against real
 * data — CJK text at three bytes a character, cells far wider than a column,
 * DECIMAL and BIGINT cells that arrive as strings.
 *
 * It is deliberately not part of `verify:*`: a session log is user data, so the
 * path is passed explicitly and the check runs by hand.
 *
 *   node --experimental-strip-types scripts/verify-live.mjs <session.jsonl.zstd>
 *
 * It loads `card-model.ts` with Node's own type stripping rather than tsx: the
 * model imports no React and touches no DOM, so nothing else is needed.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { CARD_BYTES } from '../src/card-budget.ts'
import { dbCardModel } from '../src/client/card-model.ts'

const path = process.argv[2]
if (path === undefined) {
  console.error('usage: npm run card:live -- <path to a session .jsonl.zstd>')
  process.exit(2)
}

/** The zstd frame magic. A session log is written as one frame per flush. */
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * Every frame in one zstd file, decompressed separately.
 *
 * `zstdDecompressSync` reads the first frame and stops, and a session log is many
 * frames; a frame that will not open — a magic sequence that was really data, or
 * the frame still being written — is skipped rather than failing the run.
 * @param buffer - the file's bytes.
 * @returns the decoded text, plus how many frames there were and how many were skipped.
 */
function decode(buffer) {
  const starts = []
  for (let at = buffer.indexOf(MAGIC); at !== -1; at = buffer.indexOf(MAGIC, at + 4)) starts.push(at)
  const parts = []
  let skipped = 0
  for (const [index, start] of starts.entries()) {
    const end = starts[index + 1] ?? buffer.length
    try {
      parts.push(zstdDecompressSync(buffer.subarray(start, end)).toString('utf8'))
    } catch {
      skipped += 1
    }
  }
  return { text: parts.join(''), frames: starts.length, skipped }
}

/**
 * The call this result answers, as the log records it.
 *
 * A `tool/result` event carries no call id of its own; the message it holds names
 * it under `source`, which is also the only way to reach the `tool/call` event
 * that has the tool's name.
 * @param data - the `tool/result` event's data.
 * @returns the call id, or undefined when the record does not name one.
 */
function callIdOf(data) {
  const callId = data.message?.source?.callId
  return typeof callId === 'string' ? callId : undefined
}

/**
 * The result's content blocks.
 *
 * They sit one level down: the message holds a `tool-result` block whose own
 * `content` is the text the model read.
 * @param data - the `tool/result` event's data.
 * @returns the inner blocks, empty when the record holds none.
 */
function contentOf(data) {
  const parts = data.message?.content
  if (!Array.isArray(parts)) return []
  const blocks = []
  for (const part of parts) {
    if (part?.type !== 'tool-result' || !Array.isArray(part.content)) continue
    for (const inner of part.content) blocks.push(inner)
  }
  return blocks
}

/**
 * The frozen call node a card model reads, rebuilt from a recorded result.
 * @param data - the `tool/result` event's data.
 * @returns the node, with only the fields a model looks at.
 */
function blockOf(data) {
  return {
    kind: 'tool-result',
    seq: 0,
    time: 0,
    callId: callIdOf(data) ?? '',
    call: null,
    callTime: null,
    content: contentOf(data),
    // A failed result carries no metadata at all, so what is measured here is a
    // call that succeeded.
    isError: false,
    subCalls: [],
    ...data.meta === undefined ? {} : { meta: data.meta },
  }
}

const scan = decode(readFileSync(path))

// A recorded result does not carry its tool's name: the name is on the `tool/call`
// the result answers, so the log has to be paired up the way the client pairs it.
const names = new Map()
const results = []
for (const line of scan.text.split('\n')) {
  if (line.trim().length === 0) continue
  let event
  try {
    event = JSON.parse(line)
  } catch {
    continue
  }
  if (event?.type === 'tool/call' && typeof event.data?.name === 'string') {
    names.set(event.data.callId, event.data.name)
  } else if (event?.type === 'tool/result' && event.data?.meta !== undefined) {
    results.push({ data: event.data, time: typeof event.time === 'number' ? event.time : 0 })
  }
}

const byTool = new Map()
let withMeta = 0
let otherTools = 0
let unnamed = 0
let fellBack = 0
let largest = 0
let largestTool = ''

for (const { data, time } of results) {
  const callId = callIdOf(data)
  const name = callId === undefined ? undefined : names.get(callId)
  // Only this plugin's tools are measured: another tool's metadata answers to its
  // own budget, and counting it here would report someone else's number as a
  // failure of this one.
  if (name === undefined) {
    unnamed += 1
    continue
  }
  if (!name.startsWith('db_')) {
    otherTools += 1
    continue
  }
  withMeta += 1

  const bytes = Buffer.byteLength(JSON.stringify(data.meta), 'utf8')
  if (bytes > largest) {
    largest = bytes
    largestTool = name
  }
  const card = dbCardModel(blockOf(data))
  const entry = byTool.get(name) ?? {
    cards: 0, fallbacks: 0, maxBytes: 0, oversize: 0, shapes: new Set(),
    latest: { bytes: 0, time: -1 },
  }
  if (card === null) {
    entry.fallbacks += 1
    fellBack += 1
  } else {
    entry.cards += 1
    entry.shapes.add(card.kind === 'table' ? `table:${card.title.scope ?? card.title.key}` : `list:${card.label}`)
  }
  entry.maxBytes = Math.max(entry.maxBytes, bytes)
  if (bytes > CARD_BYTES) entry.oversize += 1
  // The newest card of a tool is the only one that speaks for the code in the
  // tree: a log holds versions, and an old over-budget card is history, not a
  // regression.
  if (time >= entry.latest.time) entry.latest = { bytes, time }
  byTool.set(name, entry)
}

console.log(`session: ${path}`)
console.log(`frames: ${String(scan.frames)} found, ${String(scan.skipped)} skipped`)
console.log(`results with metadata: ${String(results.length)} — ${String(withMeta)} from this plugin,`
  + ` ${String(otherTools)} from other tools, ${String(unnamed)} whose call was outside the window`)
for (const [name, entry] of [...byTool].sort(([left], [right]) => (left < right ? -1 : 1))) {
  console.log(`  ${name.padEnd(14)} cards ${String(entry.cards)}, fell back ${String(entry.fallbacks)},`
    + ` newest ${String(entry.latest.bytes)} bytes, largest ${String(entry.maxBytes)} bytes`
    + ` (${String(entry.oversize)} over bound), ${[...entry.shapes].join(' ')}`)
}
console.log(`largest recorded card: ${largestTool} at ${String(largest)} bytes (bound ${String(CARD_BYTES)})`)

// What this asserts: the newest card of each tool fits the budget, which is what
// ties the number in the log to the code in the tree. Older cards need not — a
// session keeps what previous versions wrote, and that is exactly how the
// byte-unit bug turned up here: an old 24,649-byte card beside a current 16,303.
const overNow = [...byTool].filter(([, entry]) => entry.latest.bytes > CARD_BYTES)
assert.deepEqual(
  overNow.map(([name, entry]) => `${name} at ${String(entry.latest.bytes)} bytes`),
  [],
  `the newest card of every tool stays within ${String(CARD_BYTES)} bytes`,
)
const history = [...byTool].reduce((total, [, entry]) => total + entry.oversize, 0)
if (history > 0) {
  console.log(`note: ${String(history)} older card(s) are over the bound — written before the fix;`
    + ' only the newest card of each tool is asserted')
}
if (fellBack > 0) {
  console.log(`note: ${String(fellBack)} recorded card(s) did not read back as a card —`
    + ' expected for metadata an older version wrote, worth a look otherwise')
}
console.log('live card check passed')
