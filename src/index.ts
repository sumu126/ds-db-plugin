/**
 * Host half of the MySQL read-only plugin: it owns the session runner, registers
 * the model-facing tools, publishes the settings namespace the configuration
 * page edits, and serves the page's connection probe on the authenticated API
 * channel.
 *
 * The servers this runs against come from the dialect registry: this plugin
 * provides the registry and registers its own MySQL dialect into it, and a
 * further dialect ships as its own package that registers itself.
 *
 * @module dsh-ds-db
 */

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-tools'
import { DatabaseAccess } from './connection.ts'
import { MYSQL_SETTINGS_NAMESPACE, MYSQL_TEST_PATH, type MysqlSettings } from './contract.ts'
import { DatabaseDialectRegistry, resolveDialect, type DatabaseConnection, type DatabaseDialect } from './dialect.ts'
import { MYSQL_DIALECT } from './dialect-mysql.ts'
import { compositionEntry, Config, MysqlSettingsSchema } from './settings.ts'
import { applyDatabaseTools } from './tools.ts'

export type { MysqlSettings } from './contract.ts'
export type { Config as MysqlConfig } from './settings.ts'

export { Config } from './settings.ts'

/** Stable Loader identity. */
export const name = 'ds-db'

/** The tool registry is the one service this plugin cannot work without. */
export const inject = ['tools']

/** Connection test response the settings page renders. */
interface ProbePayload {
  /** Whether the saved connection answered. */
  ok: boolean
  /** Server version, present on success. */
  version?: string
  /** Round trip time in milliseconds, present on success. */
  latencyMs?: number
  /** Refusal text, present on failure. */
  message?: string
}

/** The slice of the browser-connection service this plugin registers a route on. */
interface ProbeHost {
  fetch: {
    register(route: {
      path: string
      methods: readonly string[]
      requestBody: 'buffered' | 'streaming'
      fetch: (request: Request) => Promise<Response>
    }): () => Promise<void>
  }
}

/**
 * Register the MySQL settings namespace, the dialect registry with its own
 * dialect, the four read-only tools, and the page's connection probe.
 * @param ctx - the plugin context.
 * @param config - composition values the settings namespace falls back to, plus the dialect to address.
 */
export function apply(ctx: Context, config: Config): void {
  const entry = compositionEntry(config)
  // The settings source is a thunk, not a snapshot: the provider hands it over
  // once, and every operation reads through it so a committed change (or a
  // provider detach) reaches the next tool call.
  let readSettings: () => MysqlSettings = () => entry

  // The settings provider is optional: without one the composition entry is
  // the whole configuration, and the configuration page reports the namespace
  // as unavailable rather than editing a section nobody serves.
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, MYSQL_SETTINGS_NAMESPACE, MysqlSettingsSchema, entry, {
      setSource: (source) => { readSettings = source },
      // Nothing is derived from the source besides the reads above.
      onChange: () => {},
    })
  })

  const registry = new DatabaseDialectRegistry(ctx)
  ctx.effect(() => registry.register(MYSQL_DIALECT), 'ds-db: mysql dialect')
  const dialectName = config.dialect ?? MYSQL_DIALECT.name
  const readDialect = (): DatabaseDialect => resolveDialect(registry, dialectName)
  // Model-facing descriptions are fixed when the tools are registered, so they
  // are written from the dialect registered at that moment. This plugin's own
  // dialect is already in, which is the whole default case; a dialect that
  // activates later still runs every call, and only that registration-time
  // wording lags until the plugin is reloaded.
  const described = registry.get(dialectName) ?? { ...MYSQL_DIALECT, label: dialectName }

  const access = new DatabaseAccess({
    connection: async () => await resolveConnection(ctx, readSettings()),
    dialect: readDialect,
  })
  ctx.effect(() => () => { void access.dispose() }, 'ds-db: database session')
  applyDatabaseTools(ctx, { access, dialect: readDialect, described, settings: readSettings })

  // The browser-connection carrier is optional: a headless deployment has no
  // settings page to probe for, and the tools work without it.
  ctx.inject(['connection'], (webCtx) => {
    const connection = Reflect.get(webCtx, 'connection') as ProbeHost | undefined
    if (connection === undefined) return
    webCtx.effect(() => connection.fetch.register({
      path: MYSQL_TEST_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (): Promise<Response> => Response.json(await probePayload(access), {
        headers: { 'cache-control': 'no-store' },
      }),
    }), `ds-db: POST ${MYSQL_TEST_PATH}`)
  })
}

/**
 * Resolve the connection for one operation, reading the password from the
 * credential store at that moment.
 *
 * The fields are the settings section's; what they mean to the server is the
 * dialect's affair, so a dialect whose server names its database differently
 * reads `database` its own way.
 * @param ctx - the plugin context, read for the optional credential provider.
 * @param settings - the current resolved settings section.
 * @returns the connection a dialect session is opened against.
 */
async function resolveConnection(ctx: Context, settings: MysqlSettings): Promise<DatabaseConnection> {
  const credentials = ctx.get('credentials')
  const resolved = credentials === undefined
    ? undefined
    : await credentials.resolve(credentialRef(settings.passwordEnv))
  const database = settings.database.trim()
  return {
    host: settings.host,
    port: settings.port,
    user: settings.user,
    password: resolved?.value ?? '',
    ...database.length === 0 ? {} : { database },
    connectTimeoutMs: settings.connectTimeoutMs,
    queryTimeoutMs: settings.queryTimeoutMs,
    maxRows: settings.maxRows,
  }
}

/**
 * Probe the saved connection and report either outcome as a page-renderable value.
 * @param access - the plugin's session runner.
 * @returns the probe payload; a refusal is a value, not a failed response.
 */
async function probePayload(access: DatabaseAccess): Promise<ProbePayload> {
  try {
    const probe = await access.probe()
    return { ok: true, version: probe.version, latencyMs: probe.latencyMs }
  } catch (error: unknown) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}