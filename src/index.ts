/**
 * Host half of the database plugin: it owns the session runner, registers the
 * model-facing tools, publishes the settings namespace the configuration page
 * edits, and serves the page's connection probes and the browser catalog's
 * listings on the authenticated API channel.
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
// Type-only: pulls the connection service's Context merge (ctx.connection) and
// the Fetch-route types the two probe endpoints register through.
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import { CARD_BUDGET, type CardBudget } from './card-budget.ts'
import { DatabaseAccess, SESSION_LIMIT } from './connection.ts'
import { activeConnection, addressedConnection } from './connections.ts'
import {
  DB_COLUMNS_PATH, DB_DATABASES_PATH, DB_DIALECTS_PATH, DB_SETTINGS_NAMESPACE, DB_TABLES_PATH, DB_TEST_PATH, UNSET_PORT,
  type ColumnListing, type ConnectionProfile, type DatabaseListing, type DatabaseSettings, type DialectCatalog,
  type KnownDialectPackage, type ProbeRequest, type TableListing,
} from './contract.ts'
import { SHIPPED_DIALECT_PACKAGES } from './dialect-catalog.ts'
import { DatabaseDialectRegistry, dialectFacts, resolveDialect, type DatabaseConnection, type DatabaseDialect } from './dialect.ts'
import { compositionEntry, Config, DatabaseSettingsSchema, DIALECT_WAIT_MS, SAMPLE_ROWS } from './settings.ts'
import { applyDatabaseTools, requireCapability } from './tools.ts'

export type { ConnectionProfile, DatabaseSettings } from './contract.ts'
export type { ConnectionSummary } from './connections.ts'
export type { Config as DatabaseConfig } from './settings.ts'

export { activeConnection, connectionSummaries, resolveProfile } from './connections.ts'

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

/**
 * Register the settings namespace, the dialect registry, the read-only tools,
 * and the page's connection probes.
 * @param ctx - the plugin context.
 * @param config - composition values the settings namespace falls back to.
 */
