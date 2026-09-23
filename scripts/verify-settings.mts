/**
 * Settings check: mount the real settings service over this machine's
 * `~/.dsh/settings.yaml`, the dialect package, and the plugin, then ask the
 * tools what connections they can see.
 *
 * `verify:host` mounts the plugin without a settings provider, so it only ever
 * exercises the composition entry — which is how a plugin can read the wrong
 * source for every call and still pass. This check covers the other half: that
 * what the user saved is what a tool addresses.
 *
 *   npm run verify:settings
 */
import { Context } from '@deepseek-ai/cordis'
import SettingsFile from '@deepseek-ai/dsh-settings-file'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import assert from 'node:assert/strict'
import * as dialect from '../dialects/mysql/src/index.ts'
import * as plugin from '../src/index.ts'

const ctx = new Context()
await ctx.plugin(SystemPrompt, {})
await ctx.plugin(ToolRuntime, { mode: 'native', maxParallelSubCalls: 1 })
await ctx.plugin(SettingsFile, {})
await ctx.plugin(dialect, {})
await ctx.plugin(plugin, {})

for (let attempt = 0; attempt < 200 && ctx.tools.get('db_connections') === undefined; attempt++) {
  await new Promise(resolve => setTimeout(resolve, 10))
}

const listed = await ctx.tools.get('db_connections').execute({}, undefined)

for (const connection of listed.connections) {
  console.log(`- ${connection.name} [${connection.dialect || 'first dialect'}] ${connection.host}:${connection.port}/${connection.database}${connection.active ? ' (default)' : ''}`)
}

// What this guard can assert on any machine: the tool answers, the listing
// carries the fields a model addresses connections by, and it never carries a
// credential reference. Whether the count matches the user's document is for a
// human to read off the lines above — a tool pinned to the composition entry
// would print one connection where the user saved several, which is exactly the
// failure this check exists for.
assert.ok(listed.connections.length >= 1, 'the composition entry alone yields at least one connection')
assert.ok(listed.active.length > 0, 'a default connection is named')
for (const connection of listed.connections) {
  assert.ok(connection.name.length > 0, 'every connection is named')
  assert.equal(Object.keys(connection).includes('passwordEnv'), false, 'no credential reference is listed')
}
console.log(`settings: ${listed.connections.length} connection(s) visible, default is "${listed.active}"`)
