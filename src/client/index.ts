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
import type { DbPageFace, DbProbe } from './form.ts'
import { DatabaseSettingsController, type DbCredentialsFace } from './form.ts'
import { DatabaseSettingsPage } from './DatabaseSettingsPage.tsx'
import {
  DB_DIALECTS_PATH, DB_SETTINGS_NAMESPACE, DB_TEST_PATH,
  type ConnectionProfile, type DatabaseSettings, type DialectCatalog, type DialectDescriptor, type ProbeRequest,
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
  'slots', 'locale', 'remote', 'remote.credentials', 'settingsScope',
]

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
  const controller = new DatabaseSettingsController(scope, credentials, probeConnection, loadCatalog)
  const t = ctx.locale.bind(NS)

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
 * Probe a connection over the plugin's own authenticated API route: an
 * unsaved draft, a saved id, or the connection the tools currently address.
 * @param request - what the page asks the Host to probe.
 * @returns the probe outcome; a transport failure is a failed probe, not a throw.
 */
async function probeConnection(request: ProbeRequest): Promise<DbProbe> {
  const body: { id?: string, profile?: ConnectionProfile } = {}
  if (request.id !== undefined) body.id = request.id
  if (request.profile !== undefined) body.profile = request.profile
  try {
    const response = await fetch(DB_TEST_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!response.ok) return { status: 'failed', message: `HTTP ${String(response.status)}` }
    const payload = await response.json() as { ok?: unknown; version?: unknown; latencyMs?: unknown; message?: unknown }
    if (payload.ok === true && typeof payload.version === 'string') {
      return {
        status: 'ok',
        version: payload.version,
        latencyMs: typeof payload.latencyMs === 'number' ? payload.latencyMs : 0,
      }
    }
    return { status: 'failed', message: typeof payload.message === 'string' ? payload.message : 'no message' }
  } catch (error: unknown) {
    return { status: 'failed', message: error instanceof Error ? error.message : String(error) }
  }
}
