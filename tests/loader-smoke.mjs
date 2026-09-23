/**
 * Composition smoke through the real Loader.
 *
 * The two verify scripts assemble a `Context` by hand, which is enough to test
 * behaviour but not the composition: a row that the Loader cannot resolve, an
 * activation order that starves an injection, or a plugin that never reaches the
 * tool registry would all pass there. This check loads a `cordis.yml` the way a
 * deployment does — beside a throwaway `DSH_HOME` whose settings document holds
 * two connections — and asserts what a model ends up with.
 *
 *   npm run verify:loader
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import SettingsFile from '@deepseek-ai/dsh-settings-file'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const asUrl = relative => pathToFileURL(resolve(root, relative)).href

/** The settings document the throwaway home holds: two connections, one active. */
const SETTINGS_DOCUMENT = [
  'ds-db:',
  '  connections:',
  '    - id: primary',
  '      name: 主库',
  '      dialect: mysql',
  '      extra: {}',
  '      host: 10.0.0.1',
  '      port: 3306',
  '      user: reader',
  '      database: app',
  '      passwordEnv: PRIMARY_PASSWORD',
  '      connectTimeoutMs: 10000',
  '      queryTimeoutMs: 30000',
  '      maxRows: 200',
  '    - id: reporting',
  '      name: 报表库',
  '      dialect: mysql',
  '      extra: {}',
  '      host: 10.0.0.2',
  '      port: 3307',
  '      user: reader',
  '      database: reports',
  '      passwordEnv: REPORTING_PASSWORD',
  '      connectTimeoutMs: 10000',
  '      queryTimeoutMs: 30000',
  '      maxRows: 200',
  '  activeId: reporting',
  '',
].join('\n')

const home = await mkdtemp(join(tmpdir(), 'ds-db-loader-'))
await writeFile(join(home, 'settings.yaml'), SETTINGS_DOCUMENT)
process.env.DSH_HOME = home

const configPath = join(home, 'cordis.yml')
await writeFile(configPath, [
  "- name: '@deepseek-ai/dsh-system-prompt'",
  '- name: \'@deepseek-ai/dsh-tools\'',
  '  config:',
  '    mode: native',
  '    maxParallelSubCalls: 1',
  "- name: '@deepseek-ai/dsh-settings-file'",
  `- name: '${asUrl('dialects/mysql/src/index.ts')}'`,
  `- name: '${asUrl('src/index.ts')}'`,
  '',
].join('\n'))

const modules = new Map([
  ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
  ['@deepseek-ai/dsh-tools', ToolRuntime],
  ['@deepseek-ai/dsh-settings-file', SettingsFile],
])

const ctx = new Context()
ctx.baseUrl = pathToFileURL(home).href + '/'
await ctx.plugin(Loader)
ctx.loader.builtins.include = Include
// `loader.internal` is the Loader's own module-resolution seam, and its shape
// (`{ version, import }`) belongs to the harness: this stand-in follows whatever
// generation the Loader in use declares, so a harness upgrade can require an
// update here. It replaces only the three harness services the composition
// names; this repository's two rows are resolved by their file URLs.
ctx.loader.internal = {
  version: 'v2',
  // The harness packages are reached by name; the two rows this repository ships
  // are reached by their own file URLs, which is how a patch overlay mounts a
  // checkout.
  async import(specifier) {
    const known = modules.get(specifier)
    if (known !== undefined) return known
    return await import(specifier)
  },
}
await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
await ctx.loader.await()

for (let attempt = 0; attempt < 300 && ctx.tools.get('db_connections') === undefined; attempt++) {
  await new Promise(resolve => setTimeout(resolve, 10))
}

// 1. The tools exist, which means the dialect row and the plugin row both
//    activated and the registry reached the tool face.
assert.ok(ctx.tools.get('db_connections'), 'db_connections is registered through the Loader')
assert.ok(ctx.tools.get('db_query'), 'db_query is registered through the Loader')
console.log(`tools: ${['db_connections', 'db_query', 'db_tables'].filter(name => ctx.tools.get(name) !== undefined).join(', ')}`)

// 2. What the user saved is what a tool addresses — the check that fails when the
//    plugin reads the composition entry instead of the settings source.
const listed = await ctx.tools.get('db_connections').execute({}, { signal: new AbortController().signal })
assert.equal(listed.connections.length, 2, 'both saved connections are visible')
assert.deepEqual(listed.connections.map(connection => connection.name), ['主库', '报表库'])
assert.equal(listed.active, '报表库', 'the document names the default connection')
console.log(`connections: ${listed.connections.map(connection => `${connection.name}@${connection.host}:${connection.port}`).join(', ')}`)

// 3. Unloading the tree takes the tools with it: the registry is a service of
//    the disposed tree, so its tools go with it.
await ctx.fiber.dispose()
for (let attempt = 0; attempt < 200 && ctx.tools !== undefined; attempt++) {
  await new Promise(resolve => setTimeout(resolve, 10))
}
assert.equal(ctx.tools, undefined, 'the tool registry is gone after unload, so its tools are too')
console.log('unload: the tool registry is gone')

await rm(home, { recursive: true, force: true })
console.log('loader smoke passed')
process.exit(0)
