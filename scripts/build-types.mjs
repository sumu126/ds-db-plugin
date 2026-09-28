/**
 * Emit the package's type declarations — when this machine can.
 *
 * `tsconfig.emit.json` resolves the host's `@deepseek-ai/*` types through
 * `paths` pointing at a sibling `../deepseek-harness` checkout, which is the
 * documented development convention. A consumer installing this repository
 * from git runs `prepare` → `npm run build` in a directory with no such
 * sibling, and the type pass would fail with a flood of TS2307s while the
 * three esbuild passes beside it need no types at all — they keep every
 * `@deepseek-ai/*` import external.
 *
 * So the type pass is the one build step that is dev-only, and it runs only
 * when the harness is there AND built (its emitted `.d.ts` files exist);
 * anywhere else it is skipped with a visible line, and the build still
 * produces everything a deployment loads.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const harness = resolve(root, '../deepseek-harness')
// One representative of the type surface the tsconfig paths name: if the
// harness checkout exists but was never built, these files are absent and
// tsc would fail exactly the way an unbuilt sibling breaks `typecheck`.
const harnessTypes = join(harness, 'vendor/cordis/lib/types/index.d.ts')

if (!existsSync(harnessTypes)) {
  console.log('skipping type declarations: no built ../deepseek-harness beside this checkout (dev-only artifact)')
  process.exit(0)
}

const require = createRequire(import.meta.url)
const tsc = require.resolve('typescript/bin/tsc')
const run = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.emit.json'], { cwd: root, stdio: 'inherit' })
process.exit(run.status ?? 1)
