/**
 * Mirror `dialects/mysql` into its standalone release repository.
 *
 * This repository is the source of truth for every dialect. The standalone one
 * exists so the dialect can be installed on its own, and it is a *mirror*: this
 * script copies the tracked files over, deletes the ones that no longer exist
 * here, and commits the result tagged with the commit it came from — so the two
 * cannot drift without a commit saying so.
 *
 * Usage:
 *   node scripts/sync-dialect.mjs <mirror-dir> [--push] [--tag]
 *
 * <mirror-dir> is a checkout of the standalone repository; `DSH_DIALECT_MIRROR`
 * is read when the argument is absent. Nothing is pushed unless `--push` is
 * given, and no tag is written unless `--tag` is. The tag is `v<version>` from
 * the dialect's own manifest, and it is pushed without `--force`: moving a tag
 * that is already published is a decision for a person, not for a script.
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dialect = 'dialects/mysql'

/**
 * Files the mirror keeps for itself.
 *
 * They describe the mirror rather than the dialect (its ignore list, so a build
 * there does not dirty the worktree), so the source has no counterpart and the
 * sweep below must not delete them.
 */
const MIRROR_ONLY = new Set(['.gitignore'])

/**
 * Run git in a directory, returning stdout.
 * @param cwd - the directory to run in.
 * @param args - git arguments.
 * @returns the trimmed stdout.
 * @throws {Error} when git cannot start, or exits non-zero.
 */
function git(cwd, args) {
  const run = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (run.error !== undefined) throw new Error(`git ${args[0]} failed to start: ${run.error.message}`)
  if (run.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}:\n${(run.stderr ?? '').trim()}`)
  }
  return (run.stdout ?? '').trim()
}

/** Lines of a git command's stdout, newlines dropped. */
const lines = text => text.split(/\r?\n/).filter(line => line !== '')

const argv = process.argv.slice(2)
const flags = new Set(argv.filter(item => item.startsWith('--')))
const positional = argv.filter(item => !item.startsWith('--'))
const requested = positional[0] ?? process.env.DSH_DIALECT_MIRROR

if (requested === undefined || requested === '') {
  throw new Error(
    'no mirror directory: pass it as the first argument, or set DSH_DIALECT_MIRROR',
  )
}
const mirror = resolve(requested)
if (mirror === root || root.startsWith(`${mirror}\\`) || root.startsWith(`${mirror}/`)) {
  throw new Error(`the mirror must be a separate checkout, not ${mirror}`)
}
if (!existsSync(join(mirror, '.git'))) {
  throw new Error(`${mirror} is not a git checkout — clone the standalone repository there first`)
}

// The mirror records the commit it came from, so uncommitted dialect edits would
// make that record a lie: the files would be newer than the commit they claim.
const pending = git(root, ['status', '--porcelain', '--', dialect])
if (pending !== '') {
  throw new Error(`commit the dialect first — ${dialect} has uncommitted changes:\n${pending}`)
}

/** Relative path in the dialect directory to its absolute path here. */
const source = new Map(lines(git(root, ['ls-files', dialect]))
  .map(file => [file.slice(dialect.length + 1), join(root, file)]))

let copied = 0
for (const [relative, from] of source) {
  const to = join(mirror, relative)
  const current = existsSync(to) ? readFileSync(to) : undefined
  const wanted = readFileSync(from)
  if (current !== undefined && current.equals(wanted)) continue
  mkdirSync(dirname(to), { recursive: true })
  copyFileSync(from, to)
  copied += 1
}

const removed = []
for (const file of lines(git(mirror, ['ls-files']))) {
  if (source.has(file) || MIRROR_ONLY.has(file)) continue
  rmSync(join(mirror, file))
  removed.push(file)
}

if (git(mirror, ['status', '--porcelain']) === '') {
  console.log(`already in sync: ${copied} copied, ${removed.length} removed, nothing to commit`)
  process.exit(0)
}

git(mirror, ['add', '-A'])
const from = git(root, ['rev-parse', 'HEAD'])
const version = JSON.parse(readFileSync(join(mirror, 'package.json'), 'utf8')).version
git(mirror, ['commit', '-m', [
  `sync from ds-db-plugin@${from.slice(0, 7)}`,
  '',
  `Mirror of \`${dialect}\` in ds-db-plugin. That repository is the source of truth;`,
  'this one exists so the dialect installs on its own, without the plugin repo.',
  '',
  `Copied ${String(copied)}, removed ${String(removed.length)}.`,
].join('\n')])

const branch = git(mirror, ['branch', '--show-current'])
console.log(`synced ${dialect} -> ${mirror}`)
console.log(`  copied ${String(copied)}, removed ${String(removed.length)}`)
console.log(`  commit ${git(mirror, ['rev-parse', 'HEAD']).slice(0, 7)} on ${branch}`)

if (flags.has('--tag')) {
  git(mirror, ['tag', '-f', `v${version}`])
  console.log(`  tag    v${version}`)
}
if (flags.has('--push')) {
  git(mirror, ['push', 'origin', branch])
  console.log(`  pushed ${branch}`)
  if (flags.has('--tag')) {
    git(mirror, ['push', 'origin', `v${version}`])
    console.log(`  pushed v${version}`)
  }
} else {
  console.log('  (not pushed — pass --push to push; --tag writes v<version> first)')
}
