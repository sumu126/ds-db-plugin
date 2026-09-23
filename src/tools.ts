/**
 * The four model-facing tools: list databases, list a database's tables,
 * describe one table, and run one read-only statement.
 *
 * The tools are dialect-neutral: they ask the dialect for a query and for the
 * syntax they must judge and bound with, and they never write SQL, quote an
 * identifier, or read a result column name themselves. Every call resolves the
 * connection and the dialect at that moment, so a configuration edit reaches
 * the next call without a plugin reload.
 *
 * The names are the neutral `db_*` set, because the tools serve whichever
 * dialect the deployment selected; each one's description names the server it
 * will actually reach.
 *
 * @module dsh-ds-db/src/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ConnectionProfile, DatabaseSettings } from './contract.ts'
import { connectionSummaries, resolveProfile } from './connections.ts'
import type { DatabaseAccess } from './connection.ts'
import type { DatabaseDialect, DialectCapability, DialectFacts, DialectIndexRow } from './dialect.ts'
import { assertReadOnlyStatement, familiesPhrase } from './sql-guard.ts'

/** Identity and limits one tool call runs against. */
export interface DatabaseToolsFace {
  /** The session runner, re-resolving connection and dialect per call. */
  access: DatabaseAccess
  /**
   * The dialect one saved connection is addressed through.
   * @param profile - the connection the call addresses.
   */
  dialectFor: (profile: ConnectionProfile) => DatabaseDialect
  /**
   * The dialect facts the model-facing descriptions are written from, fixed
   * when the tools are registered. It is separate from {@link dialectFor}
   * because a dialect package loads after this plugin: the wording is settled
   * once, while every call still resolves the dialect that is really in force.
   */
  described: DialectFacts
  /** The current settings section, holding every saved connection. */
  settings: () => DatabaseSettings
}

/** The parameter one call names its connection with, when it names one. */
const CONNECTION_PARAMETER = {
  type: 'string' as const,
  description: 'Saved connection to run against, by its name. Defaults to the connection in use; call db_connections to see what is saved.',
}

/**
 * Refuse one call whose capability the dialect in force does not declare.
 *
 * A missing capability is a contract fact, not a failure to paper over: the
 * tool says the server cannot answer, so a model asks for something else rather
 * than waiting on a statement that does not exist.
 * @param dialect - the dialect in force.
 * @param capability - the ability this call needs.
 * @throws {Error} when the dialect does not declare it.
 */
function requireCapability(dialect: DatabaseDialect, capability: DialectCapability): void {
  if (!dialect.capabilities.has(capability)) {
    throw new Error(`this ${dialect.label} connection does not support ${capability}, so this call cannot be answered`)
  }
}

/** A string argument the model may have left blank. */
function optionalArgument(value: string | undefined): string | undefined {
  const trimmed = value?.trim() ?? ''
  return trimmed.length === 0 ? undefined : trimmed
}

/**
 * The database a call runs against: what it named, else the configured default.
 * @param settings - the resolved settings section.
 * @param requested - the call's own database argument, when it named one.
 * @param dialect - the dialect in force, which names its own settings page.
 * @returns the database to address.
 * @throws {Error} when neither the call nor the settings name a database.
 */
function resolveDatabase(settings: ConnectionProfile, requested: string | undefined, dialect: DatabaseDialect): string {
  const database = optionalArgument(requested) ?? optionalArgument(settings.database)
  if (database === undefined) {
    throw new Error(`no database selected: pass a database argument or set the default database of the connection in use on the database settings page`)
  }
  return database
}

/**
 * Register the read-only tools on the plugin's fiber.
 * @param ctx - the plugin context whose `tools` registry receives them.
 * @param face - the session runner, the dialect reader, and the settings reader every call uses.
 */
