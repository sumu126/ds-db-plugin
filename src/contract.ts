/**
 * Contract shared by both faces of the plugin: the settings namespace and its
 * field names, the connection defaults, and the exact Fetch route the browser
 * page calls. This module is client-safe — it imports nothing.
 *
 * The connection a dialect is handed is `DatabaseConnection` in `dialect.ts`;
 * it is server-side only, and the browser half never sees one.
 *
 * @module dsh-ds-db/src/contract
 */

/** Settings namespace owning the connection. */
export const MYSQL_SETTINGS_NAMESPACE = 'ds-db'

/** Exact Fetch route on the authenticated `/api` channel that probes the connection. */
export const MYSQL_TEST_PATH = '/api/ds-db/test'

/** Credential reference resolved when the section names none. */
export const DEFAULT_PASSWORD_REF = 'DSH_MYSQL_PASSWORD'

/** Every field of the MySQL settings section, in page order. */
export const MYSQL_SETTINGS_FIELDS = [
  'host', 'port', 'user', 'database', 'passwordEnv',
  'connectTimeoutMs', 'queryTimeoutMs', 'maxRows',
] as const

/** One field of the MySQL settings section. */
export type MysqlSettingsField = typeof MYSQL_SETTINGS_FIELDS[number]

/**
 * Connection and limit fields the configuration page edits and the tools read.
 *
 * The password is not part of this section: the section carries the name of a
 * credential reference, and the secret itself lives in the credential store.
 */
export interface MysqlSettings {
  /** MySQL server host name or address. */
  host: string
  /** MySQL server TCP port. */
  port: number
  /** MySQL account the plugin connects as. */
  user: string
  /** Default database; empty means every tool call must name one. */
  database: string
  /** Credential reference holding this account's password. */
  passwordEnv: string
  /** TCP connect timeout in milliseconds. */
  connectTimeoutMs: number
  /** Per-statement execution timeout in milliseconds. */
  queryTimeoutMs: number
  /** Maximum rows one `db_query` call returns. */
  maxRows: number
}
