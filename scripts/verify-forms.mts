/**
 * Form check: the schema shape the 0.2.x settings model projects pages from, and
 * the fact that a live reference is re-read rather than captured.
 *
 * This check exists because one failure was invisible to every other gate. From
 * 0.2.x the host serves a settings page **only** for an entry whose `Config`
 * declares volatile fields: `volatileForm()` returns `undefined` for a schema
 * with none, and `describe()` then drops the entry from the descriptor list
 * entirely instead of describing an empty form. The client asks for that entry
 * by id, gets no namespace back, and reports it as unavailable.
 *
 * So a plugin can build, activate, register every tool, serve every route, pass
 * `verify:host` and `verify:settings`, and still have no usable page on the
 * desktop — which is exactly what happened. `verify:client` cannot catch it
 * either: its `configForms` stand-in answers with a namespace the real host would
 * never serve for this schema.
 *
 * The projection below is the shipped algorithm, replayed over the schema
 * envelope. It reads metadata only, so it works under either generation's
 * Schemastery — which is also why `volatileField` records the flag through
 * `extra()` when `.volatile()` is not there.
 *
 *   npm run verify:forms
 */
import assert from 'node:assert/strict'
import { DEFAULT_CONNECTION_ID } from '../src/contract.ts'
import { Config, SHARED_DEFAULTS, compositionEntry, readConfig } from '../src/settings.ts'
import type { Config as DatabaseConfig, ConfigRef } from '../src/settings.ts'
import type { ConnectionProfile } from '../src/contract.ts'

/** One node of a live schemastery schema, as the projection reads it. */
interface SchemaNode {
  type?: string
  meta?: { volatile?: boolean }
  dict?: Record<string, SchemaNode>
}

/**
 * Whether the host's form projection keeps one field.
 *
 * Mirrors `volatileForm` in `@deepseek-ai/dsh-settings`: a volatile node is kept
 * whole, an object is kept when any of its fields is, and every other node is
 * dropped. The field list this returns is therefore exactly what `describe()`
 * would send for the entry.
 *
 * The live schema is walked rather than `toJSON()`'s answer because that is what
 * the host does — the projection reads `meta.volatile` and `dict` off the schema
 * instance the plugin publishes, before any serialization happens.
 * @param node - one field's schema.
 * @returns whether a form is projected through it.
 */
function projectionKeeps(node: SchemaNode): boolean {
  if (node.meta?.volatile === true) return true
  if (node.type !== 'object') return false
  return Object.values(node.dict ?? {}).some(child => projectionKeeps(child))
}

/**
 * The top-level fields a 0.2.x host would project a form from.
 * @param root - the plugin Config schema.
 * @returns the projected field names, in schema order; empty means no page.
 */
function projectedFields(root: SchemaNode): string[] {
  if (root.meta?.volatile === true) return ['*']
  return Object
    .entries(root.dict ?? {})
    .filter(([, child]) => projectionKeeps(child))
    .map(([key]) => key)
}

const one: ConnectionProfile = { ...SHARED_DEFAULTS, id: 'alpha', name: 'alpha', dialect: 'mysql' }
const two: ConnectionProfile = { ...SHARED_DEFAULTS, id: 'beta', name: 'beta', dialect: 'mysql' }

// -- the shape the 0.2.x host reads --------------------------------------------
// An empty list here is the whole bug: the host serves no namespace, and every
// surface this plugin draws reports itself unavailable.
const envelope = Config as unknown as SchemaNode
const projected = projectedFields(envelope)
assert.ok(
  projected.length > 0,
  'a Config with no volatile field leaves the entry out of settings.describe() entirely',
)
assert.deepEqual(
  projected,
  ['connections', 'activeId'],
  'the entry projects a form of exactly the two fields the page edits',
)
// The flat composition fields must stay ordinary: they are a deployment's
// configuration, not something the page writes, and a form would offer them as
// editable duplicates of the saved connections.
for (const ordinary of ['host', 'port', 'user', 'database', 'dialect']) {
  assert.equal(
    projected.includes(ordinary),
    false,
    `the composition field "${ordinary}" is not offered to the page`,
  )
}
console.log(`forms: projected fields are ${projected.map(name => `"${name}"`).join(', ')}`)

