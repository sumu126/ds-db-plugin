/**
 * The MySQL dialect, as a plugin of its own.
 *
 * It is a dialect *package* exactly like a third party's: it injects the
 * registry `dsh-ds-db` provides, registers one dialect into it, and owns the
 * MySQL-specific facts — the `mysql2` pool, `information_schema` column names,
 * `?` placeholders, backtick identifiers, `LIMIT` bounding, and the constructs
 * MySQL spells that still write or lock.
 *
 * The core plugin ships no dialect of its own; this package is the only place
 * MySQL is known, and it loads through the same registry path any other
 * dialect package does.
 *
 * @module dsh-dialect-mysql
 */

import type { Context } from '@deepseek-ai/cordis'
import { DIALECT_CAPABILITIES, type DialectCapability } from 'dsh-ds-db/src/dialect.ts'
import type {
  DatabaseConnection, DatabaseDialect, DialectColumnRow, DialectDatabaseRow,
  DialectIndexRow, DialectQuery, DialectSession, DialectStatement, DialectTableRow,
} from 'dsh-ds-db/src/dialect.ts'
import {
  ROW_PRODUCING_LEAD, SHARED_FORBIDDEN, scanStatement,
  type ReadOnlyRules, type SqlLexical,
} from 'dsh-ds-db/src/sql-guard.ts'
import { cellFlag, cellInteger, cellIsZero, cellOptionalText, cellText, type DbRow } from 'dsh-ds-db/src/value.ts'
import mysql from 'mysql2/promise'
import type { FieldPacket, Pool } from 'mysql2/promise'

/** Stable Loader identity. */
export const name = 'dialect-mysql'

/** The registry the core plugin provides is the one service this needs. */
export const inject = ['databaseDialects']

/** Connections one plugin instance holds open. */
const POOL_CONNECTION_LIMIT = 4

/** Queued statements one plugin instance admits before `waitForConnections` blocks. */
const POOL_QUEUE_LIMIT = 32

/**
 * MySQL lexemes: single- and double-quoted strings, backtick identifiers, and
 * the two line-comment forms. Backslashes escape quoted strings but not quoted
 * identifiers, and MySQL alone requires whitespace after the `--` form.
 */
const MYSQL_LEXICAL: SqlLexical = {
  quotes: [
    { quote: '\'', backslashEscapes: true },
    { quote: '"', backslashEscapes: true },
    { quote: '`', backslashEscapes: false },
  ],
  lineComments: [
    { marker: '--', requiresWhitespace: true },
    { marker: '#', requiresWhitespace: false },
  ],
}

/** Statement leads MySQL admits, including the `desc` and `with` spellings. */
const MYSQL_LEAD = /^(?:select|show|describe|desc|explain|with|table|values)\b/i

/** The families the refusal names, in the order it lists them. */
const MYSQL_FAMILIES = ['SELECT', 'SHOW', 'DESCRIBE', 'EXPLAIN', 'TABLE', 'VALUES'] as const

/**
 * Constructs refused on MySQL although they look read-only. The order is the
 * order refusals are reported in, so the shared lock-taking pair sits between
 * MySQL's own two, keeping one statement's refusal message stable.
 */
const MYSQL_FORBIDDEN = [
  { pattern: /\binto\s+(?:outfile|dumpfile)\b/i, reason: 'writes a server-side file' },
  ...SHARED_FORBIDDEN,
  { pattern: /\bprocedure\s+analyse\b/i, reason: 'rewrites index statistics' },
] as const

/** What MySQL statements are judged by. */
const MYSQL_RULES: ReadOnlyRules = {
  lexical: MYSQL_LEXICAL,
  lead: MYSQL_LEAD,
  families: MYSQL_FAMILIES,
  forbidden: MYSQL_FORBIDDEN,
}

/** Schemas MySQL owns, hidden from `db_databases` unless the call asks for them. */
const MYSQL_SYSTEM_DATABASES = ['information_schema', 'mysql', 'performance_schema', 'sys'] as const

/** Column names in result order, or none for a statement that returned no field list. */
function columnsOf(fields: FieldPacket[] | undefined): string[] {
  return (fields ?? []).map(field => field.name)
}

