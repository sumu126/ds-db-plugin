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
import {
  DEFAULT_CONNECTION_ID, DEFAULT_PASSWORD_REF, UNSET_PORT,
  type ConnectionProfile, type DatabaseSettings,
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
  /** Registered dialect the flat connection addresses; empty means the first one registered. @default '' */
  dialect?: string
  /** Saved connections a deployment preprovisions; the flat fields are ignored when present. */
  connections?: ConnectionProfile[]
  /** The connection the tools address by id; defaults to the first saved one. */
  activeId?: string
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
}

/** Validated composition configuration. */
export const Config: z<Config> = z.object({
  host: z.string(),
  port: z.natural().max(65535),
  user: z.string(),
  database: z.string(),
  passwordEnv: z.string().pattern(IDENTIFIER),
  connectTimeoutMs: z.natural().min(1),
  queryTimeoutMs: z.natural().min(1),
  maxRows: z.natural().min(1),
  dialect: z.string(),
  connections: z.array(ProfileSchema),
  activeId: z.string(),
  dialectWaitMs: z.natural().min(1),
  sessionLimit: z.natural().min(1),
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
