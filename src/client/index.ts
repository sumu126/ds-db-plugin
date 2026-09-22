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
import { MYSQL_SETTINGS_NAMESPACE, MYSQL_TEST_PATH, type MysqlSettings } from '../contract.ts'
import { MysqlSettingsController, type MysqlCredentialsFace, type MysqlPageFace, type MysqlProbe } from './form.ts'
import { MysqlSettingsPage } from './MysqlSettingsPage.tsx'
import { en, zh, type MysqlLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Copy of the MySQL settings page. */
    'settings.mysql': MysqlLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'settings.mysql'

/** Required services (cordis fiber inject). */
export const inject = [
  'slots', 'locale', 'remote', 'remote.credentials', 'settingsScope',
]

/**
 * Register the MySQL settings page.
 * @param ctx - browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-ds-db: copy dictionaries')

  const scope = ctx.settingsScope.bind<MysqlSettings>({ namespace: MYSQL_SETTINGS_NAMESPACE })
  const credentials: MysqlCredentialsFace = {
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
  const controller = new MysqlSettingsController(scope, credentials, probeConnection)
  const t = ctx.locale.bind(NS)

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: MYSQL_SETTINGS_NAMESPACE,
    // After the shipped sections (General 0, Models 10, Plugins 15), so a
    // deployment's own page never pushes the built-in ones around.
    order: 40,
    label: () => t('nav'),
    locale: NS,
    inject: (): MysqlPageFace => ({ hooks: { mysqlPage: controller.snapshot }, ...controller.actions() }),
  }, MysqlSettingsPage))
}

/**
 * Probe the saved connection over the plugin's own authenticated API route.
 * @returns the probe outcome; a transport failure is a failed probe, not a throw.
 */
async function probeConnection(): Promise<MysqlProbe> {
  try {
    const response = await fetch(MYSQL_TEST_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
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
