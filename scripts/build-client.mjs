/**
 * Build the browser half as a harness client bundle: a closure factory
 * registered on `window.__ModuleLoader__`, with every platform module resolved
 * through the module table the shell seeds.
 *
 * CSS goes through the same CSS Modules pipeline the shipped client packages
 * use (local names hashed, one injected style tag), so the page's class names
 * cannot collide with another plugin's.
 */
import { readFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { transform } from 'lightningcss'

/** Package id stamped into the module-table handoff and onto the injected style tag. */
const PACKAGE_ID = 'dsh-ds-db'

/**
 * Shared browser modules the shell seeds. A client bundle must never inline
 * one of these: the browser would then hold two copies of React or of the
 * slot registry.
 */
const PLATFORM_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Compile one stylesheet and emit the class map plus its one style injection. */
const cssModules = {
  name: 'dsh-css-modules',
  setup(build) {
    build.onResolve({ filter: /\.css$/ }, args => ({
      path: resolve(args.resolveDir, args.path),
      namespace: 'dsh-css',
    }))
    build.onLoad({ filter: /.*/, namespace: 'dsh-css' }, (args) => {
      const { code, exports } = transform({
        filename: args.path,
        code: readFileSync(args.path),
        cssModules: { pattern: '[hash]_[local]' },
        minify: true,
      })
      const classMap = Object.fromEntries(
        Object.entries(exports ?? {})
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
          .map(([local, entry]) => [local, entry.name]),
      )
      const tagId = `${PACKAGE_ID}/${basename(args.path)}`
      const contents = [
        `const css = ${JSON.stringify(code.toString())};`,
        `const tagId = ${JSON.stringify(tagId)};`,
        'if (typeof document !== \'undefined\' && document.querySelector(\'style[data-plugin-css=\' + JSON.stringify(tagId) + \']\') === null) {',
        '  const tag = document.createElement(\'style\');',
        `  tag.dataset.plugin = ${JSON.stringify(PACKAGE_ID)};`,
        '  tag.dataset.pluginCss = tagId;',
        '  tag.textContent = css;',
        '  document.head.appendChild(tag);',
        '}',
        `export default ${JSON.stringify(classMap)};`,
      ].join('\n')
      return { contents, loader: 'js' }
    })
  },
}

await build({
  absWorkingDir: root,
  entryPoints: { client: 'src/client/index.ts' },
  outfile: 'lib/client.js',
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2024',
  jsx: 'automatic',
  external: PLATFORM_MODULES,
  sourcemap: true,
  legalComments: 'none',
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [cssModules],
  banner: {
    js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_ID)}, factory: (require) => {\nvar module = { exports: {} }; var exports = module.exports;`,
  },
  footer: { js: 'return module.exports; } });' },
  logLevel: 'info',
})
