/**
 * Contract shared by both faces of the plugin: the settings namespace, the
 * connection profile shape, the section that holds the saved profiles, and the
 * exact Fetch route the browser page calls. This module is client-safe — it
 * imports nothing.
 *
 * The connection a dialect is handed is `DatabaseConnection` in `dialect.ts`;
 * it is server-side only, and the browser half never sees one.
 *
 * @module dsh-ds-db/src/contract
 */

/** Settings namespace owning the saved connections. */
export const MYSQL_SETTINGS_NAMESPACE = 'ds-db'

/** Exact Fetch route on the authenticated `/api` channel that probes a connection. */
export const MYSQL_TEST_PATH = '/api/ds-db/test'

/** Exact Fetch route the page reads the installable database types from. */
export const MYSQL_DIALECTS_PATH = '/api/ds-db/dialects'

/** Credential reference resolved when a profile names none. */
export const DEFAULT_PASSWORD_REF = 'DSH_MYSQL_PASSWORD'

/** Id of the connection a deployment that configures nothing gets. */
export const DEFAULT_CONNECTION_ID = 'default'

/**
 * One saved connection: the fields a card renders and a dialect session opens
 * against.
 *
 * The password is not part of this record: it carries the name of a credential
 * reference, and the secret itself lives in the credential store.
 */
export interface MysqlSettings {
  /** Stable id the section's `activeId` addresses. */
  id: string
  /** Display name the settings page shows on the card. */
  name: string
  /** Registered database dialect this connection is addressed through. */
  dialect: string
  /** Values of the extra fields this connection's dialect declared; empty by default. */
  extra: Record<string, string | number>
  /** Server host name or address. */
  host: string
  /** Server TCP port. */
  port: number
  /** Account the plugin connects as. */
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

/**
 * The section the settings page edits: the saved connections and the one the
 * tools address. An `activeId` that names no saved connection resolves to the
 * only saved connection when there is exactly one, and is a refusal otherwise.
 */
export interface DatabaseSettings {
  /** Saved connections, in the order the page lists them. */
  connections: MysqlSettings[]
  /** The connection the tools address. */
  activeId: string
}

/** One database type the page can offer, as the Host describes it. */
export interface DialectDescriptor {
  /** Registry key a connection's `dialect` field names. */
  name: string
  /** How the type names itself. */
  label: string
  /** Metadata abilities it declares. */
  capabilities: string[]
  /** Connection fields it needs beyond the shared ones. */
  configFields: {
    key: string
    kind: 'text' | 'number' | 'secret-ref'
    default: string | number
    required: boolean
    label?: string
    sensitive?: boolean
  }[]
}

/** One database type that is known but has no dialect package installed. */
export interface KnownDialectPackage {
  /** Registry key a package would register. */
  name: string
  /** How the type names itself. */
  label: string
  /** Package a deployment installs to get it. */
  package: string
}

/** What the page reads from the dialect-catalog route. */
export interface DialectCatalog {
  /** Dialects registered in this deployment, sorted by name. */
  installed: DialectDescriptor[]
  /** Known types no package has registered here. */
  known: KnownDialectPackage[]
}

/**
 * What the settings page sends to probe a connection: an unsaved draft, or the
 * id of a saved one. Absent means the connection the tools currently address.
 */
export interface ProbeRequest {
  /** Id of a saved connection to probe. */
  id?: string
  /** Unsaved draft to probe, as the dialog's form holds it. */
  profile?: MysqlSettings
}
