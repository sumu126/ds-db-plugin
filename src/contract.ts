/**
 * Contract shared by both faces of the plugin: the settings namespace, the
 * connection profile shape, the section that holds the saved profiles, and the
 * exact Fetch routes the browser page calls. This module is client-safe — it
 * imports nothing.
 *
 * Nothing here names a database type. A connection's shared fields (host, port,
 * user, database, password reference) exist for every server; what values they
 * should default to is the dialect's own declaration, carried in
 * {@link ConnectionDefaults}.
 *
 * @module dsh-ds-db/src/contract
 */

/** Settings namespace owning the saved connections. */
export const DB_SETTINGS_NAMESPACE = 'ds-db'

/** Exact Fetch route on the authenticated `/api` channel that probes a connection. */
export const DB_TEST_PATH = '/api/ds-db/test'

/** Exact Fetch route the page reads the installable database types from. */
export const DB_DIALECTS_PATH = '/api/ds-db/dialects'

/** Exact Fetch route the browser catalog reads the databases of one connection from. */
export const DB_DATABASES_PATH = '/api/ds-db/databases'

/** Exact Fetch route the browser catalog reads the tables of one database from. */
export const DB_TABLES_PATH = '/api/ds-db/tables'

/** Credential reference a connection uses when its dialect declares none. */
export const DEFAULT_PASSWORD_REF = 'DSH_DB_PASSWORD'

/** Id of the connection a deployment that configures nothing gets. */
export const DEFAULT_CONNECTION_ID = 'default'

/** Port a connection carries before its dialect supplies one. */
export const UNSET_PORT = 0

/**
 * Values a dialect gives the shared connection fields.
 *
 * A connection's fields are shared because every SQL server has them; their
 * defaults are not, because a server's port and account name are facts about
 * that server. A dialect that declares none leaves the field for the user.
 */
export interface ConnectionDefaults {
  /** Server host name or address. */
  host?: string
  /** Server TCP port. */
  port?: number
  /** Account to connect as. */
  user?: string
  /** Default database; empty means every tool call names one. */
  database?: string
  /** Credential reference holding the account password. */
  passwordEnv?: string
}

/**
 * One saved connection: the fields a card renders and a dialect session opens
 * against.
 *
 * The password is not part of this record: it carries the name of a credential
 * reference, and the secret itself lives in the credential store.
 */
export interface ConnectionProfile {
  /** Stable id the section's `activeId` addresses. */
  id: string
  /** Display name the settings page shows on the card. */
  name: string
  /**
   * Registered dialect this connection is addressed through; empty means the
   * first dialect the deployment registered, so a composition layer need not
   * name a database type to get a working plugin.
   */
  dialect: string
  /** Values of the extra fields this connection's dialect declared; empty by default. */
  extra: Record<string, string | number>
  /** Server host name or address. */
  host: string
  /** Server TCP port, or {@link UNSET_PORT} to take the dialect's own default. */
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
  connections: ConnectionProfile[]
  /** The connection the tools address. */
  activeId: string
}

/** One connection field a dialect declared, as the page renders it. */
export interface DialectFieldDescriptor {
  /** Key the value is stored under. */
  key: string
  /** Control the page renders, and the value type it holds. */
  kind: 'text' | 'number' | 'secret-ref'
  /** Value the page seeds the control with. */
  default: string | number
  /** Whether an empty value blocks a tool call that needs it. */
  required: boolean
  /** Label the page shows. */
  label?: string
  /** One line the page shows under the control, written by the dialect. */
  hint?: string
  /** Whether the control is write-only. */
  sensitive?: boolean
}

/** One database type the page can offer, as the Host describes it. */
export interface DialectDescriptor {
  /** Registry key a connection's `dialect` field names. */
  name: string
  /** How the type names itself. */
  label: string
  /** One line about the type, written by the dialect itself. */
  description?: string
  /** Metadata abilities it declares. */
  capabilities: string[]
  /** Connection fields it needs beyond the shared ones. */
  configFields: DialectFieldDescriptor[]
  /** Values it gives the shared connection fields. */
  connectionDefaults: ConnectionDefaults
  /** Schemas the server owns, which `db_databases` hides unless the call asks. */
  systemDatabases: string[]
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

/** One database as the browser catalog lists it. */
export interface DatabaseNode {
  /** Database name. */
  name: string
  /** Default character set, empty when the server reports none or the type cannot report one. */
  charset: string
  /** Default collation, empty on {@link charset}'s terms. */
  collation: string
}

/** One table or view as the browser catalog lists it. */
export interface TableNode {
  /** Table or view name. */
  name: string
  /** How the server classifies it: a stored table or a view. */
  type: string
  /** Storage engine, or null where the server has none. */
  engine: string | null
  /** Row-count estimate, or null where the server cannot estimate it. */
  estimatedRows: number | null
  /** Table comment, empty when it carries none. */
  comment: string
}

/**
 * What the browser catalog reads from the databases route.
 *
 * A refusal is a value here, exactly as it is on the probe route: the panel
 * renders `message` beside a retry instead of reporting a transport failure.
 * The server's own schemas are omitted, the way `db_databases` omits them, so
 * the panel and the model are shown one list.
 */
export interface DatabaseListing {
  /** The connection the list came from, by name; absent when nothing could be listed. */
  connection?: string
  /** Databases the connection sees, in server order. */
  databases: DatabaseNode[]
  /** Why there is no list, as one sentence the panel shows. */
  message?: string
}

/** What the browser catalog reads from the tables route. */
export interface TableListing {
  /** The connection the list came from, by name; absent when nothing could be listed. */
  connection?: string
  /** Database the tables were listed from, echoed as asked. */
  database: string
  /** Tables and views of that database, in server order. */
  tables: TableNode[]
  /** Why there is no list, as one sentence the panel shows. */
  message?: string
}

/**
 * What the settings page sends to probe a connection: an unsaved draft, or the
 * id of a saved one. Absent means the connection the tools currently address.
 */
export interface ProbeRequest {
  /** Id of a saved connection to probe. */
  id?: string
  /** Unsaved draft to probe, as the dialog's form holds it. */
  profile?: ConnectionProfile
}
