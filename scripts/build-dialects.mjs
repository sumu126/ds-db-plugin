/**
 * Build every dialect package by running that package's own build.
 *
 * Each dialect owns its build (`dialects/<name>/scripts/build.mjs`) because a
 * dialect is also installable straight from its own git repository: `prepare`
 * runs there, in a checkout with no parent plugin directory beside it, so the
 * build cannot live here. This script is the in-repo convenience that runs them
 * all in one step — it deliberately carries no esbuild configuration of its own,
 * which is what keeps the two paths from drifting.
 *
 * Usage:
 *   node scripts/build-dialects.mjs                  build every package under dialects/
 *   node scripts/build-dialects.mjs dialects/mysql   build one, relative to the caller
 *   cd dialects/mysql && npm run build               build this package ('.' is the caller's directory)
 *
 * `dialects/_template` is skipped — it is a starting point, not a package.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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
 * Without this check a wrong directory would report success for a package that
 * was never built, which is a silent way to ship nothing.
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
 * Build one dialect by running the build the package itself declares.
 * @param dir - the package directory, absolute.
 * @param manifest - its parsed manifest.
 * @throws {Error} when the package has no build of its own, or it fails.
 */
function buildDialect(dir, manifest) {
  const script = join(dir, 'scripts/build.mjs')
  if (!existsSync(script)) {
    throw new Error(
      `${manifest.name} has no scripts/build.mjs of its own. Every dialect owns its build so it can be `
      + 'installed straight from its own repository; copy the one in dialects/_template.',
    )
  }
  console.log(`building dialect: ${manifest.name}`)
  const run = spawnSync(process.execPath, [script], { cwd: dir, stdio: 'inherit' })
  if (run.status !== 0) {
    throw new Error(`${manifest.name} build failed with exit code ${String(run.status ?? 'signal')}`)
  }
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
  buildDialect(dir, readManifest(dir))
}