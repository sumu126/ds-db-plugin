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
 * provides the registry and ships no database type, so every type — MySQL
 * included — arrives as a package that registers itself.
 *
 * @module dsh-ds-db
 */

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-tools'
import { DatabaseAccess } from './connection.ts'
import { activeConnection } from './connections.ts'
import {
  DB_DIALECTS_PATH, DB_SETTINGS_NAMESPACE, DB_TEST_PATH, UNSET_PORT,
  type ConnectionProfile, type DatabaseSettings, type DialectCatalog, type ProbeRequest,
} from './contract.ts'
import { KNOWN_DIALECT_PACKAGES } from './dialect-catalog.ts'
import { DatabaseDialectRegistry, dialectFacts, resolveDialect, type DatabaseConnection, type DatabaseDialect } from './dialect.ts'
import { compositionEntry, Config, DatabaseSettingsSchema } from './settings.ts'
import { applyDatabaseTools } from './tools.ts'

export type { ConnectionProfile, DatabaseSettings } from './contract.ts'
export type { ConnectionSummary } from './connections.ts'
export type { Config as DatabaseConfig } from './settings.ts'

export { activeConnection, connectionSummaries, resolveProfile } from './connections.ts'

export { Config } from './settings.ts'

/** Stable Loader identity. */
export const name = 'ds-db'

/** The tool registry is the one service this plugin cannot work without. */
export const inject = ['tools']

/**
 * How long tool registration waits for the configured dialect package.
 *
 * Long enough for a sibling row of the same patch to activate, short enough
 * that a missing package still ends with registered tools and a refusal naming
 * what is available.
 */
const DIALECT_WAIT_MS = 100

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
 * Register the settings namespace, the dialect registry, the read-only tools,
 * and the page's connection probes.
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
    settingsCtx.settings.installSection(ctx, DB_SETTINGS_NAMESPACE, DatabaseSettingsSchema, entry, {
      setSource: (source) => { readSettings = source },
      // Nothing is derived from the source besides the reads above.
      onChange: () => {},
    })
  })

  // This plugin provides the registry and ships no dialect of its own: every
  // database type, MySQL included, arrives as a package that registers itself
  // through `inject: ['databaseDialects']`.
  const registry = new DatabaseDialectRegistry(ctx)
  /** The dialect one saved connection is addressed through. */
  const readDialectFor = (profile: ConnectionProfile): DatabaseDialect => resolveDialect(registry, profile.dialect)
  // The composition entry names the dialect it starts on, and an empty one
  // means the first dialect the deployment registers — the plugin names no
  // database type, so it names no default type either.
  const initialDialect = entry.connections.find(profile => profile.id === entry.activeId)?.dialect ?? ''

  const access = new DatabaseAccess({
    connection: async profile => await resolveConnection(ctx, profile, readDialectFor(profile)),
    dialect: readDialectFor,
  })
  ctx.effect(() => () => { void access.dispose() }, 'ds-db: database session')
  // Model-facing descriptions are fixed when the tools are registered, so they
  // are written from the dialect's own facts rather than from its name. The
  // dialect package therefore has to be registered first, and it always loads
  // after this plugin because the registry is provided here.
  //
  // A configured dialect that never registers would leave the model with no
  // tools at all, so the wait is bounded: past it the tools are registered from
  // the stand-in facts, and a call answers with the refusal that names what is
  // registered — which is what a misspelled or missing package should say.
  let registered = false
  const registerTools = (): void => {
    if (registered) return
    registered = true
    applyDatabaseTools(ctx, {
      access,
      dialectFor: readDialectFor,
      described: dialectFacts(registry, initialDialect),
      // A thunk, not the current function: `readSettings` is reassigned when the
      // settings provider hands its source over, so passing the value would pin
      // the tools to the composition entry forever.
      settings: () => readSettings(),
    })
  }
  ctx.effect(() => {
    const waiting = registry.whenRegistered(initialDialect, registerTools)
    const timer = setTimeout(registerTools, DIALECT_WAIT_MS)
    // A pending timer must not hold the process open once the plugin unloads.
    timer.unref?.()
    return () => {
      waiting()
      clearTimeout(timer)
    }
  }, `ds-db: tools for ${initialDialect}`)

  // The browser-connection carrier is optional: a headless deployment has no
  // settings page to probe for, and the tools work without it.
  ctx.inject(['connection'], (webCtx) => {
    const connection = Reflect.get(webCtx, 'connection') as ProbeHost | undefined
    if (connection === undefined) return
    webCtx.effect(() => connection.fetch.register({
      path: DB_TEST_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async request => Response.json(await probeRoute(ctx, registry, readSettings, request), {
        headers: { 'cache-control': 'no-store' },
      }),
    }), `ds-db: POST ${DB_TEST_PATH}`)

    // The page's type chooser reads the registered dialects from here, so a
    // dialect that arrives in its own package shows up without this plugin
    // knowing its name in advance.
    webCtx.effect(() => connection.fetch.register({
      path: DB_DIALECTS_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async (): Promise<Response> => Response.json(dialectCatalog(registry), {
        headers: { 'cache-control': 'no-store' },
      }),
    }), `ds-db: GET ${DB_DIALECTS_PATH}`)
  })
}

