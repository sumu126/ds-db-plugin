/**
 * The database dialect seam: everything the supported servers differ in lives
 * behind one interface, so the tools, the configuration page, and the session
 * runner stay dialect-neutral.
 *
 * The interface carries both mechanism (how to open a session, which metadata
 * statements to run, how to bound a statement, how to quote an identifier,
 * which syntax is refused) and the facts the model-facing text needs (what the
 * dialect calls itself, which statement families it admits, what its row bound
 * is spelled). A dialect owns its own driver, its own placeholder style, and
 * its own row projection, so nothing above it has to know either.
 *
 * @module dsh-ds-db/src/dialect
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import type { ReadOnlyRules } from './sql-guard.ts'
import type { DbRow, DbScalar } from './value.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Registry of the database dialects this deployment can address. */
    databaseDialects: DatabaseDialectRegistry
  }
}

/**
 * One metadata ability a database may or may not offer.
 *
 * A dialect declares the set it really provides; a tool degrades on a missing
 * one instead of running a statement the server does not have. The set is
 * extensible: an unknown key is refused at registration rather than at compile
 * time.
 */
export type DialectCapability =
  /** Listing the databases the connection can see. */
  | 'databases'
  /** Listing one database's tables and views. */
  | 'tables'
  /** Describing one table's columns. */
  | 'columns'
  /** Describing one table's indexes. */
  | 'indexes'
  /** Producing the statement that creates a table. */
  | 'createStatement'
  /** Estimating a table's row count. */
  | 'estimatedRows'
  /** Reporting a database's character set and collation. */
  | 'charset'
  /** Answering the server's version. */
  | 'version'
  /** Sampling a few rows cheaply. */
  | 'sample'
  /** Explaining one statement's plan. */
  | 'explain'

/** Every capability a dialect may declare. */
export const DIALECT_CAPABILITIES: readonly DialectCapability[] = [
  'databases', 'tables', 'columns', 'indexes', 'createStatement',
  'estimatedRows', 'charset', 'version', 'sample', 'explain',
]

/** Whether one value is a declared capability, for the registry's own checks. */
function isCapability(value: unknown): value is DialectCapability {
  return typeof value === 'string' && DIALECT_CAPABILITIES.includes(value as DialectCapability)
}

/** Connection identity as the host resolves it, password included. */
export interface DatabaseConnection {
  /** Server host name or address. */
  host: string
  /** Server TCP port. */
  port: number
  /** Account the plugin connects as. */
  user: string
  /** Plaintext password resolved from the credential store for this call. */
  password: string
  /**
   * Default database, schema, or service the dialect addresses; absent when the
   * configuration names none. What a dialect reads here is its own affair: the
   * servers disagree on whether this is a schema or a service name.
   */
  database?: string
  /**
   * Values of the connection fields this dialect declared, keyed by its own
   * field keys; empty when it declares none. A dialect reads its own keys here
   * and never another dialect's.
   */
  extra: Record<string, string | number>
  /** TCP connect timeout in milliseconds. */
  connectTimeoutMs: number
  /** Per-statement execution timeout in milliseconds. */
  queryTimeoutMs: number
  /** Maximum rows one tool call returns. */
  maxRows: number
}

/** One statement plus the values its own driver binds, in that driver's placeholder style. */
export interface DialectStatement {
  /** Statement text, written in this dialect's own placeholder style. */
  readonly sql: string
  /** Values bound to that statement, in the same order. */
  readonly values: readonly DbScalar[]
}

/**
 * One metadata query and the projection of its rows.
 *
 * The pair travels together because row column names are the dialect's, not the
 * tool's: each dialect promises the shape its projection returns, and the tool
 * above it never sees a column name.
 */
export interface DialectQuery<R> {
  /** The statement to run. */
  readonly statement: DialectStatement
  /** Normalize one projected driver row onto the shape the tool reports. */
  readonly project: (row: DbRow) => R
}

/** One database as `db_databases` reports it. */
export interface DialectDatabaseRow {
  /** Database name. */
  name: string
  /** Default character set, empty when the server reports none. */
  charset: string
  /** Default collation, empty when the server reports none. */
  collation: string
}

/** One table or view as `db_tables` reports it. */
export interface DialectTableRow {
  /** Table or view name. */
  name: string
  /** How the server classifies it: a stored table or a view. */
  type: string
  /** Storage engine, or null where the server has none. */
  engine: string | null
  /** Row-count estimate, or null when the server cannot estimate it. */
  estimatedRows: number | null
  /** Table comment, empty when it carries none. */
  comment: string
}

