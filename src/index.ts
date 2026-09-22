/**
 * Host half of the database plugin: it owns the session runner, registers the
 * model-facing tools, publishes the settings namespace the configuration page
 * edits, and serves the page's connection probes on the authenticated API
 * channel.
 *
 * The settings section holds a list of saved connections and the one the tools
 * address; every operation resolves the active connection at that moment, so a
 * switch on the page reaches the next tool call without a reload. The servers
 * these connections run against come from the dialect registry: this plugin
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
import { MYSQL_SETTINGS_NAMESPACE, MYSQL_TEST_PATH, type DatabaseSettings, type MysqlSettings, type ProbeRequest } from './contract.ts'
import { DatabaseDialectRegistry, resolveDialect, type DatabaseConnection, type DatabaseDialect } from './dialect.ts'
import { MYSQL_DIALECT } from './dialect-mysql.ts'
import { compositionEntry, Config, DatabaseSettingsSchema } from './settings.ts'
import { applyDatabaseTools } from './tools.ts'

export type { DatabaseSettings, MysqlSettings } from './contract.ts'
export type { Config as MysqlConfig } from './settings.ts'

export { Config } from './settings.ts'

/** Stable Loader identity. */
export const name = 'ds-db'

/** The tool registry is the one service this plugin cannot work without. */
export const inject = ['tools']

/** Connection test response the settings page renders. */
interface ProbePayload {
  /** Whether the connection answered. */
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
 * The saved connection the tools address: the one `activeId` names, else the
 * only saved one.
 * @param settings - the current resolved settings section.
 * @returns the connection every tool call runs against.
 * @throws {Error} when nothing usable is saved, naming what is saved otherwise.
 */
export function activeConnection(settings: DatabaseSettings): MysqlSettings {
  const active = settings.connections.find(profile => profile.id === settings.activeId)
  if (active !== undefined) return active
  const only = settings.connections.length === 1 ? settings.connections[0] : undefined
  if (only !== undefined) return only
  const names = settings.connections.map(profile => profile.name).join(', ')
  throw new Error(settings.connections.length === 0
    ? 'no database connection is saved; add one on the database settings page'
    : `connection "${settings.activeId}" is not saved; saved connections: ${names}`)
}

/**
 * Register the settings namespace, the dialect registry with its own dialect,
 * the four read-only tools, and the page's connection probes.
 * @param ctx - the plugin context.
 * @param config - composition values the settings namespace falls back to.
 */
export function apply(ctx: Context, config: Config): void {
  const entry = compositionEntry(config)
  // The settings source is a thunk, not a snapshot: the provider hands it over
  // once, and every operation reads through it so a committed change (or a
  // provider detach) reaches the next tool call.
  let readSettings: () => DatabaseSettings = () => entry

  // The settings provider is optional: without one the composition entry is
  // the whole configuration, and the configuration page reports the namespace
  // as unavailable rather than editing a section nobody serves.
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, MYSQL_SETTINGS_NAMESPACE, DatabaseSettingsSchema, entry, {
      setSource: (source) => { readSettings = source },
      // Nothing is derived from the source besides the reads above.
      onChange: () => {},
    })
  })

  const registry = new DatabaseDialectRegistry(ctx)
  ctx.effect(() => registry.register(MYSQL_DIALECT), 'ds-db: mysql dialect')
  const readDialect = (): DatabaseDialect => resolveDialect(registry, activeConnection(readSettings()).dialect)
  // Model-facing descriptions are fixed when the tools are registered, so they
  // are written from the dialect the composition entry starts on. A dialect
  // that activates later still runs every call, and only that registration-time
  // wording lags until the plugin is reloaded.
  const initialDialect = entry.connections.find(profile => profile.id === entry.activeId)?.dialect
    ?? MYSQL_DIALECT.name
  const described = registry.get(initialDialect) ?? { ...MYSQL_DIALECT, label: initialDialect }

  const access = new DatabaseAccess({
    connection: async () => await resolveConnection(ctx, activeConnection(readSettings())),
    dialect: readDialect,
  })
  ctx.effect(() => () => { void access.dispose() }, 'ds-db: database session')
  applyDatabaseTools(ctx, { access, dialect: readDialect, described, settings: () => activeConnection(readSettings()) })

  // The browser-connection carrier is optional: a headless deployment has no
  // settings page to probe for, and the tools work without it.
  ctx.inject(['connection'], (webCtx) => {
    const connection = Reflect.get(webCtx, 'connection') as ProbeHost | undefined
    if (connection === undefined) return
    webCtx.effect(() => connection.fetch.register({
      path: MYSQL_TEST_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async request => Response.json(await probeRoute(ctx, registry, readSettings, request), {
        headers: { 'cache-control': 'no-store' },
      }),
    }), `ds-db: POST ${MYSQL_TEST_PATH}`)
  })
}

