/**
 * Build dialect packages into one ESM artifact each, the shape an installed
 * package is imported from.
 *
 * Usage:
 *   node scripts/build-dialects.mjs            build every package under dialects/
 *   node scripts/build-dialects.mjs dialects/mysql   build one
 *
 * Harness packages and each dialect's own driver stay external: they are
 * resolved from the deployment's install, never inlined into a dialect.
 * `dialects/_template` is skipped — it is a starting point, not a package.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Every directory under `dialects/` that holds a package, in name order. */
function dialectDirs() {
  const base = join(root, 'dialects')
  if (!existsSync(base)) return []
  return readdirSync(base, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('_'))
    .map(entry => join(base, entry.name))
    .filter(dir => existsSync(join(dir, 'package.json')))
}

/** Build one dialect package. */
async function buildDialect(dir) {
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  // A dialect's driver is its own dependency, so it is external here; the
  // plugin API is provided by the deployment that loads the dialect.
  await build({
    absWorkingDir: dir,
    entryPoints: ['src/index.ts'],
    outfile: 'lib/index.js',
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    external: [
      'dsh-ds-db',
      'dsh-ds-db/src/*',
      '@deepseek-ai/*',
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}).filter(name => name !== 'dsh-ds-db'),
    ],
    sourcemap: true,
    logLevel: 'info',
  })
}

const requested = process.argv[2] === undefined
  ? dialectDirs()
  : [resolve(root, process.argv[2])]

if (requested.length === 0) {
  console.log('no dialect packages to build')
}
for (const dir of requested) {
  console.log(`building dialect: ${basename(dir)}`)
  await buildDialect(dir)
}
