/**
 * PostgreSQL dialect for `dsh-ds-db`: the reference implementation of an
 * out-of-tree database type.
 *
 * This package touches nothing in the plugin. It injects the registry the
 * plugin provides and registers one dialect into it; the four existing tools
 * then run against PostgreSQL unchanged, and the settings page offers
 * PostgreSQL as a type because the Host's catalog route lists what is
 * registered.
 *
 * @module dsh-dialect-postgres
 */

import type { Context } from '@deepseek-ai/cordis'
import type {
  DatabaseConnection, DatabaseDialect, DialectCapability, DialectColumnRow,
  DialectDatabaseRow, DialectIndexRow, DialectQuery, DialectSession, DialectStatement, DialectTableRow,
} from 'dsh-ds-db/src/dialect.ts'
import { SHARED_FORBIDDEN, scanStatement, type ReadOnlyRules, type SqlLexical } from 'dsh-ds-db/src/sql-guard.ts'
import { toJsonRow, type DbRow, type DbScalar } from 'dsh-ds-db/src/value.ts'
import pg from 'pg'

/** Stable Loader identity. */
export const name = 'dialect-postgres'

/** The dialect registry the plugin provides is the one service this needs. */
export const inject = ['databaseDialects']

/** PostgreSQL quotes identifiers with double quotes, doubled inside. */
function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`
}

/** One statement and the values its driver binds, in `$n` placeholder style. */
function statement(sql: string, values: readonly DbScalar[] = []): DialectStatement {
  return { sql, values }
}

/** Read one cell as text; empty when the server answered nothing. */
function cellText(value: unknown): string {
  if (value === null || value === undefined) return ''
  return typeof value === 'string' ? value : String(value)
}

/** Read one cell as an integer, or null when the server cannot estimate. */
function cellInteger(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null
}

/**
 * PostgreSQL's lexemes: single-quoted strings, double-quoted identifiers, and
 * dash-dash plus block comments. A hash is an operator here rather than a
 * comment, which is exactly the kind of difference the dialect owns.
 */
const PG_LEXICAL: SqlLexical = {
  quotes: [
    { quote: "'", backslashEscapes: false },
    { quote: '"', backslashEscapes: false },
  ],
  lineComments: [{ marker: '--', requiresWhitespace: false }],
}

/** What PostgreSQL statements are judged by. */
const PG_RULES: ReadOnlyRules = {
  lexical: PG_LEXICAL,
  lead: /^(?:select|with|table|values|show|explain)\b/i,
  families: ['SELECT', 'WITH', 'TABLE', 'VALUES', 'SHOW', 'EXPLAIN'],
  forbidden: [
    { pattern: /into\s+(?:outfile|dumpfile)\b/i, reason: 'writes a server-side file' },
    { pattern: /\bpg_sleep\b/i, reason: 'occupies a connection doing nothing' },
    ...SHARED_FORBIDDEN,
  ],
}

/** One PostgreSQL session: one pooled client, statements run on it. */
class PostgresSession implements DialectSession {
  constructor(
    private readonly client: pg.PoolClient,
    private readonly queryTimeoutMs: number,
  ) {}

  async run(statement: DialectStatement): Promise<{ rows: unknown[], columns: string[] }> {
    const result = await this.client.query({
      text: statement.sql,
      values: [...statement.values] as unknown[],
      // The driver's own statement timeout is the second layer of the read-only
      // posture: a runaway read cannot hold the connection past this bound.
      ...this.queryTimeoutMs > 0 ? { query_timeout: this.queryTimeoutMs } : {},
    })
    return {
      rows: result.rows as unknown[],
      columns: (result.fields ?? []).map(field => field.name),
    }
  }

  async close(): Promise<void> {
    this.client.release()
  }
}

/** The connection facts this dialect reads beyond the shared ones. */
function sslMode(connection: DatabaseConnection): string {
  const value = connection.extra.sslMode
  return typeof value === 'string' && value.length > 0 ? value : 'disable'
}

/**
 * The PostgreSQL dialect.
 *
 * It declares every ability but `createStatement`: PostgreSQL has no built-in
 * equivalent of `SHOW CREATE TABLE`, so `db_describe` omits that field instead
 * of running a statement that does not exist.
 */
export const POSTGRES_DIALECT: DatabaseDialect = {
  name: 'postgres',
  label: 'PostgreSQL',
  rules: PG_RULES,
  capabilities: new Set<DialectCapability>([
    'databases', 'tables', 'columns', 'indexes', 'estimatedRows', 'version',
  ]),
  configFields: [
    { key: 'sslMode', kind: 'text', default: 'disable', required: false, label: 'SSL mode' },
  ],
  rowBoundHint: 'LIMIT',
  systemDatabases: ['information_schema', 'pg_catalog', 'pg_toast'],

  async open(connection: DatabaseConnection): Promise<DialectSession> {
    const pool = new pg.Pool({
      host: connection.host,
      port: connection.port,
      user: connection.user,
      password: connection.password,
      ...connection.database === undefined ? {} : { database: connection.database },
      connectionTimeoutMillis: connection.connectTimeoutMs,
      ssl: sslMode(connection) === 'disable' ? undefined : { rejectUnauthorized: false },
      max: 1,
    })
    const client = await pool.connect()
    // The pool is kept alive by the client it handed out; releasing the client
    // on close is what ends it, and this session owns both.
    return new PostgresSession(client, connection.queryTimeoutMs)
  },

  applyRowLimit(sql: string, maxRows: number): string {
    return `${scanStatement(sql, PG_LEXICAL).statement.trim()} LIMIT ${String(maxRows + 1)}`
  },

  quoteIdentifier,

  databases(): DialectQuery<DialectDatabaseRow> {
    return {
      statement: statement(
        'SELECT datname AS name, '
        + "COALESCE(pg_encoding_to_char(encoding), '') AS charset, "
        + "COALESCE(datcollate, '') AS collation "
        + 'FROM pg_database WHERE datallowconn ORDER BY datname',
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
        'SELECT table_name AS name, table_type AS type, '
        + 'NULL::text AS engine, NULL::bigint AS estimated_rows, '
        + "COALESCE(obj_description((quote_ident($1) || '.' || quote_ident(table_name))::regclass), '') AS comment "
        + 'FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name',
        [database],
      ),
      project: row => ({
        name: cellText(row.name),
        type: cellText(row.type) === 'VIEW' ? 'VIEW' : 'BASE TABLE',
        engine: null,
        estimatedRows: cellInteger(row.estimated_rows),
        comment: cellText(row.comment),
      }),
    }
  },

  columns(database: string, table: string): DialectQuery<DialectColumnRow> {
    return {
      statement: statement(
        'SELECT column_name AS name, data_type AS type, is_nullable AS nullable, '
        + 'column_default AS default_value, '
        + "COALESCE(constraint_type, '') AS key, '' AS extra, "
        + "COALESCE(col_description((quote_ident($1) || '.' || quote_ident($2))::regclass, ordinal_position), '') AS comment "
        + 'FROM information_schema.columns '
        + 'LEFT JOIN ('
        + '  SELECT kcu.column_name, tc.constraint_type FROM information_schema.table_constraints tc '
        + '  JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name '
        + "  WHERE tc.table_schema = $1 AND tc.table_name = $2 AND tc.constraint_type = 'PRIMARY KEY'"
        + ') pk ON pk.column_name = columns.column_name '
        + 'WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position',
        [database, table],
      ),
      project: row => ({
        name: cellText(row.name),
        type: cellText(row.type),
        nullable: cellText(row.nullable) === 'YES',
        default: cellText(row.default_value).length === 0 ? null : cellText(row.default_value),
        key: cellText(row.key) === 'PRIMARY KEY' ? 'PRI' : '',
        extra: '',
        comment: cellText(row.comment),
      }),
    }
  },

  indexes(database: string, table: string): DialectQuery<DialectIndexRow> {
    return {
      statement: statement(
        'SELECT indexname AS name, indexdef AS definition, '
        + "COALESCE(position(' UNIQUE ' in ' ' || indexdef) > 0, false) AS is_unique "
        + 'FROM pg_indexes WHERE schemaname = $1 AND tablename = $2 ORDER BY indexname',
        [database, table],
      ),
      project: (row) => {
        // PostgreSQL renders the whole index in one `indexdef`, so the columns
        // are read out of it rather than from a per-column catalog.
        const definition = cellText(row.definition)
        const columns = definition.slice(definition.indexOf('(') + 1, definition.lastIndexOf(')'))
          .split(',')
          .map(part => part.trim().replace(/\s+(ASC|DESC)$/i, ''))
          .filter(part => part.length > 0)
        return {
          name: cellText(row.name),
          unique: definition.toUpperCase().includes('CREATE UNIQUE INDEX'),
          type: 'BTREE',
          columnName: columns[0] ?? '',
        }
      },
    }
  },

  // `createStatement` is deliberately not declared: no built-in PostgreSQL
  // function renders a create statement without an extension, and a dialect
  // says so instead of guessing.
  createStatement(): DialectQuery<string> {
    return { statement: statement("SELECT '' AS ddl"), project: () => '' }
  },

  version(): DialectQuery<string> {
    return {
      statement: statement('SELECT version() AS version'),
      project: row => cellText(row.version),
    }
  },

  sample(database: string, table: string, rows: number): DialectQuery<DbRow> {
    return {
      statement: statement(`SELECT * FROM ${quoteIdentifier(database)}.${quoteIdentifier(table)} LIMIT ${String(rows)}`),
      project: row => toJsonRow(row),
    }
  },

  explain(sql: string): DialectQuery<string> {
    return {
      statement: statement(`EXPLAIN ${sql}`),
      project: row => cellText(row['QUERY PLAN'] ?? Object.values(row)[0]),
    }
  },
}

/**
 * Register the dialect.
 *
 * Registration is an effect, so unloading this package takes the dialect with
 * it and a call that names it is refused by name again.
 * @param ctx - the plugin context, which serves the registry this package injects.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.databaseDialects.register(POSTGRES_DIALECT), 'postgres dialect')
}