/** One column as `db_describe` reports it. */
export interface DialectColumnRow {
  /** Column name. */
  name: string
  /** Full column type, such as `varchar(64)` or `int unsigned`. */
  type: string
  /** Whether the column admits null. */
  nullable: boolean
  /** Default value as the server renders it, or null when it has none. */
  default: string | null
  /** Key role the server reports, such as `PRI` or `UNI`; empty when there is none. */
  key: string
  /** Server-side extras, such as `auto_increment`; empty when there are none. */
  extra: string
  /** Column comment, empty when it carries none. */
  comment: string
}

/** One index position as `db_describe` reads it, before the tool groups by name. */
export interface DialectIndexRow {
  /** Index name. */
  name: string
  /** Whether the index rejects duplicate values. */
  unique: boolean
  /** Index algorithm, such as `BTREE` or `FULLTEXT`, empty when the server reports none. */
  type: string
  /** The column this position indexes. */
  columnName: string
}

/** One open session: statements run on it until the identity changes or the plugin unloads. */
export interface DialectSession {
  /**
   * Run one statement on this session.
   * @param statement - the statement and the values its driver binds.
   * @returns the raw driver rows plus the result's column names.
   */
  run(statement: DialectStatement): Promise<{ rows: unknown[], columns: string[] }>
  /** Release the session's resources. The runner contains any failure here. */
  close(): Promise<void>
}

/**
 * One connection field a dialect needs beyond the shared ones.
 *
 * The settings page renders these under the connection's own dialect and stores
 * the values in {@link DatabaseConnection.extra} under {@link key}.
 */
export interface DialectConfigField {
  /** Key the value is stored under; an identifier the dialect reads back. */
  readonly key: string
  /** Control the page renders, and the value type the field holds. */
  readonly kind: 'text' | 'number' | 'secret-ref'
  /** Value the page seeds the control with. */
  readonly default: string | number
  /** Whether an empty value blocks the tool call that needs it. */
  readonly required: boolean
  /** Dictionary key of this field's hint; falls back to {@link label}. */
  readonly hintKey?: string
  /** Label the page shows, and the fallback when no dictionary holds `hintKey`. */
  readonly label?: string
  /** Whether the control is write-only, for values that are secrets. */
  readonly sensitive?: boolean
}

/**
 * One supported database: its driver, its metadata statements, and its syntax.
 *
 * A dialect is a plain object registered into {@link DatabaseDialectRegistry},
 * so a second server can be added as its own package without this one changing.
 */
export interface DatabaseDialect {
  /** Registry key, such as `mysql`; the configuration selects by this. */
  readonly name: string
  /** How the dialect names itself in model-facing text, such as `MySQL`. */
  readonly label: string
  /** How this dialect's statements are judged before execution. */
  readonly rules: ReadOnlyRules
  /** The metadata abilities this dialect really provides; tools degrade on the rest. */
  readonly capabilities: ReadonlySet<DialectCapability>
  /** Connection fields only this dialect needs, rendered by the settings page. */
  readonly configFields: readonly DialectConfigField[]
  /** The row-bound clause a model should write itself, such as `LIMIT`. */
  readonly rowBoundHint: string
  /** Schemas the server owns, hidden by `db_databases` unless the call asks for them. */
  readonly systemDatabases: readonly string[]
  /**
   * Open a session for one connection identity.
   * @param connection - the resolved connection, including its timeouts.
   * @returns the session the runner holds until the identity changes.
   */
  open(connection: DatabaseConnection): Promise<DialectSession>
  /**
   * Bound a row-producing statement, so a forgotten bound cannot stream an
   * unbounded table into the model's context.
   * @param statement - an already-judged read-only statement.
   * @param maxRows - the deployment's row cap.
   * @returns the statement to execute, bounded when it carried no bound of its own.
   */
  applyRowLimit(statement: string, maxRows: number): string
  /**
   * Quote one identifier so a name carrying a quote character cannot leave its own statement.
   * @param name - the identifier to quote.
   * @returns the quoted identifier.
   */
  quoteIdentifier(name: string): string
  /** @returns the query listing the databases this connection can see. */
  databases(): DialectQuery<DialectDatabaseRow>
  /**
   * @param database - the database to list.
   * @returns the query listing its tables and views.
   */
  tables(database: string): DialectQuery<DialectTableRow>
  /**
   * @param database - the database holding the table.
   * @param table - the table to describe.
   * @returns the query listing its columns in definition order.
   */
  columns(database: string, table: string): DialectQuery<DialectColumnRow>
  /**
   * @param database - the database holding the table.
   * @param table - the table to describe.
   * @returns the query listing its index positions in key order.
   */
  indexes(database: string, table: string): DialectQuery<DialectIndexRow>
  /**
   * @param database - the database holding the table.
   * @param table - the table to describe.
   * @returns the query answering the statement that creates it.
   */
  createStatement(database: string, table: string): DialectQuery<string>
  /** @returns the query answering the server's version. */
  version(): DialectQuery<string>
  /**
   * Read a few rows from one table, for `db_sample`.
   *
   * Optional, and only a dialect declaring the `sample` capability provides it:
   * the tool is registered for the dialects that can answer and is absent for
   * the rest, rather than failing at call time.
   * @param database - the database holding the table.
   * @param table - the table to read.
   * @param rows - how many rows to read.
   * @returns the query reading them.
   */
  sample?(database: string, table: string, rows: number): DialectQuery<DbRow>
  /**
   * Explain one statement's plan, for `db_explain`. Optional, as `sample` is.
   * @param statement - an already-judged read-only statement.
   * @returns the query answering the plan.
   */
  explain?(statement: string): DialectQuery<string>
}

