/**
 * <DATABASE> dialect for dsh-ds-db — a starting point.
 *
 * Copy this directory, rename it, and replace every `TODO`. The shape below
 * already satisfies the contract: the audit passes, the tools run, and the
 * settings page offers the type. What is missing is your driver and your
 * metadata SQL.
 *
 * Keep the two facts that matter most:
 *  - `rules` is the read-only guard's only input. Get it wrong and the guard
 *    protects nothing.
 *  - every `project` maps *your* column names onto the shape the tools report.
 *    The tools never read a column name.
 *
 * @module dsh-dialect-template
 */

import type { Context } from '@deepseek-ai/cordis'
import { SHARED_FORBIDDEN, type ReadOnlyRules, type SqlLexical } from 'dsh-ds-db/src/sql-guard.ts'
import type {
  DatabaseConnection, DatabaseDialect, DialectCapability, DialectColumnRow,
  DialectDatabaseRow, DialectIndexRow, DialectQuery, DialectSession, DialectStatement, DialectTableRow,
} from 'dsh-ds-db/src/dialect.ts'
import { cellText, type DbRow } from 'dsh-ds-db/src/value.ts'

/** Stable Loader identity. TODO: rename. */
export const name = 'dialect-template'

/** The registry the core plugin provides is the one service this needs. */
export const inject = ['databaseDialects']

/** One statement plus the values your driver binds, in your placeholder style. */
function statement(sql: string, values: readonly (string | number)[] = []): DialectStatement {
  return { sql, values }
}

/**
 * Your database's lexemes. TODO: replace with the real quote characters and
 * comment markers. A dialect that spells them differently than another cannot
 * let the difference leak: this object is where it lives.
 */
const LEXICAL: SqlLexical = {
  quotes: [
    { quote: '\'', backslashEscapes: false },
    { quote: '"', backslashEscapes: false },
  ],
  lineComments: [{ marker: '--', requiresWhitespace: false }],
}

/** What your statements are judged by. TODO: widen `lead` if your server reads more. */
const RULES: ReadOnlyRules = {
  lexical: LEXICAL,
  lead: /^(?:select|with)\b/i,
  families: ['SELECT', 'WITH'],
  forbidden: [...SHARED_FORBIDDEN],
}

/** One session. TODO: hold your driver's connection or pool here. */
class Session implements DialectSession {
  /** @param connection - the resolved connection this session was opened for. */
  constructor(private readonly connection: DatabaseConnection) {}

  /**
   * Run one statement.
   * @param query - the statement and its bound values.
   * @returns the raw driver rows plus the result's column names.
   */
  async run(query: DialectStatement): Promise<{ rows: unknown[], columns: string[] }> {
    // TODO: run `query` through your driver and return its rows and fields.
    return { rows: [], columns: [] }
  }

  /** Release the session's resources. */
  async close(): Promise<void> {
    // TODO: close your connection or pool.
    void this.connection
  }
}

/** <DATABASE>, as a registered dialect. */
export const TEMPLATE_DIALECT: DatabaseDialect = {
  name: 'template',   // TODO: the registry key, such as `clickhouse`
  label: 'Template',  // TODO: what the model and the settings page call it
  rules: RULES,

  // TODO: declare only what your server really provides. A missing ability is a
  // contract fact: the tools degrade instead of running a statement you lack.
  capabilities: new Set<DialectCapability>(['databases', 'tables', 'columns', 'version']),

  // TODO: fields only your server needs; the page renders them and the values
  // arrive in `connection.extra`.
  configFields: [],

  rowBoundHint: 'LIMIT',      // TODO: how a model should bound rows, such as FETCH FIRST
  systemDatabases: [],        // TODO: schemas your server owns, hidden by db_databases

  async open(connection: DatabaseConnection): Promise<DialectSession> {
    // TODO: connect through your driver, honouring connection.connectTimeoutMs.
    return new Session(connection)
  },

  applyRowLimit(sql: string, maxRows: number): string {
    // TODO: bound a statement that carries no bound of its own, so a forgotten
    // LIMIT cannot stream a whole table into the model's context.
    return `${sql} LIMIT ${String(maxRows + 1)}`
  },

  quoteIdentifier(identifier: string): string {
    // TODO: quote so a name carrying your quote character cannot leave its statement.
    return `"${identifier.replaceAll('"', '""')}"`
  },

  databases(): DialectQuery<DialectDatabaseRow> {
    return {
      // TODO: the real query.
      statement: statement('SELECT name, charset, collation FROM databases'),
      project: row => ({
        name: cellText(row.name),
        charset: cellText(row.charset),
        collation: cellText(row.collation),
      }),
    }
  },

  tables(database: string): DialectQuery<DialectTableRow> {
    return {
      statement: statement('SELECT name, type, engine, estimated_rows, comment FROM tables WHERE database = ?', [database]),
      project: row => ({
        name: cellText(row.name),
        type: cellText(row.type),
        engine: row.engine === null || row.engine === undefined ? null : cellText(row.engine),
        estimatedRows: row.estimated_rows === null || row.estimated_rows === undefined
          ? null
          : Math.trunc(Number(row.estimated_rows)),
        comment: cellText(row.comment),
      }),
    }
  },

  columns(database: string, table: string): DialectQuery<DialectColumnRow> {
    return {
      statement: statement(
        'SELECT name, type, nullable, default_value, column_key, extra, comment FROM columns WHERE database = ? AND table = ?',
        [database, table],
      ),
      project: row => ({
        name: cellText(row.name),
        type: cellText(row.type),
        nullable: cellText(row.nullable) === 'YES',
        default: row.default_value === null || row.default_value === undefined ? null : cellText(row.default_value),
        key: cellText(row.column_key),
        extra: cellText(row.extra),
        comment: cellText(row.comment),
      }),
    }
  },

  indexes(database: string, table: string): DialectQuery<DialectIndexRow> {
    return {
      statement: statement('SELECT name, definition FROM indexes WHERE database = ? AND table = ?', [database, table]),
      project: (row) => {
        const definition = cellText(row.definition)
        const columns = definition.slice(definition.indexOf('(') + 1, definition.lastIndexOf(')'))
          .split(',')
          .map(part => part.trim())
          .filter(part => part.length > 0)
        return {
          name: cellText(row.name),
          unique: definition.toUpperCase().includes('UNIQUE'),
          type: '',
          columnName: columns[0] ?? '',
        }
      },
    }
  },

  // Not declared in `capabilities`, so `db_describe` omits it. TODO: implement
  // and declare it if your server can render a create statement.
  createStatement(): DialectQuery<string> {
    return { statement: statement('SELECT definition FROM ddl'), project: () => '' }
  },

  version(): DialectQuery<string> {
    return {
      statement: statement('SELECT version'),
      project: row => cellText(row.version),
    }
  },
}

/**
 * Register the dialect.
 * @param ctx - the plugin context, which serves the registry this package injects.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.databaseDialects.register(TEMPLATE_DIALECT), 'template dialect')
}