export function applyDatabaseTools(ctx: Context, face: DatabaseToolsFace): void {
  const { access, dialectFor, described, settings } = face

  /**
   * The connection one call addresses and the dialect it runs through, both in
   * force at that moment: a call may name any saved connection, and an unnamed
   * one takes the connection the page marks as in use.
   * @param requested - the connection the call named, if any.
   * @returns the profile and its dialect.
   */
  const addressed = (requested: string | undefined): { profile: ConnectionProfile, view: DatabaseDialect } => {
    const profile = resolveProfile(settings(), requested)
    return { profile, view: dialectFor(profile) }
  }

  ctx.tools.register(defineTool({
    name: 'db_databases',
    description: `List the ${described.label} databases this connection can see, with each one's default character set and collation.`,
    parameters: {
      connection: CONNECTION_PARAMETER,
      include_system: {
        type: 'boolean',
        description: `Include the server's own schemas (${described.systemDatabases.join(', ')}). Defaults to false.`,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          databases: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                charset: { type: 'string', required: true },
                collation: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.databases.length === 0
          ? 'No databases are visible to this connection.'
          : value.databases.map(row => `${row.name} (${row.charset}/${row.collation})`).join('\n'),
      }],
    },
    async execute(args) {
      const { profile: target, view } = addressed(args.connection)
      requireCapability(view, 'databases')
      const databases = await access.run(target, view.databases())
      const includeSystem = args.include_system === true
      const rows = view.capabilities.has('charset')
        ? databases
        : databases.map(row => ({ ...row, charset: '', collation: '' }))
      return {
        databases: rows.filter(row => includeSystem || !view.systemDatabases.includes(row.name)),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'db_tables',
    description: `List the tables and views of one ${described.label} database, with engine, row-count estimate, and table comment.`,
    parameters: {
      connection: CONNECTION_PARAMETER,
      database: { type: 'string', description: 'Database to list. Defaults to the default database of the connection in use.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          database: { type: 'string', required: true },
          tables: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                type: { type: 'string', required: true, description: 'BASE TABLE for a stored table, VIEW for a view.' },
                engine: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
                estimatedRows: { oneOf: [{ type: 'integer' }, { type: 'null' }], required: true },
                comment: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.tables.length === 0
          ? `Database ${value.database} has no tables or views visible to this connection.`
          : [`Database ${value.database}:`, ...value.tables.map(row =>
            `- ${row.name} [${row.type}${row.engine === null ? '' : `, ${row.engine}`}${row.estimatedRows === null ? '' : `, ~${String(row.estimatedRows)} rows`}]${row.comment.length === 0 ? '' : ` — ${row.comment}`}`,
          )].join('\n'),
      }],
    },
    async execute(args) {
      const { profile: target, view } = addressed(args.connection)
      requireCapability(view, 'tables')
      const database = resolveDatabase(target, args.database, view)
      const tables = await access.run(target, view.tables(database))
      // A server that cannot estimate row counts reports none rather than
      // letting its dialect invent a number the model would trust.
      const rows = view.capabilities.has('estimatedRows')
        ? tables
        : tables.map(row => ({ ...row, estimatedRows: null }))
      return { database, tables: rows }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'db_describe',
    description: `Describe one ${described.label} table: its columns, its indexes, and the statement that creates it.`,
    parameters: {
      connection: CONNECTION_PARAMETER,
      table: { type: 'string', required: true, description: 'Table or view to describe.' },
      database: { type: 'string', description: 'Database holding the table. Defaults to the default database of the connection in use.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          database: { type: 'string', required: true },
          table: { type: 'string', required: true },
          columns: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                type: { type: 'string', required: true, description: 'Full column type, such as varchar(64) or int unsigned.' },
                nullable: { type: 'boolean', required: true },
                default: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
                key: { type: 'string', required: true, description: 'PRI, UNI, MUL, or empty.' },
                extra: { type: 'string', required: true, description: 'Server-side extras such as auto_increment or DEFAULT_GENERATED.' },
                comment: { type: 'string', required: true },
              },
            },
          },
          indexes: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                unique: { type: 'boolean', required: true },
                type: { type: 'string', required: true, description: 'Index algorithm, such as BTREE, FULLTEXT, or HASH.' },
                columns: { type: 'array', required: true, items: { type: 'string' } },
              },
            },
          },
          // Omitted rather than empty when the dialect declares no
          // `createStatement`: the field's absence is what tells a model the
          // server cannot produce one.
          createStatement: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          `${value.database}.${value.table}`,
          'Columns:',
          ...value.columns.map(column =>
            `- ${column.name} ${column.type}${column.nullable ? '' : ' NOT NULL'}${column.default === null ? '' : ` DEFAULT ${column.default}`}${column.key.length === 0 ? '' : ` [${column.key}]`}${column.extra.length === 0 ? '' : ` ${column.extra}`}`),
          'Indexes:',
          ...value.indexes.length === 0
            ? ['- none']
            : value.indexes.map(index => `- ${index.name} (${index.unique ? 'unique ' : ''}${index.type}) on ${index.columns.join(', ')}`),
          // The create statement is simply absent from the report when the
          // server cannot produce one.
          ...value.createStatement === undefined ? [] : [value.createStatement],
        ].join('\n'),
      }],
    },
    async execute(args) {
      const { profile: target, view } = addressed(args.connection)
      requireCapability(view, 'columns')
      const database = resolveDatabase(target, args.database, view)
      const table = args.table.trim()
      if (table.length === 0) throw new Error('table must be a non-empty name')
      const columns = await access.run(target, view.columns(database, table))
      if (columns.length === 0) {
        throw new Error(`table ${database}.${table} does not exist or is not visible to this connection`)
      }
      const indexes = view.capabilities.has('indexes')
        ? await access.run(target, view.indexes(database, table))
        : []
      const create = view.capabilities.has('createStatement')
        ? await access.run(target, view.createStatement(database, table))
        : []
      return {
        database,
        table,
        columns,
        indexes: groupIndexes(indexes),
        // A server with no way to render a create statement omits the field,
        // which is the signal a model reads; it is never filled with a guess.
        ...create[0] === undefined ? {} : { createStatement: create[0] },
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'db_query',
    description: `Run one read-only ${described.label} statement and return its rows as JSON. `
      // `and`, unlike the refusal's `or`: the description enumerates what the
      // tool accepts, and that is the wording this text has always used.
      // An unregistered dialect declares no families; the wording then names the
      // property rather than printing an empty list.
      + `Only ${described.rules.families.length === 0 ? 'read-only statements' : familiesPhrase(described.rules.families, 'and')} are accepted; a single statement per call. `
      + `Results are cut at the deployment's row cap, so ask for the rows you need with WHERE, ORDER BY, and ${described.rowBoundHint}.`,
    parameters: {
      connection: CONNECTION_PARAMETER,
      sql: { type: 'string', required: true, description: 'One read-only statement, without a trailing semicolon requirement.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          columns: { type: 'array', required: true, items: { type: 'string' } },
          rows: { type: 'array', required: true, items: { type: 'json' } },
          rowCount: { type: 'integer', required: true },
          truncated: { type: 'boolean', required: true },
          elapsedMs: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => {
        const rows = value.rows.length === 0 ? 'no rows' : JSON.stringify(value.rows)
        return [{
          type: 'text',
          text: value.truncated
            ? `${rows}\n(${String(value.rowCount)} rows returned, cut at this deployment's row cap in ${String(value.elapsedMs)} ms)`
            : `${rows}\n(${String(value.rowCount)} rows in ${String(value.elapsedMs)} ms)`,
        }]
      },
    },
    async execute(args) {
      const { profile: target, view } = addressed(args.connection)
      const statement = assertReadOnlyStatement(args.sql, view.rules)
      // The row cap belongs to the connection that answers the call.
      const outcome = await access.query(target, view.applyRowLimit(statement, target.maxRows))
      return {
        columns: outcome.columns,
        rows: outcome.rows,
        rowCount: outcome.rows.length,
        truncated: outcome.truncated,
        elapsedMs: outcome.elapsedMs,
      }
    },
  }))

  // The two optional tools are registered only when the dialect the descriptions
  // were written from can answer them. A dialect that arrives later and cannot
  // simply has no such tool, which is what the model sees in its tool list.
  if (described.capabilities.has('sample')) {
    ctx.tools.register(defineTool({
      name: 'db_sample',
      description: `Read a few rows from one ${described.label} table, so the shape of its data is visible before a query is written.`,
      parameters: {
        connection: CONNECTION_PARAMETER,
        table: { type: 'string', required: true, description: 'Table or view to read.' },
        database: { type: 'string', description: 'Database holding the table. Defaults to the default database of the connection in use.' },
        rows: { type: 'integer', description: 'How many rows to read. Defaults to 5, and never exceeds the deployment row cap.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            database: { type: 'string', required: true },
            table: { type: 'string', required: true },
            columns: { type: 'array', required: true, items: { type: 'string' } },
            rows: { type: 'array', required: true, items: { type: 'json' } },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: `${value.database}.${value.table}: ${JSON.stringify(value.rows)}`,
        }],
      },
      async execute(args) {
        const { profile: target, view } = addressed(args.connection)
        requireCapability(view, 'sample')
        const sample = view.sample
        if (sample === undefined) throw new Error(`this ${view.label} connection does not support sample`)
        const database = resolveDatabase(target, args.database, view)
        const table = args.table.trim()
        if (table.length === 0) throw new Error('table must be a non-empty name')
        const requested = typeof args.rows === 'number' ? Math.floor(args.rows) : 5
        const rows = Math.min(Math.max(requested, 1), target.maxRows)
        const outcome = await access.query(target, sample(database, table, rows).statement.sql, [])
        return { database, table, columns: outcome.columns, rows: outcome.rows }
      },
    }))
  }

  if (described.capabilities.has('explain')) {
    ctx.tools.register(defineTool({
      name: 'db_explain',
      description: `Explain how ${described.label} would execute one read-only statement, without running it.`,
      parameters: {
        connection: CONNECTION_PARAMETER,
        sql: { type: 'string', required: true, description: 'One read-only statement to explain.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            plan: { type: 'array', required: true, items: { type: 'string' } },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.plan.join('\n') }],
      },
      async execute(args) {
        const { profile: target, view } = addressed(args.connection)
        requireCapability(view, 'explain')
        const explain = view.explain
        if (explain === undefined) throw new Error(`this ${view.label} connection does not support explain`)
        const statement = assertReadOnlyStatement(args.sql, view.rules)
        const plan = await access.run(target, explain(statement))
        return { plan }
      },
    }))
  }

  // Which connections exist is the one thing a model cannot discover from the
  // other tools, and the one it needs before it can address any but the default.
  ctx.tools.register(defineTool({
    name: 'db_connections',
    description: 'List the saved database connections by name, with the type and server each one reaches and which one a call runs against by default.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          active: { type: 'string', required: true, description: 'Name of the connection an unnamed call runs against; empty when none is saved.' },
          connections: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true, description: 'Id to address this connection by, which is what an ambiguous name points at.' },
                name: { type: 'string', required: true },
                dialect: { type: 'string', required: true, description: 'Registered database type; empty means the deployment default.' },
                host: { type: 'string', required: true },
                port: { type: 'integer', required: true, description: '0 when the type supplies its own default.' },
                database: { type: 'string', required: true, description: 'Default database, empty when every call names one.' },
                active: { type: 'boolean', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.connections.length === 0
          ? 'No database connection is saved.'
          : [
              `Default connection: ${value.active.length === 0 ? 'none' : value.active}`,
              ...value.connections.map(connection =>
                `- ${connection.name} [${connection.dialect.length === 0 ? 'default type' : connection.dialect}] `
                + `${connection.host}:${String(connection.port)}`
                + `${connection.database.length === 0 ? '' : `/${connection.database}`}`
                + `${connection.active ? ' (default)' : ''}`),
            ].join('\n'),
      }],
    },
    async execute() {
      const section = settings()
      // Listing what is saved must not fail when nothing is: the empty answer is
      // exactly the one a model needs to ask the user for a connection.
      const active = section.connections.find(profile => profile.id === section.activeId)
        ?? section.connections[0]
      return {
        active: active?.name ?? '',
        connections: connectionSummaries(section),
      }
    },
  }))
}

/** One index as `db_describe` reports it. */
interface DescribedIndex {
  /** Index name. */
  name: string
  /** Whether the index rejects duplicate values. */
  unique: boolean
  /** Index algorithm, such as BTREE or FULLTEXT. */
  type: string
  /** Indexed columns in key order. */
  columns: string[]
}

/** Fold one flat index listing into one entry per index, in position order. */
function groupIndexes(rows: readonly DialectIndexRow[]): DescribedIndex[] {
  const grouped = new Map<string, DescribedIndex>()
  for (const row of rows) {
    const entry = grouped.get(row.name) ?? { name: row.name, unique: row.unique, type: row.type, columns: [] }
    entry.columns.push(row.columnName)
    grouped.set(row.name, entry)
  }
  return [...grouped.values()]
}