/**
 * The dialects one deployment can address.
 *
 * The plugin provides this registry and registers its own dialect into it; a
 * further dialect ships as its own package, which injects `databaseDialects`
 * and registers itself. Registration is an effect: {@link register} returns the
 * disposer that removes the dialect again.
 */
export class DatabaseDialectRegistry extends Service {
  private readonly dialects = new Map<string, DatabaseDialect>()

  /** @param ctx - the plugin context that owns this registry. */
  constructor(ctx: Context) {
    super(ctx, 'databaseDialects')
  }

  /**
   * Register one dialect under its own name.
   * @param dialect - the dialect to register.
   * @returns the disposer removing it again.
   * @throws {Error} when the name is already taken, because two dialects under one name cannot compose.
   */
  register(dialect: DatabaseDialect): () => void {
    if (this.dialects.has(dialect.name)) {
      throw new Error(`database dialect "${dialect.name}" is already registered`)
    }
    // Registered, not declared at the type level: an undeclared capability or a
    // malformed field key would silently degrade a tool or write an unreadable
    // setting, and both are failures a registration can name.
    for (const capability of dialect.capabilities) {
      if (!isCapability(capability)) {
        throw new Error(`database dialect "${dialect.name}" declares unknown capability "${String(capability)}"`)
      }
    }
    for (const field of dialect.configFields) {
      if (!/^[a-z][A-Za-z0-9]*$/.test(field.key)) {
        throw new Error(`database dialect "${dialect.name}" declares a config field with an unusable key "${field.key}"`)
      }
    }
    // An optional method is optional, but declaring the ability without it
    // would register a tool that can only fail; registration names that.
    if (dialect.capabilities.has('sample') && dialect.sample === undefined) {
      throw new Error(`database dialect "${dialect.name}" declares "sample" but implements no sample()`)
    }
    if (dialect.capabilities.has('explain') && dialect.explain === undefined) {
      throw new Error(`database dialect "${dialect.name}" declares "explain" but implements no explain()`)
    }
    this.dialects.set(dialect.name, dialect)
    return () => { this.dialects.delete(dialect.name) }
  }

  /**
   * The dialect registered under one name.
   * @param name - the registry key, as the configuration spells it.
   * @returns the dialect, or undefined while nothing is registered under that name.
   */
  get(name: string): DatabaseDialect | undefined {
    return this.dialects.get(name)
  }

  /** @returns every registered dialect name, sorted. */
  names(): string[] {
    return [...this.dialects.keys()].sort()
  }
}

/**
 * The dialect a name resolves to, or the failure naming what is registered.
 *
 * Resolution happens per call rather than at load, because a dialect may arrive
 * on a later layer: a row that registers one can activate after this plugin.
 * @param registry - the dialects registered in this deployment.
 * @param name - the configured dialect name.
 * @returns the resolved dialect.
 * @throws {Error} when nothing is registered under that name.
 */
export function resolveDialect(registry: DatabaseDialectRegistry, name: string): DatabaseDialect {
  const dialect = registry.get(name)
  if (dialect !== undefined) return dialect
  const registered = registry.names()
  throw new Error(registered.length === 0
    ? `no database dialect is registered, so "${name}" cannot be resolved`
    : `database dialect "${name}" is not registered; registered dialects: ${registered.join(', ')}`)
}