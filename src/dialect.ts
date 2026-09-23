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
import type { ConnectionDefaults } from './contract.ts'
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
  /**
   * The call's cancellation signal, when the caller has one.
   *
   * A dialect cancels as far as its driver allows: a driver that takes an
   * `AbortSignal` forwards it, and one that does not ends the session instead —
   * the runner then drops that session so the next call opens a fresh one.
   */
  readonly signal?: AbortSignal
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
  /**
   * One line the page shows under the control.
   *
   * The text is the dialect's, not the plugin's: what a field means is a fact
   * about the server that declared it, and the plugin's dictionary cannot hold
   * a sentence for every dialect's fields.
   */
  readonly hint?: string
  /** Label the page shows; the field's key is the fallback when it names none. */
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
  /**
   * One line about this type, shown on the settings page's type chooser.
   *
   * The plugin cannot write it: only the dialect knows what it connects
   * through and what it offers.
   */
  readonly description?: string
  /**
   * Values this server gives the shared connection fields.
   *
   * A port and an account name are facts about a server, not about read-only
   * database access, so the plugin declares no default for them: a dialect that
   * names none leaves the field for the user to fill.
   */
  readonly connectionDefaults?: ConnectionDefaults
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
 * Waiting key for "any dialect": a connection that names no database type
 * addresses whichever dialect registers first, so it waits for one rather than
 * for a name.
 */
const ANY_DIALECT = ''

/**
 * The dialects one deployment can address.
 *
 * The plugin provides this registry and ships no dialect of its own: every
 * database type, MySQL included, arrives as a package that injects
 * `databaseDialects` and registers itself. Registration is an effect:
 * {@link register} returns the disposer that removes the dialect again.
 */
export class DatabaseDialectRegistry extends Service {
  private readonly dialects = new Map<string, DatabaseDialect>()
  private readonly waiting = new Map<string, Set<() => void>>()

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
    // Listeners run synchronously here, so a caller that registers a tool set
    // from one sees the dialect before any call can arrive. The empty key waits
    // for any dialect, which is what a connection naming none needs.
    this.wake(dialect.name)
    this.wake(ANY_DIALECT)
    return () => { this.dialects.delete(dialect.name) }
  }

  /** Run and clear every listener waiting on one key. */
  private wake(name: string): void {
    const waiting = this.waiting.get(name)
    if (waiting === undefined) return
    this.waiting.delete(name)
    for (const listener of waiting) listener()
  }

  /**
   * The dialect a connection with no named type addresses.
   * @returns the first registered dialect in name order, or undefined when none is registered.
   */
  first(): DatabaseDialect | undefined {
    const [name] = this.names()
    return name === undefined ? undefined : this.dialects.get(name)
  }

  /**
   * Run one listener as soon as a dialect under `name` is registered.
   *
   * A dialect package always loads after this plugin — the registry is provided
   * here — so a caller that must act on a dialect's own facts waits instead of
   * reading whatever is registered at load time.
   * @param name - the registry key to wait for.
   * @param listener - what to run once it is registered.
   * @returns the disposer removing the wait again.
   */
  whenRegistered(name: string, listener: () => void): () => void {
    const key = name.trim().length === 0 ? ANY_DIALECT : name
    const satisfied = key === ANY_DIALECT ? this.dialects.size > 0 : this.dialects.has(key)
    if (satisfied) {
      listener()
      return () => {}
    }
    const waiting = this.waiting.get(key) ?? new Set<() => void>()
    waiting.add(listener)
    this.waiting.set(key, waiting)
    return () => { waiting.delete(listener) }
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
 * The dialect facts a model-facing description is written from.
 *
 * It is the part of {@link DatabaseDialect} the tools read at registration
 * time, kept separate so a description can be written before a dialect package
 * has loaded: the plugin knows only the name until then.
 */
export interface DialectFacts {
  /** How the dialect names itself, such as `MySQL`. */
  readonly label: string
  /** The metadata abilities it declares. */
  readonly capabilities: ReadonlySet<DialectCapability>
  /** The connection fields it declares. */
  readonly configFields: readonly DialectConfigField[]
  /** The row-bound clause a model should write itself. */
  readonly rowBoundHint: string
  /** Schemas the server owns. */
  readonly systemDatabases: readonly string[]
  /** How its statements are judged before execution. */
  readonly rules: ReadOnlyRules
}

/**
 * The rules of a dialect that has not loaded yet: nothing is admitted, so an
 * unregistered dialect cannot be talked past the guard while it is missing.
 */
const UNREGISTERED_RULES: ReadOnlyRules = {
  lexical: { quotes: [], lineComments: [] },
  lead: /(?!)/,
  families: [],
  forbidden: [],
}

/**
 * The facts to write descriptions from, whether or not the dialect has loaded.
 *
 * The registry is provided by this plugin, so a dialect package always loads
 * after it; descriptions are therefore written from whatever is registered at
 * that moment, and a dialect that arrives later still runs every call. Until it
 * does, its facts are the refusing stand-in above and its label is its name.
 * @param registry - the dialects registered in this deployment.
 * @param name - the configured dialect name.
 * @returns the dialect's facts, or the stand-in when nothing is registered yet.
 */
export function dialectFacts(registry: DatabaseDialectRegistry, name: string): DialectFacts {
  const key = name.trim()
  // An unnamed dialect is the deployment's first registered one, exactly as
  // `resolveDialect` reads it, so descriptions match the calls they describe.
  const dialect = key.length === 0 ? registry.first() : registry.get(key)
  if (dialect !== undefined) {
    return {
      label: dialect.label,
      capabilities: dialect.capabilities,
      configFields: dialect.configFields,
      rowBoundHint: dialect.rowBoundHint,
      systemDatabases: dialect.systemDatabases,
      rules: dialect.rules,
    }
  }
  return {
    // A description still has to read as English while the type is unknown, so
    // the stand-in names the connection rather than printing an empty name.
    label: name.trim().length === 0 ? 'configured' : name,
    capabilities: new Set<DialectCapability>(),
    configFields: [],
    rowBoundHint: '',
    systemDatabases: [],
    rules: UNREGISTERED_RULES,
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
  const key = name.trim()
  // An unnamed dialect is the deployment's first registered one: the plugin
  // names no database type of its own, so a composition layer need not either.
  const dialect = key.length === 0 ? registry.first() : registry.get(key)
  if (dialect !== undefined) return dialect
  const registered = registry.names()
  if (key.length === 0) {
    throw new Error('no database dialect is registered; install a dialect package, such as dsh-dialect-mysql')
  }
  throw new Error(registered.length === 0
    ? `no database dialect is registered, so "${key}" cannot be resolved`
    : `database dialect "${key}" is not registered; registered dialects: ${registered.join(', ')}`)
}