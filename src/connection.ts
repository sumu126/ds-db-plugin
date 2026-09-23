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
  /**
   * Set while the session is being closed, so it is closed exactly once.
   *
   * A cancelled statement and its disposal can both want to close the same
   * session, and a dialect that already ended its own session must not be asked
   * to end it twice.
   */
  closing?: Promise<void>
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
 * Whether a live session reports itself still usable; a session with nothing to
 * report is taken to be.
 */
function sessionUsable(live: LiveSession): boolean {
  return live.session.usable?.() ?? true
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
   * Closes still running, including sessions already dropped from the cache.
   * `dispose` waits for these too: a cancelled session left the cache, but the
   * process must not let go while it is still holding a pool.
   */
  private readonly pendingCloses = new Set<Promise<void>>()

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
    const { rows } = await this.attempt(profile, query.statement, signal)
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
    const { live, rows, columns, elapsedMs } = await this.attempt(profile, { sql, values }, signal)
    return {
      columns,
      rows: rows.slice(0, live.connection.maxRows),
      truncated: rows.length > live.connection.maxRows,
      elapsedMs,
    }
  }

  /**
   * Run one statement, opening a session and replacing one the dialect reports
   * unusable.
   *
   * The second try is for a session that died for a reason no call caused — a
   * pool closed outside this plugin — where the driver's own message ("pool is
   * closed") tells a model nothing it can act on. Every statement reaching here
   * has already passed the dialect's read-only rules, so running it again on a
   * fresh session cannot double an effect.
   * @param profile - the saved connection the call addresses.
   * @param statement - the statement to run.
   * @param signal - the call's cancellation.
   * @returns the rows, the columns, the elapsed time, and the session that ran it.
   * @throws {Error} when the server refuses the statement on a usable session too.
   */
  private async attempt(
    profile: ConnectionProfile,
    statement: DialectStatement,
    signal?: AbortSignal,
  ): Promise<{ live: LiveSession, rows: DbRow[], columns: string[], elapsedMs: number }> {
    const first = await this.session(profile)
    try {
      return { live: first, ...await this.statement(first, statement, signal) }
    } catch (error: unknown) {
      // `statement` evicts a session it found unusable before it throws, so an
      // unusable one here means the next call would already open another.
      if (sessionUsable(first)) throw error
      const second = await this.session(profile)
      return { live: second, ...await this.statement(second, statement, signal) }
    }
  }

  /**
   * Prove one saved connection works, for the settings page.
   * @param profile - the saved connection to probe.
   * @param signal - the caller's cancellation, so a probe the page no longer
   * waits for ends instead of holding a session until its timeout.
   * @returns the server version and the probe's round trip time.
   * @throws {Error} when the connection fails or the server answers no version.
   */
  async probe(profile: ConnectionProfile, signal?: AbortSignal): Promise<ConnectionProbe> {
    const live = await this.session(profile)
    const started = Date.now()
    const versions = await this.run(profile, live.dialect.version(), signal)
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
    // Sessions a cancellation dropped are no longer in the cache, but they are
    // still closing; an unload waits for those before it calls itself done. The
    // set is re-read rather than snapshotted, so a close starting while this
    // waits is waited for too instead of being left behind.
    while (this.pendingCloses.size > 0) {
      await Promise.allSettled([...this.pendingCloses])
    }
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

  /**
   * Forget one session and close it.
   *
   * A cancelled statement may have ended the session it ran on — a driver with
   * no cancellation of its own is ended instead — but it may just as well have
   * survived it, so dropping without closing would leak a pool that is in no
   * cache and that `dispose` no longer sees. `close` is idempotent, so this
   * either ends the session now or finds it already ending.
   */
  private drop(live: LiveSession): void {
    if (this.sessions.get(live.key) !== live) return
    this.sessions.delete(live.key)
    void this.close(live, 'dropping a cancelled session')
  }

  /** Close one session exactly once, reporting a failure instead of letting it block the caller. */
  private async close(live: LiveSession, doing: string): Promise<void> {
    const closing = live.closing ?? (live.closing = (async () => {
      try {
        await live.session.close()
      } catch (error: unknown) {
        // A session that cannot drain is already unusable, and nothing may block
        // an unload or the next call.
        this.face.warn(`${doing} the ${live.dialect.label} session failed: ${messageOf(error)}`)
      }
    })())
    // Recorded while it runs, so `dispose` still waits for a session that a
    // cancellation took out of the cache.
    this.pendingCloses.add(closing)
    try {
      await closing
    } finally {
      this.pendingCloses.delete(closing)
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
      // A call that failed while cancelled, or one whose session now reports
      // itself unusable, cannot be trusted to the cache: evict it, so the next
      // call opens a fresh session instead of failing until the plugin reloads.
      if (signal?.aborted === true || !sessionUsable(live)) this.drop(live)
      throw new Error(
        `${live.dialect.label} statement on ${connectionLabel(live.connection)} failed: ${messageOf(error)}`,
        { cause: error },
      )
    }
    // Cancellation does not have to fail the call: a driver that can only retire
    // its session — mysql2's pool has no `destroy()`, so ending it queues a
    // COM_QUIT behind the running statement — lets that statement finish and
    // returns its rows. The session is gone all the same, so the success path
    // evicts it too; keeping it would make every later call on that connection
    // fail with the driver's own "pool is closed" and nothing pointing at why.
    if (signal?.aborted === true || !sessionUsable(live)) this.drop(live)
    // Measured before projection, so the reported time is the server's work.
    const elapsedMs = Date.now() - started
    return { rows: result.rows.map(row => toJsonRow(row)), columns: result.columns, elapsedMs }
  }
}