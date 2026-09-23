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

import { createHash } from 'node:crypto'
import type { ConnectionProfile } from './contract.ts'
import type { DatabaseConnection, DatabaseDialect, DialectQuery, DialectSession, DialectStatement } from './dialect.ts'
import { toJsonRow, type DbRow, type DbScalar } from './value.ts'

/**
 * Sessions one plugin instance keeps open at once, unless the deployment
 * configures another limit.
 *
 * Calls may address different connections in the same session, so a second
 * connection must not close the first one's session; beyond this many, the
 * least recently used is retired, so a page full of connections cannot hold an
 * unbounded number of pools open.
 */
export const SESSION_LIMIT = 4

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
  /**
   * The resolved connection for one saved profile.
   * @param profile - the connection the call addresses.
   */
  connection: (profile: ConnectionProfile) => Promise<DatabaseConnection>
  /**
   * The dialect one saved profile is addressed through.
   * @param profile - the connection the call addresses.
   */
  dialect: (profile: ConnectionProfile) => DatabaseDialect
  /**
   * Where a session that cannot drain is reported.
   * @param message - what failed, in terms a deployment operator can act on.
   */
  warn: (message: string) => void
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
    dialect.name,
    connection.host,
    connection.port,
    connection.user,
    // The password distinguishes identities but must not sit in a long-lived map
    // key, so only a digest of it is kept.
    createHash('sha256').update(connection.password).digest('hex').slice(0, 16),
    connection.database ?? '',
  ])
}

/** One error's message, for a refusal that names the connection but never the secret. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * One plugin instance's read-only database access.
 *
 * Every call names the profile it addresses and re-resolves it, so a settings
 * edit, a new stored password, or a reconfigured dialect is honoured by the
 * next call. Sessions are kept per connection identity, so a call to one
 * connection does not disturb another's pool; past {@link SESSION_LIMIT} the
 * least recently used one is closed.
 */
export class DatabaseAccess {
  private readonly sessions = new Map<string, LiveSession>()

  /**
   * @param face - the connection and dialect readers every call resolves through.
   * @param sessionLimit - sessions to keep open at once; the least recently used is retired past it.
   */
  constructor(
    private readonly face: DatabaseAccessFace,
    private readonly sessionLimit: number = SESSION_LIMIT,
  ) {}

  /**
   * Run one dialect query and project its rows onto the shape it promises.
   * @param profile - the saved connection the call addresses.
   * @param query - the query to run.
   * @returns one entry per row the server answered.
   * @throws {Error} when the server refuses the statement or the session cannot reach it.
   */
  async run<R>(profile: ConnectionProfile, query: DialectQuery<R>, signal?: AbortSignal): Promise<R[]> {
    const live = await this.session(profile)
    const { rows } = await this.statement(live, query.statement, signal)
    return rows.map(row => query.project(row))
  }

  /**
   * Run one already-guarded statement and project its rows to lossless JSON.
   * @param profile - the saved connection the call addresses.
   * @param sql - the statement to execute, in the dialect's own placeholder style.
   * @param values - values the dialect's driver binds.
   * @returns the bounded, JSON-safe outcome.
   * @throws {Error} when the server refuses the statement or the session cannot reach it.
   */
  async query(
    profile: ConnectionProfile,
    sql: string,
    values: readonly DbScalar[] = [],
    signal?: AbortSignal,
  ): Promise<QueryOutcome> {
    const live = await this.session(profile)
    const { rows, columns, elapsedMs } = await this.statement(live, { sql, values }, signal)
    return {
      columns,
      rows: rows.slice(0, live.connection.maxRows),
      truncated: rows.length > live.connection.maxRows,
      elapsedMs,
    }
  }

  /**
   * Prove one saved connection works, for the settings page.
   * @param profile - the saved connection to probe.
   * @returns the server version and the probe's round trip time.
   * @throws {Error} when the connection fails or the server answers no version.
   */
  async probe(profile: ConnectionProfile): Promise<ConnectionProbe> {
    const live = await this.session(profile)
    const started = Date.now()
    const versions = await this.run(profile, live.dialect.version())
    const version = versions[0]
    if (version === undefined || version.length === 0) {
      throw new Error(`the server did not answer a version for ${connectionLabel(live.connection)}`)
    }
    return { version, latencyMs: Date.now() - started }
  }

  /** Close every open session; the plugin calls it on unload. */
  async dispose(): Promise<void> {
    const live = [...this.sessions.values()]
    this.sessions.clear()
    for (const one of live) await this.close(one, 'closing')
  }

  /** The session for one connection identity, opening or retiring as needed. */
  private async session(profile: ConnectionProfile): Promise<LiveSession> {
    const dialect = this.face.dialect(profile)
    const connection = await this.face.connection(profile)
    const key = sessionKey(connection, dialect)
    const existing = this.sessions.get(key)
    if (existing !== undefined) {
      // Re-inserting moves it to the end of the map's order, which is what makes
      // the retirement below drop the least recently used session.
      this.sessions.delete(key)
      this.sessions.set(key, existing)
      return existing
    }
    const opened: LiveSession = { key, dialect, connection, session: await dialect.open(connection) }
    this.sessions.set(key, opened)
    await this.retireOverflow()
    return opened
  }

  /** Close the least recently used session while the cache is over its limit. */
  private async retireOverflow(): Promise<void> {
    while (this.sessions.size > this.sessionLimit) {
      const oldestKey = this.sessions.keys().next().value
      if (oldestKey === undefined) return
      const oldest = this.sessions.get(oldestKey)
      this.sessions.delete(oldestKey)
      if (oldest !== undefined) await this.close(oldest, 'retiring the least recently used')
    }
  }

  /** Forget one session without closing it: a cancelled statement may already have ended it. */
  private drop(live: LiveSession): void {
    if (this.sessions.get(live.key) === live) this.sessions.delete(live.key)
  }

  /** Close one session, reporting a failure instead of letting it block the caller. */
  private async close(live: LiveSession, doing: string): Promise<void> {
    try {
      await live.session.close()
    } catch (error: unknown) {
      // A session that cannot drain is already unusable, and nothing may block
      // an unload or the next call.
      this.face.warn(`${doing} the ${live.dialect.label} session failed: ${messageOf(error)}`)
    }
  }

  /** Run one statement on a live session, wrapping any refusal with the connection it names. */
  private async statement(
    live: LiveSession,
    statement: DialectStatement,
    signal?: AbortSignal,
  ): Promise<{ rows: DbRow[], columns: string[], elapsedMs: number }> {
    const started = Date.now()
    let result: { rows: unknown[], columns: string[] }
    try {
      result = await live.session.run(signal === undefined ? statement : { ...statement, signal })
    } catch (error: unknown) {
      // A cancelled statement may have ended the session it ran on — a driver
      // without cancellation support is ended instead — so the cache drops it
      // and the next call opens a fresh one.
      if (signal?.aborted === true) this.drop(live)
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