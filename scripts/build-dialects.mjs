/**
 * Build dialect packages into one ESM artifact each, the shape an installed
 * package is imported from.
 *
 * Usage:
 *   node scripts/build-dialects.mjs                  build every package under dialects/
 *   node scripts/build-dialects.mjs dialects/mysql   build one, relative to the caller
 *   cd dialects/mysql && npm run build               build this package ('.' is the caller's directory)
 *
 * Harness packages and each dialect's own driver stay external: they are
 * resolved from the deployment's install, never inlined into a dialect.
 * `dialects/_template` is skipped — it is a starting point, not a package.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
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

/**
 * Read one package's manifest, refusing a directory that is not one.
 *
 * Without this check a wrong directory would build the plugin's own entry into
 * a dialect's artifact and report success, which is a silent way to ship the
 * wrong file.
 * @param dir - the package directory, absolute.
 * @returns the parsed manifest.
 * @throws {Error} when the directory holds no dialect entry point.
 */
function readManifest(dir) {
  if (!existsSync(join(dir, 'src/index.ts'))) {
    throw new Error(`not a dialect package: ${dir} has no src/index.ts`)
  }
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
}

/**
 * Build one dialect package.
 * @param dir - the package directory, absolute.
 * @param manifest - its parsed manifest.
 */
async function buildDialect(dir, manifest) {
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

// A relative argument resolves against the caller, so the two documented ways to
// build one package — `npm run build` inside it, and a path from the plugin
// root — both name the directory the caller meant.
const requested = process.argv[2] === undefined
  ? dialectDirs()
  : [resolve(process.cwd(), process.argv[2])]

if (requested.length === 0) {
  console.log('no dialect packages to build')
}
for (const dir of requested) {
  const manifest = readManifest(dir)
  console.log(`building dialect: ${manifest.name}`)
  await buildDialect(dir, manifest)
}
