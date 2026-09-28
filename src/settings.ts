/**
 * Host-side settings: the Schemastery schema the configuration page renders,
 * and the composition entry the namespace falls back to when no settings
 * provider is mounted.
 *
 * This module names no database type. A port, an account name, and a default
 * database are facts about one server, so they are a dialect's own
 * declarations ({@link DialectFacts} carries them to the page); the plugin
 * declares only what holds for every server, and leaves the rest to be filled
 * in or to be resolved from the dialect at call time.
 *
 * @module dsh-ds-db/src/settings
 */

import z from '@deepseek-ai/schemastery'
import { CARD_BYTES, CARD_ITEMS, CARD_ROWS } from './card-budget.ts'
import { SESSION_LIMIT } from './connection.ts'
import {
  DEFAULT_CONNECTION_ID, DEFAULT_PASSWORD_REF, UNSET_PORT,
  type ConnectionProfile, type DatabaseSettings, type KnownDialectPackage,
} from './contract.ts'

/**
 * Connection values a deployment that configures nothing gets.
 *
 * The host is the one guess that is never wrong about a remote server; the port
 * and the account are the dialect's to name, so they are left unset here.
 */
export const SHARED_DEFAULTS: ConnectionProfile = {
  id: DEFAULT_CONNECTION_ID,
  name: 'default',
  // Empty means the deployment's first registered dialect.
  dialect: '',
  extra: {},
  host: '127.0.0.1',
  port: UNSET_PORT,
  user: '',
  database: '',
  passwordEnv: DEFAULT_PASSWORD_REF,
  connectTimeoutMs: 10_000,
  queryTimeoutMs: 30_000,
  maxRows: 200,
}

/** Credential-reference shape, shared by every schema that carries one. */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * One hinted dialect package, as a deployment writes it in `cordis.yml`.
 *
 * The registry key, the label the page shows, and the package to install: the
 * same three facts the shipped list carries.
 */
const KnownDialectPackageSchema: z<KnownDialectPackage> = z.object({
  name: z.string().min(1),
  label: z.string().min(1),
  package: z.string().min(1),
})

/**
 * How long tool registration waits for the configured dialect package.
 *
 * Long enough for a sibling row of the same patch to activate, short enough
 * that a missing package still ends with registered tools and a refusal naming
 * what is available.
 */
export const DIALECT_WAIT_MS = 100

/**
 * Rows a `db_sample` call reads when it names none.
 *
 * A hand-read default: enough rows to see a table's shape and value spellings,
 * few enough to stay a glance. The configuration schema defaults to it, and the
 * tool's description states whichever value the deployment configured.
 */
export const SAMPLE_ROWS = 5

/**
 * One saved connection, as a settings section item or a `connections` entry.
 *
 * The host and account may be empty: whether an empty one blocks a call is the
 * dialect's answer, given when it resolves the connection.
 */
export const ProfileSchema: z<ConnectionProfile> = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  dialect: z.string(),
  // A connection saved before the field existed carries none, and refusing it
  // would hide the whole section behind one missing key.
  extra: z.dict(z.union([z.string(), z.number()])).default({}),
  host: z.string(),
  port: z.natural().max(65535),
  user: z.string(),
  database: z.string(),
  passwordEnv: z.string().pattern(IDENTIFIER),
  connectTimeoutMs: z.natural().min(1),
  queryTimeoutMs: z.natural().min(1),
  maxRows: z.natural().min(1),
})

/**
 * Composition configuration of the `ds-db` row in `cordis.yml`.
 *
 * The flat fields describe the single connection a deployment gets by default;
 * `connections` replaces them with a preprovisioned list. `dialect` names the
 * type that connection addresses, and an empty one means the first dialect the
 * deployment registered.
 */
export interface Config {
  /** Server host name or address. @default '127.0.0.1' */
  host?: string
  /** Server TCP port; the dialect's own default applies when unset. @default 0 */
  port?: number
  /** Account the plugin connects as. @default '' */
  user?: string
  /** Default database; empty means every tool call names one. @default '' */
  database?: string
  /** Credential reference holding the account password. @default 'DSH_DB_PASSWORD' */
  passwordEnv?: string
  /** TCP connect timeout in milliseconds. @default 10000 */
  connectTimeoutMs?: number
  /** Per-statement execution timeout in milliseconds. @default 30000 */
  queryTimeoutMs?: number
  /** Maximum rows one `db_query` call returns. @default 200 */
  maxRows?: number
  /**
   * Rows one `db_sample` call reads when it names none.
   *
   * Also written into that tool's model-facing description.
   * @default 5
   */
  sampleRows?: number
  /** Registered dialect the flat connection addresses; empty means the first one registered. @default '' */
  dialect?: string
  /** Saved connections a deployment preprovisions; the flat fields are ignored when present. */
  connections?: ConnectionProfile[]
  /** The connection the tools address by id; defaults to the first saved one. */
  activeId?: string
  /**
   * Dialect packages the settings page hints when they are not registered.
   *
   * An empty or absent list means the packages this plugin knows about, so a
   * deployment that publishes its own dialect names it here to have the page
   * offer it with the package to install.
   * @default []
   */
  knownDialectPackages?: KnownDialectPackage[]
  /**
   * How long tool registration waits for the configured dialect package, in
   * milliseconds.
   *
   * Long enough for a sibling row of the same patch to activate, short enough
   * that a missing package still ends with registered tools.
   * @default 100
   */
  dialectWaitMs?: number
  /**
   * Sessions this plugin keeps open at once, one per connection identity.
   *
   * Past this many, the least recently used is closed, so a page full of
   * connections cannot hold an unbounded number of pools open.
   * @default 4
   */
  sessionLimit?: number
  /**
   * Serialized UTF-8 bytes one call's card metadata may take, its own fields
   * included. Past it a card drops rows or items and marks itself truncated.
   * @default 16384
   */
  cardMaxBytes?: number
  /** Rows one table card carries at most. @default 50 */
  cardMaxRows?: number
  /** Items one list card carries at most. @default 100 */
  cardMaxItems?: number
}

