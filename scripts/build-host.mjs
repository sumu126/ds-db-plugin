/**
 * Build the Node half into one ESM artifact the harness loader can import from
 * an installed package: harness packages and the driver stay external, and
 * inlining our own modules keeps the artifact free of relative `.ts` imports.
 */
import { build } from 'esbuild'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

await build({
  absWorkingDir: root,
  entryPoints: ['src/index.ts'],
  outfile: 'lib/index.js',
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
