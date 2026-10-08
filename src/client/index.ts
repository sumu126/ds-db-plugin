/**
 * Browser half of the database plugin: it registers the connection settings
 * page, and the page's data — the settings scope, the credential control, and
 * the connection probe — reaches it through this plugin's inject face.
 *
 * @module dsh-ds-db/src/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the renderer's Context merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the ctx.remote merge (the generated remote namespaces).
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the right sidebar's Context merge (ctx.sidebarRightTabs) and
// the tab seats this panel registers into.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { DbPageFace, DbProbe } from './form.ts'
import { DatabaseSettingsController, type DbCredentialsFace } from './form.ts'
import { DatabaseSettingsPage } from './DatabaseSettingsPage.tsx'
import type { BrowseReads, CatalogAnswer, DbBrowseFace } from './browse.ts'
import { DatabaseBrowseController } from './browse.ts'
import { DatabaseCatalogPanel, DatabaseCatalogTitle, DbPanelIcon } from './DatabaseCatalogPanel.tsx'
import {
  DB_COLUMNS_PATH, DB_DATABASES_PATH, DB_DIALECTS_PATH, DB_SETTINGS_NAMESPACE, DB_TABLES_PATH, DB_TEST_PATH,
  type ColumnNode, type ConnectionProfile, type DatabaseNode, type DatabaseSettings, type DialectCatalog,
  type DialectDescriptor, type ProbeRequest, type TableNode,
} from '../contract.ts'

import { en, zh, type DbLocaleKey } from './locales.ts'
import { TOOL_NS, en as toolEn, zh as toolZh, type ToolLocaleKey } from './tool-locales.ts'
import { registerToolRows } from './DbToolRows.tsx'

// Type-only: pulls the Tool layer's SlotMap merge (the 'tool.call.toolview' entry).
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Copy of the database settings page. */
    'settings.db': DbLocaleKey
    /** Copy of the tool-call rows this plugin draws. */
    'tool.db': ToolLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'settings.db'

/** Required services (cordis fiber inject). */
export const inject = [
  'slots', 'locale', 'remote', 'remote.credentials', 'settingsScope', 'sidebarRightTabs',
]

/** Identity of the right-sidebar tab type this plugin contributes, and of its body. */
const TAB_ID = 'dsh-ds-db'

/** Kind the panel is opened by; also the guide card's own id. */
const TAB_KIND = 'database'

/**
 * Register the database settings page.
 * @param ctx - browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-ds-db: copy dictionaries')
  ctx.effect(() => ctx.locale.register(TOOL_NS, { zh: toolZh, en: toolEn }), 'dsh-ds-db: tool row copy')

  const scope = ctx.settingsScope.bind<DatabaseSettings>({ namespace: DB_SETTINGS_NAMESPACE })
  const credentials: DbCredentialsFace = {
    // A refused describe is reported as "nothing stored, still writable": the
    // control stays usable and the Host is what refuses, rather than the page
    // guessing a refusal it did not receive.
    describe: async (ref) => {
      const response = await ctx.remote.credentials.describe([ref])
      if (!response.ok) return { configured: false, writable: true }
      const view = response.value[ref]
      return { configured: view?.configured ?? false, writable: view?.writable ?? true }
    },
    set: async (ref, value) => { await ctx.remote.credentials.set(ref, value) },
  }
  const t = ctx.locale.bind(NS)
  const controller = new DatabaseSettingsController(
    scope,
    credentials,
    request => probeConnection(request, t),
    loadCatalog,
  )

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: DB_SETTINGS_NAMESPACE,
    // After the shipped sections (General 0, Models 10, Plugins 15), so a
    // deployment's own page never pushes the built-in ones around.
    order: 40,
    label: () => t('nav'),
    locale: NS,
    inject: (): DbPageFace => ({ hooks: { dbPage: controller.snapshot }, ...controller.actions() }),
  }, DatabaseSettingsPage))

  // The rows live on the same client entry as the page: the slot is keyed by wire
  // tool name, so nothing else has to be told which tools this plugin registers.
  registerToolRows(ctx)

  // The browser catalog: another view over the same settings namespace, reading
  // the same three queries the listing tools run, on their own routes.
  const browse = new DatabaseBrowseController(
    ctx.settingsScope.bind<DatabaseSettings>({ namespace: DB_SETTINGS_NAMESPACE }),
    browseReads(t),
  )
  ctx.effect(() => () => { browse.dispose() }, 'dsh-ds-db: browser catalog reads')

  // A page type has one way in: the strip's add control opens the guide, and a
  // card there is how a user reaches a type the session has never opened.
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: TAB_ID,
    kind: TAB_KIND,
    title: () => t('panelTitle'),
    guide: [{
      id: TAB_KIND,
      order: 40,
      title: () => t('panelTitle'),
      description: () => t('guideEntryHint'),
      icon: DbPanelIcon,
    }],
  }), 'dsh-ds-db: browser catalog type')

  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab', key: TAB_ID, locale: NS,
    inject: (): DbBrowseFace => browse.face(),
  }, DatabaseCatalogPanel)), 'dsh-ds-db: browser catalog body')

  // Registered so the chip follows a language switch; without it the chip keeps
  // the title the registry captured when the tab opened.
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab.title', key: TAB_ID, locale: NS,
    inject: (): DbBrowseFace => browse.face(),
  }, DatabaseCatalogTitle)), 'dsh-ds-db: browser catalog title')
}

/**
 * Read the database types the page may offer over the plugin's own route.
 *
 * A plain `fetch` rather than `ctx.remote.<ns>.<method>()`: the remote surface
 * comes from a generator this repository does not run, so the two endpoints are
 * HTTP routes on the authenticated `/api` channel (see the README's known
 * limitations). The consequence is visible right below — the answer is
 * completed field by field instead of arriving as a generated type.
 *
 * @returns the catalog; a transport failure yields an empty one, which the
 * chooser renders as nothing to pick rather than a broken dialog.
 */