// -- marking a field does not detach its own schema ----------------------------
// `extra()` answers with a copy, so this checks the copy still resolves the
// field's own validator: an element that would be refused anywhere else must be
// refused here too, and a valid one must survive parsing.
const parsed = Config({
  ...SHARED_DEFAULTS,
  connections: [one],
  activeId: 'alpha',
} as unknown as DatabaseConfig)
assert.equal(
  readConfig(parsed.connections)?.[0]?.name,
  'alpha',
  'a marked field still parses its elements',
)
assert.throws(
  () => Config({ ...SHARED_DEFAULTS, connections: [{ ...one, id: '' }], activeId: 'alpha' } as unknown as DatabaseConfig),
  'and still enforces the element schema it was built from',
)
assert.throws(
  () => Config({ ...SHARED_DEFAULTS, connections: [{ ...one, port: -1 }], activeId: 'alpha' } as unknown as DatabaseConfig),
  'including an element field whose own constraint is violated',
)

// -- generation 0.1.x: plain values ---------------------------------------------
// The older generation hands `apply()` the parsed Config, so the section is read
// straight off it. This path must not change: its deployments are still served.
const plain = {
  ...SHARED_DEFAULTS,
  connections: [one],
  activeId: 'alpha',
} as unknown as DatabaseConfig
assert.deepEqual(
  compositionEntry(plain).connections.map(profile => profile.id),
  ['alpha'],
  'a plain value is read as the section',
)

// -- generation 0.2.x: live references ------------------------------------------
// The newer generation hands over references. The read must happen per call: a
// second `apply()` never runs, so a captured section would freeze the page's
// writes out of every tool call from then on.
let current: readonly ConnectionProfile[] = [one]
let active = 'alpha'
const live = {
  ...plain,
  connections: { get: () => current } satisfies ConfigRef<readonly ConnectionProfile[] | undefined>,
  activeId: { get: () => active } satisfies ConfigRef<string>,
} as unknown as DatabaseConfig

assert.deepEqual(
  compositionEntry(live).connections.map(profile => profile.id),
  ['alpha'],
  'a live reference is read through its get()',
)

current = [one, two]
active = 'beta'
const moved = compositionEntry(live)
assert.deepEqual(
  moved.connections.map(profile => profile.id),
  ['alpha', 'beta'],
  'a write committed after apply() reaches the next read',
)
assert.equal(moved.activeId, 'beta', 'and the active id moves with it')

// The snapshot a reference returns is frozen, so the section handed out must be
// a copy: a caller that sorts or annotates it would otherwise throw.
const frozen = Object.freeze([Object.freeze({ ...one })])
const guarded = {
  ...plain,
  connections: { get: () => frozen } satisfies ConfigRef<readonly ConnectionProfile[] | undefined>,
  activeId: { get: () => 'alpha' } satisfies ConfigRef<string>,
} as unknown as DatabaseConfig
const section = compositionEntry(guarded)
assert.doesNotThrow(
  () => { section.connections.push(two) },
  'the section is a copy, not the frozen snapshot itself',
)

// -- the plain-value and absent-list paths still agree --------------------------
assert.equal(readConfig(7), 7, 'a plain value reads as itself')
assert.equal(readConfig({ get: () => 7 }), 7, 'a reference reads through get()')

const flat = { ...SHARED_DEFAULTS, connections: [], activeId: '' } as unknown as DatabaseConfig
const fellBack = compositionEntry(flat)
assert.equal(
  fellBack.connections.length,
  1,
  'a deployment with no saved list falls back to the flat composition connection',
)
assert.equal(fellBack.connections[0]?.id, DEFAULT_CONNECTION_ID, 'and that connection is the documented default')
console.log('forms: the live-reference, plain-value, and flat-fallback paths all resolve the section')