/**
 * The definition statement out of one `SHOW CREATE TABLE` row: the statement is
 * the row's second column, whose name differs between a table and a view.
 * @param row - the first row of the `SHOW CREATE TABLE` result.
 * @returns the definition statement, or the empty string when the server sent none.
 */
function createStatementOf(row: DbRow): string {
  const values = Object.values(row)
  return cellText(values[1] ?? values[0])
}

/** One statement's text and bound values, spelled the way the driver wants them. */
function statement(sql: string, values: readonly (string | number)[] = []): DialectStatement {
  return { sql, values }
}

/** Quote one MySQL identifier, so a name carrying a backtick cannot leave its own statement. */
function quoteMysqlIdentifier(identifier: string): string {
  return `\`${identifier.replaceAll('`', '``')}\``
}

/**
 * A pool-backed MySQL session. The pool is the session: statements run on it
 * until the connection identity changes or the plugin unloads.
 */
class MysqlSession implements DialectSession {
  /**
   * @param pool - the pool this session owns.
   * @param queryTimeoutMs - per-statement execution timeout in milliseconds.
   */
  constructor(private readonly pool: Pool, private readonly queryTimeoutMs: number) {}

  /**
   * Run one statement on the pool.
   * @param query - the statement and its bound values.
   * @returns the raw rows plus the result's column names.
   * @throws {Error} when the server refuses the statement or the result carries no row set.
   */
  async run(query: DialectStatement): Promise<{ rows: unknown[], columns: string[] }> {
    const { signal } = query
    if (signal?.aborted === true) throw new Error('the statement was cancelled before it ran')
    // mysql2 takes no AbortSignal, so cancellation ends the pool instead. The
    // session is unusable afterwards, which is why the runner drops it from its
    // cache and the next call opens a fresh one.
    const cancel = (): void => { void this.pool.end().catch(() => {}) }
    signal?.addEventListener('abort', cancel, { once: true })
    try {
      const [rows, fields] = await this.pool.query({
        sql: query.sql,
        values: [...query.values],
        timeout: this.queryTimeoutMs,
      })
      if (!Array.isArray(rows)) throw new Error('the statement returned no result set')
      return { rows, columns: columnsOf(fields) }
    } finally {
      signal?.removeEventListener('abort', cancel)
    }
  }

  /** Close the pool. */
  async close(): Promise<void> {
    await this.pool.end()
  }
}

/** Build the pool for one resolved connection. */
function createPool(connection: DatabaseConnection): Pool {
  return mysql.createPool({
    host: connection.host,
    port: connection.port,
    user: connection.user,
    password: connection.password,
    ...connection.database === undefined ? {} : { database: connection.database },
    connectTimeout: connection.connectTimeoutMs,
    waitForConnections: true,
    connectionLimit: POOL_CONNECTION_LIMIT,
    queueLimit: POOL_QUEUE_LIMIT,
    enableKeepAlive: true,
    // The read-only posture has three layers: this pool's statement guard, the
    // lexical guard in sql-guard.ts, and the deployment's own read-only account.
    multipleStatements: false,
    // Cells stay in their textual form: `Date`, `bigint`, and `Decimal` are not
    // lossless JSON, and a DATETIME string is what a schema reader wants anyway.
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    decimalNumbers: false,
    rowsAsArray: false,
    timezone: 'Z',
  })
}

/**
 * The MySQL dialect.
 *
 * A connection selects it with `dialect: mysql`. It answers every metadata
 * question the tools can ask, including a sampled row set and an execution
 * plan, so nothing above it degrades.
 */
