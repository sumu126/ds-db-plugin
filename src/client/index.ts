/**
 * Browser half of the MySQL plugin: it registers the MySQL settings page, and
 * the page's data — the settings scope, the credential control, and the
 * connection probe — reaches it through this plugin's inject face.
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
  type ConnectionProfile, type DatabaseSettings, type DialectCatalog, type ProbeRequest,
} from '../contract.ts'

import { en, zh, type DbLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Copy of the database settings page. */
    'settings.db': DbLocaleKey
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
}

/**
 * Read the database types the page may offer from the plugin's own
 * authenticated API route.
 * @returns the catalog; a transport failure yields an empty one, which the
 * chooser renders as nothing to pick rather than a broken dialog.
 */
async function loadCatalog(): Promise<DialectCatalog> {
  try {
    const response = await fetch(DB_DIALECTS_PATH, { method: 'GET' })
    if (!response.ok) return { installed: [], known: [] }
    const payload = await response.json() as DialectCatalog
    return {
      installed: payload.installed ?? [],
      known: payload.known ?? [],
    }
  } catch {
    return { installed: [], known: [] }
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
