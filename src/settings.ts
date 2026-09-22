/**
 * Host-side settings: the Schemastery schema the configuration page renders,
 * and the composition entry the namespace falls back to when no settings
 * provider is mounted.
 *
 * The composition layer keeps the flat single-connection shape it has always
 * had: a deployment that configures nothing gets one MySQL connection on
 * localhost, and a deployment that names fields in `cordis.yml` gets that one
 * connection with its values. A deployment that wants several connections
 * preprovisions them with `connections`.
 *
 * @module dsh-ds-db/src/settings
 */

import z from '@deepseek-ai/schemastery'
import { DEFAULT_CONNECTION_ID, DEFAULT_PASSWORD_REF, type DatabaseSettings, type MysqlSettings } from './contract.ts'

/**
 * Connection values a deployment that configures nothing gets. They point at a
 * local server because that is the only guess that is never wrong about a
 * remote host.
 */
export const MYSQL_DEFAULTS: MysqlSettings = {
  id: DEFAULT_CONNECTION_ID,
  name: 'MySQL',
  dialect: 'mysql',
  extra: {},
  host: '127.0.0.1',
  port: 3306,
  user: 'root',
  database: '',
  passwordEnv: DEFAULT_PASSWORD_REF,
  connectTimeoutMs: 10_000,
  queryTimeoutMs: 30_000,
  maxRows: 200,
}

/** Credential-reference shape, shared by every schema that carries one. */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

/** One saved connection, as a settings section item or a `connections` entry. */
export const ProfileSchema: z<MysqlSettings> = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  dialect: z.string().min(1),
  // Values of the fields the connection's dialect declared. The dialect owns
  // the keys and their meaning, so the section validates the shape only.
  extra: z.dict(z.union([z.string(), z.number()])),
  host: z.string().min(1),
  port: z.natural().max(65535),
  user: z.string().min(1),
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
 * `connections` replaces them with a preprovisioned list.
 */
export interface Config {
  /** Server host name or address. @default '127.0.0.1' */
  host?: string
  /** Server TCP port. @default 3306 */
  port?: number
  /** Account the plugin connects as. @default 'root' */
  user?: string
  /** Default database; empty means every tool call names one. @default '' */
  database?: string
  /** Credential reference holding the account password. @default 'DSH_MYSQL_PASSWORD' */
  passwordEnv?: string
  /** TCP connect timeout in milliseconds. @default 10000 */
  connectTimeoutMs?: number
  /** Per-statement execution timeout in milliseconds. @default 30000 */
  queryTimeoutMs?: number
  /** Maximum rows one `db_query` call returns. @default 200 */
  maxRows?: number
  /** Registered database dialect the flat connection addresses. @default 'mysql' */
  dialect?: string
  /** Saved connections a deployment preprovisions; the flat fields are ignored when present. */
  connections?: MysqlSettings[]
  /** The connection the tools address by id; defaults to the first saved one. */
  activeId?: string
}

/** Validated composition configuration. */
export const Config: z<Config> = z.object({
  host: z.string().min(1),
  port: z.natural().max(65535),
  user: z.string().min(1),
  database: z.string(),
  passwordEnv: z.string().pattern(IDENTIFIER),
  connectTimeoutMs: z.natural().min(1),
  queryTimeoutMs: z.natural().min(1),
  maxRows: z.natural().min(1),
  dialect: z.string().min(1),
  connections: z.array(ProfileSchema),
  activeId: z.string(),
})

/** The flat connection the composition fields describe. */
function flatConnection(config: Config): MysqlSettings {
  return {
    id: DEFAULT_CONNECTION_ID,
    name: MYSQL_DEFAULTS.name,
    dialect: config.dialect ?? MYSQL_DEFAULTS.dialect,
    extra: {},
    host: config.host ?? MYSQL_DEFAULTS.host,
    port: config.port ?? MYSQL_DEFAULTS.port,
    user: config.user ?? MYSQL_DEFAULTS.user,
    database: config.database ?? MYSQL_DEFAULTS.database,
    passwordEnv: config.passwordEnv ?? MYSQL_DEFAULTS.passwordEnv,
    connectTimeoutMs: config.connectTimeoutMs ?? MYSQL_DEFAULTS.connectTimeoutMs,
    queryTimeoutMs: config.queryTimeoutMs ?? MYSQL_DEFAULTS.queryTimeoutMs,
    maxRows: config.maxRows ?? MYSQL_DEFAULTS.maxRows,
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
 * The page writes complete records: every connection it saves carries all
 * fields, so the section schema validates strictly rather than defaulting.
 */
export const DatabaseSettingsSchema: z<DatabaseSettings> = z.object({
  connections: z.array(ProfileSchema),
  activeId: z.string(),
})