export function apply(ctx: Context, config: Config): void {
  const entry = compositionEntry(config)
  // The bounds a call's card metadata is written under; the schema supplies the
  // defaults, and the constants beside them keep a direct caller without one
  // resolved to the same numbers.
  const cardBudget: CardBudget = {
    bytes: config.cardMaxBytes ?? CARD_BUDGET.bytes,
    rows: config.cardMaxRows ?? CARD_BUDGET.rows,
    items: config.cardMaxItems ?? CARD_BUDGET.items,
  }
  // The settings source is a thunk, not a snapshot: the provider hands it over
  // once, and every operation reads through it so a committed change (or a
  // provider detach) reaches the next tool call.
  //
  // A section that resolves to no connection falls back to the composition
  // entry, because a stored section holds only what the user changed: a
  // document carrying the schema's empty `connections` would otherwise leave
  // every tool with nothing to address, even though the deployment configured a
  // connection in `cordis.yml`.
  let readSettings: () => DatabaseSettings = () => entry
  const withCompositionFallback = (source: () => DatabaseSettings): (() => DatabaseSettings) =>
    () => {
      const resolved = source()
      return resolved.connections.length > 0 ? resolved : entry
    }

  // The settings provider is optional: without one the composition entry is
  // the whole configuration, and the configuration page reports the namespace
  // as unavailable rather than editing a section nobody serves.
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, DB_SETTINGS_NAMESPACE, DatabaseSettingsSchema, entry, {
      setSource: (source) => { readSettings = withCompositionFallback(source) },
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
    // A session that cannot drain is reported where the deployment's other
    // warnings go, not to the process stream behind the harness's back.
    warn: (message) => { ctx.logger.warn(message) },
  }, config.sessionLimit ?? SESSION_LIMIT)
  ctx.effect(() => () => access.dispose(), 'ds-db: database session')
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
      cardBudget,
      sampleRows: config.sampleRows ?? SAMPLE_ROWS,
    })
  }
  ctx.effect(() => {
    const waiting = registry.whenRegistered(initialDialect, registerTools)
    const timer = setTimeout(registerTools, config.dialectWaitMs ?? DIALECT_WAIT_MS)
    // A pending timer must not hold the process open once the plugin unloads.
    timer.unref?.()
    return () => {
      waiting()
      clearTimeout(timer)
    }
  }, `ds-db: tools for ${initialDialect}`)

  // The browser-connection carrier is optional: a headless deployment has no
  // settings page to probe for, and the tools work without it.
  //
  // These two routes are registered on the low-level Fetch channel rather than
  // as Typert `@Remote` methods: the remote surface is generated by a build
  // pipeline this repository does not run (see the README's known limitations),
  // so the page calls them with a plain `fetch` and the wire shapes are written
  // out in `contract.ts`.
  ctx.inject(['connection'], (webCtx) => {
    // The injection is the wait: this callback runs once the carrier is served,
    // so the handle is here and its Fetch routes need no second check.
    const connection: HostConnectionHandle = webCtx.connection
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
    // knowing its name in advance. The hint list is a deployment's, because a
    // package published outside this repository is one this plugin cannot name.
    webCtx.effect(() => connection.fetch.register({
      path: DB_DIALECTS_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async (): Promise<Response> => {
        const configured = config.knownDialectPackages
        const hints = configured !== undefined && configured.length > 0
          ? configured
          : SHIPPED_DIALECT_PACKAGES
        return Response.json(dialectCatalog(registry, hints), {
          headers: { 'cache-control': 'no-store' },
        })
      },
    }), `ds-db: GET ${DB_DIALECTS_PATH}`)

    // The browser catalog addresses a connection the same way a tool call does,
    // through the one function both use, so a panel and a call cannot disagree
    // about which server a name reaches.
    const addressed = (requested: string | undefined): { profile: ConnectionProfile, view: DatabaseDialect } =>
      addressedConnection(readSettings(), requested, readDialectFor)

    // The catalog reads the two dialect queries the listing tools run, on the
    // same session runner, so the panel and the model are shown one list rather
    // than two that can drift. A refusal is a value here too: the panel renders
    // it beside a retry instead of reporting a transport failure.
    webCtx.effect(() => connection.fetch.register({
      path: DB_DATABASES_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async (request): Promise<Response> => Response.json(
        await listDatabases(
          { addressed, access },
          new URL(request.url).searchParams.get('connection') ?? undefined,
          request.signal,
        ),
        { headers: { 'cache-control': 'no-store' } },
      ),
    }), `ds-db: GET ${DB_DATABASES_PATH}`)

    webCtx.effect(() => connection.fetch.register({
      path: DB_TABLES_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async (request): Promise<Response> => {
        const query = new URL(request.url).searchParams
        return Response.json(
          await listTables(
            { addressed, access },
            query.get('connection') ?? undefined,
            query.get('database') ?? '',
            request.signal,
          ),
          { headers: { 'cache-control': 'no-store' } },
        )
      },
    }), `ds-db: GET ${DB_TABLES_PATH}`)

    webCtx.effect(() => connection.fetch.register({
      path: DB_COLUMNS_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async (request): Promise<Response> => {
        const query = new URL(request.url).searchParams
        return Response.json(
          await listColumns(
            { addressed, access },
            query.get('connection') ?? undefined,
            query.get('database') ?? '',
            query.get('table') ?? '',
            request.signal,
          ),
          { headers: { 'cache-control': 'no-store' } },
        )
      },
    }), `ds-db: GET ${DB_COLUMNS_PATH}`)
  })
}

/**
 * Describe every database type the page may offer: what is registered here, and
 * what a deployment could install.
 * @param registry - the dialects registered in this deployment.
 * @param knownHints - the packages to hint when they are not registered; a
 * deployment that publishes its own dialect names it here.
 * @returns the catalog the type chooser renders.
 */
export function dialectCatalog(
  registry: DatabaseDialectRegistry,
  knownHints: readonly KnownDialectPackage[] = SHIPPED_DIALECT_PACKAGES,
): DialectCatalog {
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
        systemDatabases: [...dialect.systemDatabases],
        configFields: dialect.configFields.map(field => ({
          key: field.key,
          kind: field.kind,
          default: field.default,
          required: field.required,
          ...field.label === undefined ? {} : { label: field.label },
          ...field.hint === undefined ? {} : { hint: field.hint },
          ...field.sensitive === true ? { sensitive: true } : {},
        })),
      }
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined)
  const known = knownHints
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
    return await probeProfile(ctx, registry, profile, request.signal)
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
 * @param signal - the request's cancellation, so a page that navigated away
 * stops waiting on the server rather than holding a session until the timeout.
 * @returns the probe payload; a refusal is a value, not a failed response.
 */
