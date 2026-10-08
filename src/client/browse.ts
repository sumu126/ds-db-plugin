/**
 * The browser catalog panel's model: the saved connections, the databases one
 * of them sees, and the tables and columns opened under it.
 *
 * Reads only, and every node keeps its own outcome: a database the server
 * refuses stays listed with its own sentence and its own retry rather than
 * blanking the ones that answered. Nothing here touches React or the wire — the
 * three routes arrive through the face the browser entry supplies, the way the
 * settings page's probe does.
 *
 * @module dsh-ds-db/src/client/browse
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ColumnNode, DatabaseNode, DatabaseSettings, TableNode } from '../contract.ts'

/** One list's outcome, so a node shows its own progress and its own refusal. */
export type Loaded<T> =
  | { status: 'loading' }
  | { status: 'ready'; rows: T[] }
  | { status: 'failed'; message: string }

/** One catalog read's answer: the rows, or why there are none. */
export interface CatalogAnswer<T> {
  /** The rows in server order; empty when the read was refused. */
  rows: T[]
  /** Why there are no rows, as one sentence the panel shows. */
  message?: string
}

/** The three reads the panel makes, each one this plugin's own route. */
export interface BrowseReads {
  /**
   * @param connection - the connection to read, by name.
   * @param signal - cancellation, so a panel that closed stops waiting.
   * @returns the connection's databases.
   */
  databases: (connection: string, signal: AbortSignal) => Promise<CatalogAnswer<DatabaseNode>>
  /**
   * @param connection - the connection to read, by name.
   * @param database - the database to list.
   * @param signal - cancellation.
   * @returns that database's tables and views.
   */
  tables: (connection: string, database: string, signal: AbortSignal) => Promise<CatalogAnswer<TableNode>>
  /**
   * @param connection - the connection to read, by name.
   * @param database - the database holding the table.
   * @param table - the table to describe.
   * @param signal - cancellation.
   * @returns that table's columns.
   */
  columns: (connection: string, database: string, table: string, signal: AbortSignal) => Promise<CatalogAnswer<ColumnNode>>
}

/** One saved connection as the picker lists it. */
export interface BrowseConnection {
  /** Id the settings section addresses it by. */
  id: string
  /** Display name, which is also what a route is addressed by. */
  name: string
  /** Whether the tools currently address this connection. */
  active: boolean
}

/** One table the user opened, and what it read. */
export interface OpenTable {
  /** Whether the columns are showing; a collapsed table keeps what it read. */
  open: boolean
  /** The table's columns. */
  columns: Loaded<ColumnNode>
}

/** One database the user opened, and what it read. */
export interface OpenDatabase {
  /** Whether the database is expanded; a collapsed one keeps what it read. */
  open: boolean
  /** The database's tables. */
  tables: Loaded<TableNode>
  /** One entry per table the user opened, keyed by table name. */
  openTables: Record<string, OpenTable>
}

/** Everything the panel renders. */
export interface BrowseState {
  /** False until the Host serves this settings namespace. */
  available: boolean
  /** Saved connections, in document order. */
  connections: BrowseConnection[]
  /** Id of the connection being browsed; empty when nothing is saved. */
  connection: string
  /** Substring every listed name must carry; empty lists everything. */
  filter: string
  /** The browsed connection's databases. */
  databases: Loaded<DatabaseNode>
  /** One entry per database the user opened, keyed by database name. */
  open: Record<string, OpenDatabase>
}

/** What the panel calls; every one is a user gesture. */
export interface BrowseActions {
  /** Browse another saved connection, reading its databases at once. */
  chooseConnection: (id: string) => void
  /** Narrow the listed names; purely a view over what is already read. */
  editFilter: (text: string) => void
  /** Re-read the browsed connection and drop every expansion. */
  refresh: () => void
  /** Expand a database, reading its tables the first time; a failed read retries. */
  toggleDatabase: (name: string) => void
  /** Expand a table, reading its columns the first time; a failed read retries. */
  toggleTable: (database: string, table: string) => void
}

/** Everything the panel's slot entry injects. */
export interface DbBrowseFace extends BrowseActions {
  hooks: {
    /** Panel snapshot, bound by the renderer as `useDbBrowse`. */
    dbBrowse: SnapshotStore<BrowseState>
  }
}

/**
 * The panel over one settings namespace and three catalog routes.
 *
 * The settings section is the source of truth for which connections exist and
 * which one the tools address; what the panel lists under them is read on
 * demand and kept until the connection changes or the user refreshes.
 */
export class DatabaseBrowseController {
  private readonly store: SnapshotStore<BrowseState>
  /** Cancels every read when the plugin unloads. */
  private readonly reads = new AbortController()
  /** The connection the user picked; empty means the one the tools address. */
  private chosen = ''
  /** Id of the connection `databases` and `open` describe. */
  private browsed = ''
  private filter = ''
  private databases: Loaded<DatabaseNode> = { status: 'ready', rows: [] }
  private open: Record<string, OpenDatabase> = {}

  /**
   * @param scope - the settings namespace holding the saved connections.
   * @param routes - the three catalog reads.
   */
  constructor(
    private readonly scope: SettingsScope<DatabaseSettings>,
    private readonly routes: BrowseReads,
  ) {
    this.browsed = this.addressed()
    if (this.browsed !== '') this.databases = { status: 'loading' }
    this.store = createSnapshotStore<BrowseState>(this.projection())
    scope.subscribe(() => {
      this.follow()
      this.publish()
    })
    if (this.browsed !== '') void this.readDatabases()
  }