/**
 * Describe every database type the page may offer: what is registered here, and
 * what a deployment could install.
 * @param registry - the dialects registered in this deployment.
 * @returns the catalog the type chooser renders.
 */
export function dialectCatalog(registry: DatabaseDialectRegistry): DialectCatalog {
  const installed = registry.names()
    .map((name) => {
      const dialect = registry.get(name)
      if (dialect === undefined) return undefined
      return {
        name: dialect.name,
        label: dialect.label,
        // The type describes itself: only the dialect knows what it connects
        // through and what it offers, so the plugin never writes this line.
        ...dialect.description === undefined ? {} : { description: dialect.description },
        capabilities: [...dialect.capabilities],
        connectionDefaults: dialect.connectionDefaults ?? {},
        configFields: dialect.configFields.map(field => ({
          key: field.key,
          kind: field.kind,
          default: field.default,
          required: field.required,
          ...field.label === undefined ? {} : { label: field.label },
          ...field.sensitive === true ? { sensitive: true } : {},
        })),
      }
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined)
  const known = KNOWN_DIALECT_PACKAGES
    .filter(entry => !installed.some(dialect => dialect.name === entry.name))
  return { installed, known }
}

/**
 * Resolve the connection for one operation, reading the password from the
 * credential store at that moment.
 *
 * The fields are the profile's; what they mean to the server is the dialect's
 * affair, so a dialect whose server names its database differently reads
 * `database` its own way.
 *
 * A field the profile leaves empty falls back to what the dialect declares for
 * it, because a port and an account name are facts about one server. A field
 * neither of them fills is a refusal that names it, not a default the plugin
 * would have to guess.
 * @param ctx - the plugin context, read for the optional credential provider.
 * @param profile - the connection a dialect session is opened against.
 * @param dialect - the dialect that connection is addressed through.
 * @returns the resolved connection.
 * @throws {Error} when no host, port, or account can be established.
 */
async function resolveConnection(
  ctx: Context,
  profile: ConnectionProfile,
  dialect: DatabaseDialect,
): Promise<DatabaseConnection> {
  const declared = dialect.connectionDefaults
  const host = profile.host.trim().length > 0 ? profile.host.trim() : declared?.host ?? ''
  const port = profile.port !== UNSET_PORT ? profile.port : declared?.port ?? UNSET_PORT
  const user = profile.user.trim().length > 0 ? profile.user.trim() : String(declared?.user ?? '')
  const passwordEnv = profile.passwordEnv.trim().length > 0
    ? profile.passwordEnv
    : declared?.passwordEnv ?? profile.passwordEnv
  const missing = host.length === 0
    ? 'host'
    : port === UNSET_PORT ? 'port' : user.length === 0 ? 'user' : ''
  if (missing.length > 0) {
    throw new Error(`connection "${profile.name}" has no ${missing}, and ${dialect.label} declares no default for it`)
  }
  const credentials = ctx.get('credentials')
  const resolved = credentials === undefined
    ? undefined
    : await credentials.resolve(credentialRef(passwordEnv))
  const database = profile.database.trim()
  return {
    host,
    port,
    user,
    password: resolved?.value ?? '',
    ...database.length === 0 ? {} : { database },
    extra: profile.extra,
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
  profile: ConnectionProfile,
): Promise<ProbePayload> {
  try {
    const dialect = resolveDialect(registry, profile.dialect)
    const connection = await resolveConnection(ctx, profile, dialect)
    const access = new DatabaseAccess({ connection: async () => connection, dialect: () => dialect })
    try {
      const probe = await access.probe(profile)
      return { ok: true, version: probe.version, latencyMs: probe.latencyMs }
    } finally {
      await access.dispose()
    }
  } catch (error: unknown) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}
