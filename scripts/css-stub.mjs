/**
 * A `node:module` loader hook that resolves a stylesheet import to an empty
 * module object.
 *
 * The client half statically imports its `.module.css` files beside the classes
 * they name, which is what gives the class map its types. A plain Node check
 * cannot load a stylesheet, and this check exists to run `apply` — so the hook
 * stands in for the build's CSS Modules pipeline and nothing else: the client
 * source under test is otherwise untouched.
 *
 * Registered by `scripts/verify-client.mjs` through `module.registerHooks`.
 * @module dsh-ds-db/scripts/css-stub
 */

/** Marker the hook returns for a stylesheet. */
const EMPTY = 'export default {}'

/**
 * Claim every `.css` specifier and hand back an empty class map.
 * @param specifier - the import specifier as written.
 * @param context - the resolution context, unused.
 * @param nextResolve - the next resolver in the chain.
 * @returns the stub module for a stylesheet, otherwise the chain's own answer.
 */
export function resolve(specifier, context, nextResolve) {
  if (!specifier.endsWith('.css')) return nextResolve(specifier, context)
  return { url: `css-stub:${specifier}`, shortCircuit: true }
}

/**
 * Serve the stub source for a claimed stylesheet.
 * @param url - the resolved URL.
 * @param context - the load context, unused.
 * @param nextLoad - the next loader in the chain.
 * @returns the stub module source, otherwise the chain's own answer.
 */
export function load(url, context, nextLoad) {
  if (!url.startsWith('css-stub:')) return nextLoad(url, context)
  return { format: 'module', source: EMPTY, shortCircuit: true }
}