export const MYSQL_DIALECT: DatabaseDialect = {
  name: 'mysql',
  label: 'MySQL',
  // The type describes itself: the plugin cannot write this line, because the
  // driver and the metadata surface are facts about MySQL.
  description: '通过 mysql2 驱动连接，提供库、表、结构与只读查询。',
  rules: MYSQL_RULES,
  capabilities: new Set<DialectCapability>(DIALECT_CAPABILITIES),
  // MySQL needs no field beyond the shared ones; a server that does declares
  // its own here and reads it back from `connection.extra`.
  configFields: [],
  // MySQL's own values for the shared fields: a port and an account name are
  // facts about this server, so the plugin declares neither.
  connectionDefaults: {
    host: '127.0.0.1',
    port: 3306,
    user: 'root',
    passwordEnv: 'DSH_MYSQL_PASSWORD',
  },
  rowBoundHint: 'LIMIT',
  systemDatabases: MYSQL_SYSTEM_DATABASES,

  async open(connection: DatabaseConnection): Promise<DialectSession> {
    return new MysqlSession(createPool(connection), connection.queryTimeoutMs)
  },

  applyRowLimit(statementText: string, maxRows: number): string {
    const { code } = scanStatement(statementText, MYSQL_LEXICAL)
    if (!ROW_PRODUCING_LEAD.test(code) || /\blimit\b/i.test(code)) return statementText
    return `${statementText}\nLIMIT ${String(maxRows + 1)}`
  },

  quoteIdentifier(identifier: string): string {
    return quoteMysqlIdentifier(identifier)
  },

  databases(): DialectQuery<DialectDatabaseRow> {
    return {
      statement: statement(
        'SELECT SCHEMA_NAME AS name, DEFAULT_CHARACTER_SET_NAME AS charset, DEFAULT_COLLATION_NAME AS collation'
        + ' FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME',
      ),
      project: row => ({
        name: cellText(row.name),
        charset: cellText(row.charset),
        collation: cellText(row.collation),
      }),
    }
  },

  tables(database: string): DialectQuery<DialectTableRow> {
    return {
      statement: statement(
        'SELECT TABLE_NAME AS name, TABLE_TYPE AS type, ENGINE AS engine, TABLE_ROWS AS estimatedRows, TABLE_COMMENT AS comment'
        + ' FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME',
        [database],
      ),
      project: row => ({
        name: cellText(row.name),
        type: cellText(row.type),
        engine: cellOptionalText(row.engine),
        estimatedRows: cellInteger(row.estimatedRows),
        comment: cellText(row.comment),
      }),
    }
  },

  columns(database: string, table: string): DialectQuery<DialectColumnRow> {
    return {
      statement: statement(
        'SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable, COLUMN_DEFAULT AS defaultValue,'
        + ' COLUMN_KEY AS columnKey, EXTRA AS extra, COLUMN_COMMENT AS comment'
        + ' FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION',
        [database, table],
      ),
      project: row => ({
        name: cellText(row.name),
        type: cellText(row.type),
        nullable: cellFlag(row.nullable),
        default: cellOptionalText(row.defaultValue),
        key: cellText(row.columnKey),
        extra: cellText(row.extra),
        comment: cellText(row.comment),
      }),
    }
  },

  indexes(database: string, table: string): DialectQuery<DialectIndexRow> {
    return {
      statement: statement(
        'SELECT INDEX_NAME AS name, NON_UNIQUE AS nonUnique, INDEX_TYPE AS type, SEQ_IN_INDEX AS position, COLUMN_NAME AS columnName'
        + ' FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY INDEX_NAME, SEQ_IN_INDEX',
        [database, table],
      ),
      project: row => ({
        name: cellText(row.name),
        // MySQL spells uniqueness as the inverted number `NON_UNIQUE = 0`.
        unique: cellIsZero(row.nonUnique),
        type: cellText(row.type),
        columnName: cellText(row.columnName),
      }),
    }
  },

  createStatement(database: string, table: string): DialectQuery<string> {
    return {
      statement: statement(
        `SHOW CREATE TABLE ${quoteMysqlIdentifier(database)}.${quoteMysqlIdentifier(table)}`,
      ),
      project: createStatementOf,
    }
  },

  version(): DialectQuery<string> {
    return {
      statement: statement('SELECT VERSION() AS version'),
      project: row => cellText(row.version),
    }
  },

  sample(database: string, table: string, rows: number): DialectQuery<DbRow> {
    return {
      statement: statement(`SELECT * FROM ${quoteMysqlIdentifier(database)}.${quoteMysqlIdentifier(table)} LIMIT ${String(rows)}`),
      project: row => row,
    }
  },

  explain(sql: string): DialectQuery<string> {
    return {
      statement: statement(`EXPLAIN ${sql}`),
      project: row => JSON.stringify(row),
    }
  },
}

/**
 * Register the dialect.
 *
 * Registration is an effect, so unloading this package takes the dialect with
 * it and a connection that names `mysql` is refused by name again.
 * @param ctx - the plugin context, which serves the registry this package injects.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.databaseDialects.register(MYSQL_DIALECT), 'mysql dialect')
}