/**
 * Validated composition configuration.
 *
 * Every field carries its default in the schema, so a value is present here
 * whichever layer supplied it, and the constants that back those defaults are
 * the same ones the callers of {@link compositionEntry} fall back to.
 */
export const Config: z<Config> = z.object({
  host: z.string().default(SHARED_DEFAULTS.host),
  port: z.natural().max(65535).default(SHARED_DEFAULTS.port),
  user: z.string().default(SHARED_DEFAULTS.user),
  database: z.string().default(SHARED_DEFAULTS.database),
  passwordEnv: z.string().pattern(IDENTIFIER).default(SHARED_DEFAULTS.passwordEnv),
  connectTimeoutMs: z.natural().min(1).default(SHARED_DEFAULTS.connectTimeoutMs),
  queryTimeoutMs: z.natural().min(1).default(SHARED_DEFAULTS.queryTimeoutMs),
  maxRows: z.natural().min(1).default(SHARED_DEFAULTS.maxRows),
  sampleRows: z.natural().min(1).default(SAMPLE_ROWS),
  dialect: z.string().default(SHARED_DEFAULTS.dialect),
  // No default: an absent list and an empty one both mean the flat fields above
  // describe the single connection, and the presence of a list is what replaces
  // them.
  connections: z.array(ProfileSchema),
  activeId: z.string().default(''),
  // Empty means "the packages this plugin knows about": the entry point falls
  // back to its own list, so `dialect-catalog` stays out of this module and no
  // import cycle forms between the schema and the hint list.
  knownDialectPackages: z.array(KnownDialectPackageSchema).default([]),
  dialectWaitMs: z.natural().min(1).default(DIALECT_WAIT_MS),
  sessionLimit: z.natural().min(1).default(SESSION_LIMIT),
  cardMaxBytes: z.natural().min(1).default(CARD_BYTES),
  cardMaxRows: z.natural().min(1).default(CARD_ROWS),
  cardMaxItems: z.natural().min(1).default(CARD_ITEMS),
})

/** The flat connection the composition fields describe. */
function flatConnection(config: Config): ConnectionProfile {
  return {
    ...SHARED_DEFAULTS,
    dialect: config.dialect ?? SHARED_DEFAULTS.dialect,
    host: config.host ?? SHARED_DEFAULTS.host,
    port: config.port ?? SHARED_DEFAULTS.port,
    user: config.user ?? SHARED_DEFAULTS.user,
    database: config.database ?? SHARED_DEFAULTS.database,
    passwordEnv: config.passwordEnv ?? SHARED_DEFAULTS.passwordEnv,
    connectTimeoutMs: config.connectTimeoutMs ?? SHARED_DEFAULTS.connectTimeoutMs,
    queryTimeoutMs: config.queryTimeoutMs ?? SHARED_DEFAULTS.queryTimeoutMs,
    maxRows: config.maxRows ?? SHARED_DEFAULTS.maxRows,
  }
}

/**
 * The settings section a deployment that mounts no settings provider still
 * runs on: the preprovisioned connections, else the one the flat fields
 * describe, with the active id the configuration names or the first connection.
 * @param config - the validated composition configuration.
 * @returns the complete section the namespace resolves to.
 */
export function compositionEntry(config: Config): DatabaseSettings {
  const connections = config.connections !== undefined && config.connections.length > 0
    ? config.connections
    : [flatConnection(config)]
  const first = connections[0]
  if (first === undefined) return { connections: [], activeId: '' }
  const requested = config.activeId
  const activeId = requested !== undefined && connections.some(profile => profile.id === requested)
    ? requested
    : first.id
  return { connections, activeId }
}

/**
 * The User Settings section the database page edits.
 *
 * Both keys take a default, because a user layer holds only what the user
 * changed: a document that carries connections but no `activeId` is normal, and
 * a section that refused it would leave the tools reading the composition layer
 * instead of everything the user saved.
 */
export const DatabaseSettingsSchema: z<DatabaseSettings> = z.object({
  connections: z.array(ProfileSchema).default([]),
  activeId: z.string().default(''),
})
