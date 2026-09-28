/**
 * Build the Node half into the ESM artifacts the harness loader imports from an
 * installed package: the plugin itself, and the dialect-author API a separately
 * installed dialect package imports. Harness packages and the driver stay
 * external, and inlining our own modules keeps the artifacts free of relative
 * `.ts` imports — a dialect that reached this package's TypeScript source would
 * not load under the deployed `dsh`.
 */
import { build } from 'esbuild'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

await build({
  absWorkingDir: root,
  entryPoints: { index: 'src/index.ts', 'dialect-api': 'src/dialect-api.ts' },
  outdir: 'lib',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  // The harness resolves these from its own install, and the driver is the
  // deployment's dependency; nothing else may be inlined into a host half.
  external: ['mysql2', 'mysql2/promise', '@deepseek-ai/*'],
  sourcemap: true,
  logLevel: 'info',
})
