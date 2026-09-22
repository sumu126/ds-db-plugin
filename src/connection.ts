/**
 * Dialect-neutral read-only database access: one lazily opened session per
 * connection identity, every result projected to lossless JSON before it
 * reaches a tool result.
 *
 * The session is replaced rather than mutated when the resolved connection or
 * dialect moves, so an edit on the settings page reaches the next tool call
 * without a plugin reload; {@link DatabaseAccess.dispose} is the plugin's
 * unload path. Which driver runs underneath is the dialect's affair.
 *
 * @module dsh-ds-db/src/connection
 */

import type { DatabaseConnection, DatabaseDialect, DialectQuery, DialectSession, DialectStatement } from './dialect.ts'
import { toJsonRow, type DbRow, type DbScalar } from './value.ts'

/** One statement's outcome, already bounded and JSON-safe. */
export interface QueryOutcome {
  /** Column names in result order. */
  columns: string[]
  /** Row objects keyed by column name. */
  rows: DbRow[]
  /** Whether the result was cut at the deployment's row cap. */
  truncated: boolean
  /** Statement wall time in milliseconds. */
  elapsedMs: number
}

/** Live connection facts the settings page shows after a successful probe. */
export interface ConnectionProbe {
  /** Server version string as the server reports it. */
  version: string
  /** Round trip time of the probe statement in milliseconds. */
  latencyMs: number
}

/** What one operation resolves at the moment it runs. */
export interface DatabaseAccessFace {
  /** The connection to address, re-resolved per call. */
  connection: () => Promise<DatabaseConnection>
  /** The dialect to run through, re-resolved per call. */
  dialect: () => DatabaseDialect
}

/** One open session and the identity it was opened for. */
interface LiveSession {
  /** Identity this session was opened for; a different one retires it. */
  key: string
  /** The dialect that opened it. */
  dialect: DatabaseDialect
  /** The connection it was opened against. */
  connection: DatabaseConnection
  /** The dialect's session. */
  session: DialectSession
}

/** A connection name safe to show a model and a log: never the password. */
function connectionLabel(connection: DatabaseConnection): string {
  const database = connection.database === undefined ? '' : `/${connection.database}`
  return `${connection.user}@${connection.host}:${String(connection.port)}${database}`
}

/** The session identity: any change here retires the session it was opened for. */
function sessionKey(connection: DatabaseConnection, dialect: DatabaseDialect): string {
  return JSON.stringify([
    dialect.name, connection.host, connection.port, connection.user, connection.password, connection.database ?? '',
  ])
}

/** One error's message, for a refusal that names the connection but never the secret. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * One plugin instance's read-only database access.
 *
 * Every call re-resolves the connection and the dialect, so a settings edit, a
 * new stored password, or a reconfigured dialect is honoured by the next call;
 * a session is opened on the first call and replaced only when its identity
 * changes.
 */
export class DatabaseAccess {
  private live: LiveSession | undefined

  /** @param face - the connection and dialect readers every call resolves through. */
  constructor(private readonly face: DatabaseAccessFace) {}

  /**
   * Run one dialect query and project its rows onto the shape it promises.
   * @param query - the query to run.
   * @returns one entry per row the server answered.
   * @throws {Error} when the server refuses the statement or the session cannot reach it.
   */
  async run<R>(query: DialectQuery<R>): Promise<R[]> {
    const live = await this.session()
    const { rows } = await this.statement(live, query.statement)
    return rows.map(row => query.project(row))
  }

  /**
   * Run one already-guarded statement and project its rows to lossless JSON.
   * @param sql - the statement to execute, in the dialect's own placeholder style.
   * @param values - values the dialect's driver binds.
   * @returns the bounded, JSON-safe outcome.
   * @throws {Error} when the server refuses the statement or the session cannot reach it.
   */
  async query(sql: string, values: readonly DbScalar[] = []): Promise<QueryOutcome> {
    const live = await this.session()
    const { rows, columns, elapsedMs } = await this.statement(live, { sql, values })
    return {
      columns,
      rows: rows.slice(0, live.connection.maxRows),
      truncated: rows.length > live.connection.maxRows,
      elapsedMs,
    }
  }

  /**
   * Prove the saved connection works, for the settings page.
   * @returns the server version and the probe's round trip time.
   * @throws {Error} when the connection fails or the server answers no version.
   */
  async probe(): Promise<ConnectionProbe> {
    const live = await this.session()
    const started = Date.now()
    const versions = await this.run(live.dialect.version())
    const version = versions[0]
    if (version === undefined || version.length === 0) {
      throw new Error(`the server did not answer a version for ${connectionLabel(live.connection)}`)
    }
    return { version, latencyMs: Date.now() - started }
  }

  /** Close the live session; the plugin calls it on unload. */
  async dispose(): Promise<void> {
    const live = this.live
    this.live = undefined
    if (live === undefined) return
    try {
      await live.session.close()
    } catch (error: unknown) {
      // A session that cannot drain is already unusable, and nothing may block unload.
      process.emitWarning(`ds-db: closing the ${live.dialect.label} session failed: ${messageOf(error)}`)
    }
  }

  /** The live session for the current identity, opening or retiring as needed. */
  private async session(): Promise<LiveSession> {
    const dialect = this.face.dialect()
    const connection = await this.face.connection()
    const key = sessionKey(connection, dialect)
    const live = this.live
    if (live !== undefined && live.key === key) return live
    const opened: LiveSession = { key, dialect, connection, session: await dialect.open(connection) }
    this.live = opened
    if (live !== undefined) {
      await live.session.close().catch((error: unknown) => {
        process.emitWarning(`ds-db: retiring the previous ${live.dialect.label} session failed: ${messageOf(error)}`)
      })
    }
    return opened
  }

  /** Run one statement on a live session, wrapping any refusal with the connection it names. */
  private async statement(
    live: LiveSession,
    statement: DialectStatement,
  ): Promise<{ rows: DbRow[], columns: string[], elapsedMs: number }> {
    const started = Date.now()
    let result: { rows: unknown[], columns: string[] }
    try {
      result = await live.session.run(statement)
    } catch (error: unknown) {
      throw new Error(
        `${live.dialect.label} statement on ${connectionLabel(live.connection)} failed: ${messageOf(error)}`,
        { cause: error },
      )
    }
    // Measured before projection, so the reported time is the server's work.
    const elapsedMs = Date.now() - started
    return { rows: result.rows.map(row => toJsonRow(row)), columns: result.columns, elapsedMs }
  }
}