async function probeProfile(
  ctx: Context,
  registry: DatabaseDialectRegistry,
  profile: ConnectionProfile,
  signal?: AbortSignal,
): Promise<ProbePayload> {
  try {
    const dialect = resolveDialect(registry, profile.dialect)
    const connection = await resolveConnection(ctx, profile, dialect)
    const access = new DatabaseAccess({
      connection: async () => connection,
      dialect: () => dialect,
      warn: (message) => { ctx.logger.warn(message) },
    })
    try {
      const probe = await access.probe(profile, signal)
      return { ok: true, version: probe.version, latencyMs: probe.latencyMs }
    } finally {
      await access.dispose()
    }
  } catch (error: unknown) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/** What one browser catalog read addresses, and how it runs. */
interface CatalogReadFace {
  /** The connection a request named, resolved together with its dialect. */
  addressed: (requested: string | undefined) => { profile: ConnectionProfile, view: DatabaseDialect }
  /** The session runner, so a catalog read is bounded exactly as a tool call is. */
  access: DatabaseAccess
}

/**
 * List the databases one connection sees, for the browser catalog.
 *
 * The dialect query, the session runner, and the two capability concessions are
 * the `db_databases` tool's, so a panel and a call are shown one list: a type
 * that cannot report a character set has it blanked rather than invented, and
 * the server's own schemas are omitted.
 * @param face - addressing and the session runner.
 * @param requested - the connection the request named, if any.
 * @param signal - the request's cancellation, so a panel that navigated away
 * stops waiting on the server instead of holding a session until the timeout.
 * @returns the databases, or the refusal the panel renders in their place.
 */
async function listDatabases(
  face: CatalogReadFace,
  requested: string | undefined,
  signal?: AbortSignal,
): Promise<DatabaseListing> {
  try {
    const { profile: target, view } = face.addressed(requested)
    requireCapability(view, 'databases')
    const databases = await face.access.run(target, view.databases(), signal)
    return {
      connection: target.name,
      databases: databases
        .filter(row => !view.systemDatabases.includes(row.name))
        .map(row => view.capabilities.has('charset') ? row : { ...row, charset: '', collation: '' }),
    }
  } catch (error: unknown) {
    return { databases: [], message: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * The name one catalog request carries, or undefined when it carries none.
 *
 * A request that names nothing is refused rather than resolved to a default: a
 * panel always lists what the user opened, and silently listing something else
 * would answer a question nobody asked.
 * @param value - the query parameter as received.
 * @returns the trimmed name.
 */
function requestedName(value: string): string | undefined {
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/**
 * List the tables and views of one database, for the browser catalog.
 * @param face - addressing and the session runner.
 * @param requested - the connection the request named, if any.
 * @param database - the database the request named.
 * @param signal - the request's cancellation.
 * @returns the tables, or the refusal the panel renders in their place.
 */
async function listTables(
  face: CatalogReadFace,
  requested: string | undefined,
  database: string,
  signal?: AbortSignal,
): Promise<TableListing> {
  const wanted = requestedName(database)
  if (wanted === undefined) return { database: '', tables: [], message: 'the request names no database' }
  try {
    const { profile: target, view } = face.addressed(requested)
    requireCapability(view, 'tables')
    const tables = await face.access.run(target, view.tables(wanted), signal)
    return {
      connection: target.name,
      database: wanted,
      // As in `db_tables`: a server that cannot estimate row counts reports
      // none rather than letting its dialect invent a number the panel would
      // show as fact.
      tables: tables.map(row => view.capabilities.has('estimatedRows') ? row : { ...row, estimatedRows: null }),
    }
  } catch (error: unknown) {
    return { database: wanted, tables: [], message: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * List the columns of one table, for the browser catalog.
 * @param face - addressing and the session runner.
 * @param requested - the connection the request named, if any.
 * @param database - the database the request named.
 * @param table - the table the request named.
 * @param signal - the request's cancellation.
 * @returns the columns, or the refusal the panel renders in their place.
 */
async function listColumns(
  face: CatalogReadFace,
  requested: string | undefined,
  database: string,
  table: string,
  signal?: AbortSignal,
): Promise<ColumnListing> {
  const wantedDatabase = requestedName(database)
  const wantedTable = requestedName(table)
  if (wantedDatabase === undefined || wantedTable === undefined) {
    const missing = wantedDatabase === undefined ? 'database' : 'table'
    return {
      database: wantedDatabase ?? '', table: wantedTable ?? '', columns: [],
      message: `the request names no ${missing}`,
    }
  }
  try {
    const { profile: target, view } = face.addressed(requested)
    requireCapability(view, 'columns')
    return {
      connection: target.name,
      database: wantedDatabase,
      table: wantedTable,
      columns: await face.access.run(target, view.columns(wantedDatabase, wantedTable), signal),
    }
  } catch (error: unknown) {
    return {
      database: wantedDatabase, table: wantedTable, columns: [],
      message: error instanceof Error ? error.message : String(error),
    }
  }
}