  /** @returns the panel's snapshot store. */
  get snapshot(): SnapshotStore<BrowseState> {
    return this.store
  }

  /** @returns the panel's actions and its snapshot source. */
  face(): DbBrowseFace {
    return {
      hooks: { dbBrowse: this.store },
      chooseConnection: (id) => {
        this.chosen = id
        this.browse(this.addressed())
        this.publish()
      },
      editFilter: (text) => {
        this.filter = text
        this.publish()
      },
      refresh: () => {
        this.browse(this.addressed())
        this.publish()
      },
      toggleDatabase: (name) => { this.toggleDatabase(name) },
      toggleTable: (database, table) => { this.toggleTable(database, table) },
    }
  }

  /** Stop the reads the panel no longer needs. */
  dispose(): void {
    this.reads.abort()
  }

  /** The connection to browse: the user's pick, else the one in use, else the first saved. */
  private addressed(): string {
    const value = this.scope.getSnapshot().value
    const connections = value?.connections ?? []
    if (this.chosen !== '' && connections.some(profile => profile.id === this.chosen)) return this.chosen
    const active = value?.activeId ?? ''
    if (connections.some(profile => profile.id === active)) return active
    return connections[0]?.id ?? ''
  }

  /** Follow the settings document, and read the connection it now names. */
  private follow(): void {
    const wanted = this.addressed()
    if (wanted !== this.browsed) this.browse(wanted)
  }

  /** Point the panel at one connection, dropping what the previous one read. */
  private browse(id: string): void {
    this.browsed = id
    this.open = {}
    this.databases = id === '' ? { status: 'ready', rows: [] } : { status: 'loading' }
    if (id !== '') void this.readDatabases()
  }

  /** The name a route addresses one connection by; an unknown id is sent as itself. */
  private address(id: string): string {
    const connections = this.scope.getSnapshot().value?.connections ?? []
    return connections.find(profile => profile.id === id)?.name ?? id
  }

  private projection(): BrowseState {
    const snapshot = this.scope.getSnapshot()
    const value = snapshot.value
    const active = value?.activeId ?? ''
    return {
      available: snapshot.status === 'ready',
      connections: (value?.connections ?? []).map(profile => ({
        id: profile.id, name: profile.name, active: profile.id === active,
      })),
      connection: this.browsed,
      filter: this.filter,
      databases: this.databases,
      open: this.open,
    }
  }

  private publish(): void {
    this.store.set(this.projection())
  }

  private async readDatabases(): Promise<void> {
    const forConnection = this.browsed
    const answer = await this.routes.databases(this.address(forConnection), this.reads.signal)
    if (this.browsed !== forConnection) return
    this.databases = settle(answer)
    this.publish()
  }

  private async readTables(database: string): Promise<void> {
    const forConnection = this.browsed
    const answer = await this.routes.tables(this.address(forConnection), database, this.reads.signal)
    const entry = this.open[database]
    // The connection may have changed, and a collapsed node may have been
    // discarded: either way this answer describes a tree that is no longer here.
    if (this.browsed !== forConnection || entry === undefined) return
    this.open = { ...this.open, [database]: { ...entry, tables: settle(answer) } }
    this.publish()
  }

  private async readColumns(database: string, table: string): Promise<void> {
    const forConnection = this.browsed
    const answer = await this.routes.columns(this.address(forConnection), database, table, this.reads.signal)
    const entry = this.open[database]
    const node = entry?.openTables[table]
    if (this.browsed !== forConnection || entry === undefined || node === undefined) return
    this.open = {
      ...this.open,
      [database]: {
        ...entry,
        openTables: { ...entry.openTables, [table]: { ...node, columns: settle(answer) } },
      },
    }
    this.publish()
  }

  private toggleDatabase(name: string): void {
    const entry = this.open[name]
    if (entry === undefined || entry.tables.status === 'failed') {
      const loading: OpenDatabase = { open: true, tables: { status: 'loading' }, openTables: entry?.openTables ?? {} }
      this.open = { ...this.open, [name]: loading }
      this.publish()
      void this.readTables(name)
      return
    }
    if (entry.tables.status === 'loading') return
    this.open = { ...this.open, [name]: { ...entry, open: !entry.open } }
    this.publish()
  }

  private toggleTable(database: string, table: string): void {
    const entry = this.open[database]
    if (entry === undefined) return
    const node = entry.openTables[table]
    const withNode = (next: OpenTable): void => {
      this.open = { ...this.open, [database]: { ...entry, openTables: { ...entry.openTables, [table]: next } } }
      this.publish()
    }
    if (node === undefined || node.columns.status === 'failed') {
      withNode({ open: true, columns: { status: 'loading' } })
      void this.readColumns(database, table)
      return
    }
    if (node.columns.status === 'loading') return
    withNode({ ...node, open: !node.open })
  }
}

/**
 * One read's answer as the panel holds it.
 * @param answer - what the route answered.
 * @returns the loaded list, or the sentence the route refused with.
 */
function settle<T>(answer: CatalogAnswer<T>): Loaded<T> {
  return answer.message === undefined ? { status: 'ready', rows: answer.rows } : { status: 'failed', message: answer.message }
}
