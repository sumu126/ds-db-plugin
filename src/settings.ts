/**
 * Host-side MySQL settings: the Schemastery schema the configuration page
 * renders and the composition entry the namespace falls back to when no
 * settings provider is mounted.
 *
 * @module dsh-ds-db/src/settings
 */

import z from '@deepseek-ai/schemastery'
import { DEFAULT_PASSWORD_REF } from './contract.ts'
import type { MysqlSettings } from './contract.ts'

/**
 * Connection values a deployment that configures nothing gets. They point at a
 * local server because that is the only guess that is never wrong about a
 * remote host.
 */
export const MYSQL_DEFAULTS: MysqlSettings = {
  host: '127.0.0.1',
  port: 3306,
  user: 'root',
  database: '',
  passwordEnv: DEFAULT_PASSWORD_REF,
  connectTimeoutMs: 10_000,
  queryTimeoutMs: 30_000,
  maxRows: 200,
}

/**
 * Composition configuration of the `ds-db` row in `cordis.yml`.
 *
 * Every field is deployment-varying, so none of them is a constant in the
 * plugin body: these are the values the MySQL settings page overrides per user.
 */
export interface Config {
  /** MySQL server host name or address. @default '127.0.0.1' */
  host?: string
  /** MySQL server TCP port. @default 3306 */
  port?: number
  /** MySQL account the plugin connects as. @default 'root' */
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
  /**
   * Registered database dialect this row addresses. Defaults to this plugin's
   * own dialect; name another one to run the same tools against it.
   */
  dialect?: string
}

/** Validated composition configuration. */
export const Config: z<Config> = z.object({
  host: z.string().min(1),
  port: z.natural().max(65535),
  user: z.string().min(1),
  database: z.string(),
  passwordEnv: z.string().pattern(/^[A-Za-z_][A-Za-z0-9_]*$/),
  connectTimeoutMs: z.natural().min(1),
  queryTimeoutMs: z.natural().min(1),
  maxRows: z.natural().min(1),
  dialect: z.string().min(1),
})

/**
 * The settings section a deployment that mounts no settings provider still
 * runs on: the composition values over the built-in defaults.
 * @param config - the validated composition configuration.
 * @returns the complete section the namespace resolves to.
 */
export function compositionEntry(config: Config): MysqlSettings {
  return {
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
 * The User Settings section the MySQL page edits.
 *
 * Defaults mirror {@link MYSQL_DEFAULTS} so the page renders the same values a
 * deployment gets before anyone edits anything; the composition entry is what
 * actually supplies them once a provider is mounted.
 */
export const MysqlSettingsSchema: z<MysqlSettings> = z.object({
  host: z.string().min(1).default(MYSQL_DEFAULTS.host),
  port: z.natural().max(65535).default(MYSQL_DEFAULTS.port),
  user: z.string().min(1).default(MYSQL_DEFAULTS.user),
  database: z.string().default(MYSQL_DEFAULTS.database),
  passwordEnv: z.string().pattern(/^[A-Za-z_][A-Za-z0-9_]*$/).default(MYSQL_DEFAULTS.passwordEnv),
  connectTimeoutMs: z.natural().min(1).default(MYSQL_DEFAULTS.connectTimeoutMs),
  queryTimeoutMs: z.natural().min(1).default(MYSQL_DEFAULTS.queryTimeoutMs),
  maxRows: z.natural().min(1).default(MYSQL_DEFAULTS.maxRows),
})