/**
 * Resolve the connection for one operation, reading the password from the
 * credential store at that moment.
 *
 * The fields are the profile's; what they mean to the server is the dialect's
 * affair, so a dialect whose server names its database differently reads
 * `database` its own way.
 * @param ctx - the plugin context, read for the optional credential provider.
 * @param profile - the connection a dialect session is opened against.
 * @returns the resolved connection.
 */
async function resolveConnection(ctx: Context, profile: MysqlSettings): Promise<DatabaseConnection> {
  const credentials = ctx.get('credentials')
  const resolved = credentials === undefined
    ? undefined
    : await credentials.resolve(credentialRef(profile.passwordEnv))
  const database = profile.database.trim()
  return {
    host: profile.host,
    port: profile.port,
    user: profile.user,
    password: resolved?.value ?? '',
    ...database.length === 0 ? {} : { database },
    connectTimeoutMs: profile.connectTimeoutMs,
    queryTimeoutMs: profile.queryTimeoutMs,
    maxRows: profile.maxRows,
  }
}

/**
 * Serve one probe: the saved connection the body names, the unsaved draft it
 * carries, or the connection the tools currently address.
 * @param ctx - the plugin context, for the credential store.
 * @param registry - the dialect registry, read for the profile's dialect.
 * @param readSettings - the current settings section.
 * @param request - the page's probe request.
 * @returns the payload; a refusal is a value, not a failed response.
 */
async function probeRoute(
  ctx: Context,
  registry: DatabaseDialectRegistry,
  readSettings: () => DatabaseSettings,
  request: Request,
): Promise<ProbePayload> {
  try {
    const body = await request.json().catch(() => ({})) as ProbeRequest
    const profile = body.profile
      ?? (body.id === undefined
        ? activeConnection(readSettings())
        : readSettings().connections.find(candidate => candidate.id === body.id))
    if (profile === undefined) {
      return { ok: false, message: `connection "${body.id ?? ''}" is not saved` }
    }
    return await probeProfile(ctx, registry, profile)
  } catch (error: unknown) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Probe one connection through its own dialect, on a session this probe alone
 * owns, so testing a draft never moves the tools' live session.
 * @param ctx - the plugin context, for the credential store.
 * @param registry - the dialect registry, read for the profile's dialect.
 * @param profile - the connection to probe.
 * @returns the probe payload; a refusal is a value, not a failed response.
 */
async function probeProfile(
  ctx: Context,
  registry: DatabaseDialectRegistry,
  profile: MysqlSettings,
): Promise<ProbePayload> {
  try {
    const connection = await resolveConnection(ctx, profile)
    const dialect = resolveDialect(registry, profile.dialect)
    const access = new DatabaseAccess({ connection: async () => connection, dialect: () => dialect })
    try {
      const probe = await access.probe()
      return { ok: true, version: probe.version, latencyMs: probe.latencyMs }
    } finally {
      await access.dispose()
    }
  } catch (error: unknown) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}
