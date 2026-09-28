/**
 * Install-smoke probe: mounted by a `--patch` overlay on top of a profile whose
 * bundles were installed from packed tarballs. It samples after the composition
 * has settled, reports what the installed artifacts produced, and exits so the
 * launcher boot terminates by itself.
 *
 *   node scripts/dev-overlay.mjs                     # writes .dev/install-probe.yml
 *   dsh --profile <name> --patch .dev/install-probe.yml
 */
export const name = 'install-probe'

export const inject = ['loader', 'tools', 'databaseDialects']

export function apply(ctx) {
  setTimeout(() => {
    const dialects = ctx.databaseDialects.names()
    const tools = ['db_connections', 'db_query', 'db_tables', 'db_databases']
      .filter(name => ctx.tools.get(name) !== undefined)
    // The configured `dialect: mysql` reached the model-facing text, which only
    // happens once the dialect package registered itself.
    const tableTool = ctx.tools.get('db_tables')
    const fact = tableTool?.parameters?.properties?.connection?.description ?? ''
    console.log(`INSTALL-PROBE dialects=${JSON.stringify(dialects)} tools=${JSON.stringify(tools)}`)
    console.log(`INSTALL-PROBE tableTool=${tableTool === undefined ? 'missing' : 'registered'} connectionParam=${JSON.stringify(fact.slice(0, 60))}`)
    const ok = dialects.length === 1 && dialects[0] === 'mysql' && tools.length === 4 && tableTool !== undefined
    process.exit(ok ? 0 : 1)
  }, 1500)
}
