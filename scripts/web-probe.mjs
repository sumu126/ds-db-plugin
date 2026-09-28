/**
 * Client-half probe over a live `dsh web` server.
 *
 * It reads the boot payload the page carries (`globalThis["__DSH_BOOT__"]`),
 * then fetches the bundle the module registry serves for this plugin and
 * materializes it the way the page does: a stub `window.__ModuleLoader__`
 * captures the lazy-CJS registration, and the factory runs with a module table
 * containing only the baseline modules the shell seeds. That proves the delivery
 * path end to end — scan, graph row, served artifact, registration, factory —
 * and that the bundle exports the cordis plugin shape. It cannot prove how the
 * React components paint; that needs a browser.
 *
 *   pnpm run build                                  # the probe reads the built bundle
 *   node scripts/dev-overlay.mjs                    # writes .dev/built.yml
 *   pnpm dsh --profile web --patch .dev/built.yml --port 3099 --no-open
 *   node scripts/web-probe.mjs http://127.0.0.1:3099 <launch-token>
 *
 * The token is the one `dsh web` prints in its startup URL. Without it the
 * server answers 401 on `/` and there is no boot payload to read. Start the
 * server with the source launcher (`pnpm dsh` from the harness checkout): the
 * installed CLI cannot mount the `file://` rows a development overlay names.
 */
const origin = process.argv[2] ?? 'http://127.0.0.1:3099'
const launchToken = process.argv[3] ?? process.env.DSH_WEB_TOKEN
const pluginId = 'dsh-ds-db'

/** Fail loudly with the reason, so a probe run is never ambiguous. */
function fail(message) {
  console.error(`WEB-PROBE FAIL: ${message}`)
  process.exit(1)
}

// The page is fenced behind a browser-session cookie and the launch token mints
// it; every later request then carries it, exactly as the page's own does after
// the launcher opens the tokenized URL.
if (launchToken !== undefined && launchToken.length > 0) {
  const minted = await fetch(`${origin}/?token=${encodeURIComponent(launchToken)}`, { redirect: 'manual' })
  const cookie = (minted.headers.getSetCookie?.() ?? []).map(value => value.split(';')[0]).join('; ')
  if (cookie.length === 0) fail(`the token minted no session cookie (status ${minted.status})`)
  const native = globalThis.fetch
  globalThis.fetch = (input, init = {}) => {
    const headers = new Headers(init.headers ?? undefined)
    headers.set('cookie', cookie)
    return native(input, { ...init, headers })
  }
  console.log(`WEB-PROBE session: cookie minted (status ${minted.status})`)
}

const pageResponse = await fetch(`${origin}/`)
if (pageResponse.status === 401) {
  fail('the server answered 401 on /: pass the launch token as the second argument')
}
const page = await pageResponse.text()
const boot = /globalThis\["__DSH_BOOT__"\]\s*=\s*(\{.*?\});?\s*<\/script>/s.exec(page)
if (boot === null) fail('the served page carries no boot payload (globalThis["__DSH_BOOT__"])')
const graph = JSON.parse(boot[1])
const entry = graph.entries.find(row => row.id === pluginId)
if (entry === undefined) fail(`the boot graph has no entry for ${pluginId} (entries: ${graph.entries.map(r => r.id).join(', ')})`)
console.log(`WEB-PROBE graph row: ${JSON.stringify({ id: entry.id, inject: entry.inject, rev: entry.rev })}`)

const bundleUrl = new URL(entry.url, origin).href
const bundle = await fetch(bundleUrl).then(async response => ({
  status: response.status,
  type: response.headers.get('content-type'),
  text: await response.text(),
}))
if (bundle.status !== 200) fail(`the registry answered ${bundle.status} for ${bundleUrl}`)
if (!bundle.text.startsWith('window.__ModuleLoader__.load({')) {
  fail(`the served artifact does not open with the module-loader registration: ${bundle.text.slice(0, 80)}`)
}
console.log(`WEB-PROBE served bundle: ${bundle.text.length} bytes, ${bundle.type}`)

// The batch that carries this row is what the page actually requests first.
const batch = graph.batches.find(candidate => candidate.entries.includes(pluginId))
if (batch === undefined) fail(`no initial-load batch carries ${pluginId}`)
const comboUrl = new URL(batch.url, origin).href
const combo = await fetch(comboUrl).then(response => response.text())
if (!combo.includes(pluginId)) fail(`the combo script for ${batch.phase} does not carry ${pluginId}`)
console.log(`WEB-PROBE combo (${batch.phase}): ${combo.length} bytes, carries the row`)

// Materialize the bundle the way the page does.
let registration
const injected = []
const styles = []
const documentStub = {
  querySelector: selector => styles.find(tag => selector.includes(tag.dataset.pluginCss)) ?? null,
  createElement: () => ({ dataset: {} }),
  head: {
    appendChild: (tag) => {
      tag.dataset.pluginCss = tag.dataset.pluginCss ?? `injected-${String(styles.length)}`
      styles.push(tag)
      injected.push(tag.textContent)
    },
  },
}
globalThis.window = { __ModuleLoader__: { load: (value) => { registration = value } } }
globalThis.document = documentStub
const baseline = {
  react: { useState: () => [undefined, () => {}], createElement: () => null, useRef: () => ({}), useEffect: () => {} },
  'react/jsx-runtime': { jsx: () => null, jsxs: () => null },
  'react-dom': {},
  'react-dom/client': {},
  '@deepseek-ai/cordis': {},
  '@deepseek-ai/dsh-client-store': { createSnapshotStore: (initial) => ({ getSnapshot: () => initial, subscribe: () => () => {} }) },
  '@deepseek-ai/dsh-client-ui-slots': {},
  '@deepseek-ai/dsh-client-ui-primitives': { Button: () => null },
  '@deepseek-ai/dsh-client-ui-dockkit': {},
}
const requireStub = (specifier) => {
  if (!(specifier in baseline)) fail(`the bundle requires "${specifier}", which the module table does not seed`)
  return baseline[specifier]
}
new Function('window', 'document', 'require', bundle.text)(globalThis.window, documentStub, requireStub)
if (registration === undefined) fail('executing the bundle registered no factory')
if (registration.id !== pluginId) fail(`the factory registers as "${registration.id}", not "${pluginId}"`)
const exports = registration.factory(requireStub)
if (typeof exports.apply !== 'function') fail('the materialized bundle exports no apply()')
if (!Array.isArray(exports.inject)) fail('the materialized bundle exports no inject array')
console.log(`WEB-PROBE materialized: apply=${typeof exports.apply} inject=${JSON.stringify(exports.inject)}`)
console.log(`WEB-PROBE css injected at materialization: ${injected.length} style tag(s)`)
if (injected.length === 0) fail('materializing the bundle injected no CSS')

// The page's own probe route must exist on the authenticated channel: anything
// but 404 means the route is registered.
const route = await fetch(`${origin}/api/ds-db/dialects`)
if (route.status === 404) fail('GET /api/ds-db/dialects is 404, so the route is not registered')
console.log(`WEB-PROBE route: GET /api/ds-db/dialects -> ${route.status} (not 404, so it is registered)`)
console.log('WEB-PROBE passed')
process.exit(0)