async function loadCatalog(): Promise<DialectCatalog> {
  try {
    const response = await fetch(DB_DIALECTS_PATH, { method: 'GET' })
    if (!response.ok) return { installed: [], known: [] }
    const payload = await response.json() as Partial<DialectCatalog>
    return {
      // Every descriptor is completed here, so the page never reads a field a
      // Host of another version did not send.
      installed: (payload.installed ?? []).map(completeDescriptor),
      known: payload.known ?? [],
    }
  } catch {
    return { installed: [], known: [] }
  }
}

/**
 * One descriptor with the fields a Host may not have sent filled in.
 *
 * The parameter is honest about that: the route's answer is trusted for the one
 * field a descriptor cannot do without, and every other field is filled here.
 * @param entry - what the catalog route answered with.
 * @returns a descriptor the page can read without guarding every field.
 */
function completeDescriptor(entry: Partial<DialectDescriptor> & { name: string }): DialectDescriptor {
  return {
    name: entry.name,
    label: entry.label ?? entry.name,
    ...entry.description === undefined ? {} : { description: entry.description },
    capabilities: entry.capabilities ?? [],
    configFields: entry.configFields ?? [],
    connectionDefaults: entry.connectionDefaults ?? {},
    systemDatabases: entry.systemDatabases ?? [],
  }
}

/**
 * One locale key and the values its placeholders take.
 *
 * A structural alias of the harness translate seat, so this module names no
 * extra harness type to call it.
 * @param key - dictionary key of the page's copy.
 * @param params - values substituted into the template's placeholders.
 * @returns the copy for the active locale.
 */
type Translate = (key: DbLocaleKey, params?: Record<string, string>) => string

/** The payload field carrying each catalog route's rows. */
type CatalogField = 'databases' | 'tables' | 'columns'

/**
 * The browser catalog's three reads, each on this plugin's own authenticated route.
 * @param t - the page's translate seat, for the copy a transport failure shows.
 * @returns the reads the panel makes.
 */
function browseReads(t: Translate): BrowseReads {
  return {
    databases: (connection, signal) =>
      readCatalog<DatabaseNode>(DB_DATABASES_PATH, { connection }, 'databases', signal, t),
    tables: (connection, database, signal) =>
      readCatalog<TableNode>(DB_TABLES_PATH, { connection, database }, 'tables', signal, t),
    columns: (connection, database, table, signal) =>
      readCatalog<ColumnNode>(DB_COLUMNS_PATH, { connection, database, table }, 'columns', signal, t),
  }
}

/**
 * Read one catalog listing over this plugin's own authenticated API route.
 *
 * A plain `fetch` for the reason the probe uses one: the remote surface comes
 * from a generator this repository does not run, so the payloads are written out
 * in `contract.ts`. A transport failure is an answer rather than a throw — the
 * panel shows the sentence beside a retry either way.
 * @param path - the route to read.
 * @param query - the names the route addresses; an empty value is left out.
 * @param field - the payload field carrying the rows.
 * @param signal - cancellation, so a panel that closed stops waiting.
 * @param t - the page's translate seat, for the copy this module owns.
 * @returns the rows, or the sentence the panel renders in their place.
 */
async function readCatalog<T>(
  path: string,
  query: Record<string, string>,
  field: CatalogField,
  signal: AbortSignal,
  t: Translate,
): Promise<CatalogAnswer<T>> {
  try {
    const url = new URL(path, window.location.origin)
    for (const [key, value] of Object.entries(query)) {
      if (value.length > 0) url.searchParams.set(key, value)
    }
    const response = await fetch(url, { method: 'GET', signal })
    if (!response.ok) return { rows: [], message: t('httpStatus', { status: String(response.status) }) }
    const payload = await response.json() as Record<string, unknown> & { message?: string }
    if (payload.message !== undefined) return { rows: [], message: payload.message }
    // The route answers one field per level, named by the contract it is written
    // against; an answer missing it is an empty list rather than a broken panel.
    return { rows: (payload[field] ?? []) as T[] }
  } catch (error: unknown) {
    return { rows: [], message: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Probe a connection over the plugin's own authenticated API route: an
 * unsaved draft, a saved id, or the connection the tools currently address.
 *
 * The refusal text a probe reports is copy the user reads, so the two parts
 * this module writes — the status line and the no-reason fallback — come from
 * the dictionary; a message the Host wrote is passed through as data.
 * @param request - what the page asks the Host to probe.
 * @param t - the page's translate seat, for the copy this module owns.
 * @returns the probe outcome; a transport failure is a failed probe, not a throw.
 */
async function probeConnection(request: ProbeRequest, t: Translate): Promise<DbProbe> {
  const body: { id?: string, profile?: ConnectionProfile } = {}
  if (request.id !== undefined) body.id = request.id
  if (request.profile !== undefined) body.profile = request.profile
  try {
    const response = await fetch(DB_TEST_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!response.ok) return { status: 'failed', message: t('httpStatus', { status: String(response.status) }) }
    const payload = await response.json() as { ok?: unknown; version?: unknown; latencyMs?: unknown; message?: unknown }
    if (payload.ok === true && typeof payload.version === 'string') {
      return {
        status: 'ok',
        version: payload.version,
        latencyMs: typeof payload.latencyMs === 'number' ? payload.latencyMs : 0,
      }
    }
    return { status: 'failed', message: typeof payload.message === 'string' ? payload.message : t('noMessage') }
  } catch (error: unknown) {
    return { status: 'failed', message: error instanceof Error ? error.message : String(error) }
  }
}
