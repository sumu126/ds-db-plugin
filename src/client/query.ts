/**
 * The query window's model: the statement the reader typed, the connection it
 * runs against, and the one outcome that run left.
 *
 * One statement at a time, read-only, on the host route the `db_query` tool's
 * judgement and row bound belong to — so what the window shows is what a tool
 * call would have returned. Nothing here touches React or the wire: the route
 * arrives through the face the browser entry supplies, the way the catalog's
 * three reads do.
 *
 * @module dsh-ds-db/src/client/query
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { DatabaseSettings, QueryCell } from '../contract.ts'
import type { BrowseConnection } from './browse.ts'

/** One run's answer: the rows a statement produced, or why there are none. */
export interface QueryAnswer {
  /** Column names, in result order. */
  columns: string[]
  /** Rows keyed by column name, cut at the connection's row cap. */
  rows: Record<string, QueryCell>[]
  /** Rows returned, which is `rows.length`. */
  rowCount: number
  /** Whether the result was cut at the connection's row cap. */
  truncated: boolean
  /** Statement wall time in milliseconds. */
  elapsedMs: number
  /** Why there are no rows, as one sentence the window shows. */
  message?: string
}

/**
 * Run one statement and bring back what the tool would have received.
 * @param connection - the connection to run against, by name.
 * @param sql - the statement exactly as the reader wrote it.
 * @param signal - cancellation, so a window that closed stops waiting.
 * @returns the rows, or the sentence the run was refused with.
 */
export interface QueryRun {
  (connection: string, sql: string, signal: AbortSignal): Promise<QueryAnswer>
}

/**
 * What the window is showing: nothing yet, a run in flight, the one outcome
 * that run left, or the sentence it was refused with.
 */
export type QueryPhase =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'done'; answer: QueryAnswer }
  | { status: 'failed'; message: string }

/** Everything the window renders. */
export interface QueryState {
  /** False until the Host serves this settings namespace. */
  available: boolean
  /** Saved connections, in document order. */
  connections: BrowseConnection[]
  /** Id of the connection to run against; empty when nothing is saved. */
  connection: string
  /** The statement as the reader typed it. */
  sql: string
  /** What the last run left. */
  phase: QueryPhase
}

/** What the window calls; every one is a user gesture. */
export interface QueryActions {
  /** Run against another saved connection; drops the previous outcome. */
  chooseConnection: (id: string) => void
  /** Take the statement as typed; a shown outcome is kept. */
  editSql: (text: string) => void
  /** Run the statement; ignored while a run is in flight. */
  run: () => void
  /** End the run in flight, leaving the window with nothing shown. */
  cancel: () => void
}

/** Everything the window's slot entry injects. */
export interface DbQueryFace extends QueryActions {
  hooks: {
    /** Window snapshot, bound by the renderer as `useDbQuery`. */
    dbQuery: SnapshotStore<QueryState>
  }
}

/**
 * The window over one settings namespace and one statement route.
 *
 * The settings section is the source of truth for which connections exist and
 * which one the tools address; the statement is the reader's, and one run's
 * outcome replaces the previous one.
 */
export class DatabaseQueryController {
  private readonly store: SnapshotStore<QueryState>
  /** The connection the user picked; empty means the one the tools address. */
  private chosen = ''
  private sql = ''
  private phase: QueryPhase = { status: 'idle' }
  /**
   * The run in flight. Held rather than a boolean so a cancel ends exactly the
   * run it was asked to: an answer that arrives after it is dropped instead of
   * replacing what the window shows now.
   */
  private running: AbortController | undefined

  /**
   * @param scope - the settings namespace holding the saved connections.
   * @param route - the one statement route.
   */
  constructor(
    private readonly scope: SettingsScope<DatabaseSettings>,
    private readonly route: QueryRun,
  ) {
    this.store = createSnapshotStore<QueryState>(this.projection())
    // A connection added, renamed, or made default changes the picker and may
    // move the address; the window follows rather than holding a stale name.
    scope.subscribe(() => { this.publish() })
  }

  /** @returns the window's snapshot store. */
  get snapshot(): SnapshotStore<QueryState> {
    return this.store
  }

  /** @returns the window's actions and its snapshot source. */
  face(): DbQueryFace {
    return {
      hooks: { dbQuery: this.store },
      chooseConnection: (id) => {
        const before = this.addressed()
        this.chosen = id
        // Only a real move drops the outcome: re-picking the connection already
        // addressed is not a reason to throw away the rows on screen.
        if (this.addressed() !== before) {
          this.cancel()
          this.phase = { status: 'idle' }
        }
        this.publish()
      },
      editSql: (text) => {
        this.sql = text
        this.publish()
      },
      run: () => { void this.execute() },
      cancel: () => { this.cancel() },
    }
  }

  /** Stop the run in flight; the plugin calls it on unload. */
  dispose(): void {
    this.running?.abort()
    this.running = undefined
  }

  /** The connection to run against: the user's pick, else the one in use, else the first saved. */
  private addressed(): string {
    const value = this.scope.getSnapshot().value
    const connections = value?.connections ?? []
    if (this.chosen !== '' && connections.some(profile => profile.id === this.chosen)) return this.chosen
    const active = value?.activeId ?? ''
    if (connections.some(profile => profile.id === active)) return active
    return connections[0]?.id ?? ''
  }

  /** The name the route addresses one connection by; an unknown id is sent as itself. */
  private address(): string {
    const connections = this.scope.getSnapshot().value?.connections ?? []
    return connections.find(profile => profile.id === this.addressed())?.name ?? this.addressed()
  }

  private projection(): QueryState {
    const snapshot = this.scope.getSnapshot()
    const value = snapshot.value
    const active = value?.activeId ?? ''
    return {
      available: snapshot.status === 'ready',
      connections: (value?.connections ?? []).map(profile => ({
        id: profile.id, name: profile.name, active: profile.id === active,
      })),
      connection: this.addressed(),
      sql: this.sql,
      phase: this.phase,
    }
  }

  private publish(): void {
    this.store.set(this.projection())
  }

  /** End the run in flight, if there is one, and show nothing in its place. */
  private cancel(): void {
    const running = this.running
    if (running === undefined) return
    this.running = undefined
    running.abort()
    this.phase = { status: 'idle' }
    this.publish()
  }

  private async execute(): Promise<void> {
    if (this.running !== undefined) return
    const controller = new AbortController()
    this.running = controller
    const connection = this.address()
    const sql = this.sql
    this.phase = { status: 'running' }
    this.publish()
    const answer = await this.route(connection, sql, controller.signal)
    // A cancel or a later run owns the window now; this answer describes neither.
    if (this.running !== controller) return
    this.running = undefined
    this.phase = answer.message === undefined
      ? { status: 'done', answer }
      : { status: 'failed', message: answer.message }
    this.publish()
  }
}
