/**
 * The database workbench: one page that browses a connection and queries it, the
 * way a database client does.
 *
 * The right sidebar shows one tab body at a time, so a tree and an editor in two
 * tabs can never be seen together — the workbench is one tab holding both: the
 * connection picker and the tree's toggle on top, then the tree and the work
 * half side by side, split by a divider the reader drags.
 *
 * The two halves are two controllers — the browse tree and the query — and the
 * picker drives both, so the tree and the editor can never be addressed at
 * different connections.
 *
 * @module dsh-ds-db/src/client/DatabaseWorkbenchPanel
 */

import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import {
  Button, IconBrowseOutline16, IconDatabaseOutline16, IconRefreshOutline16, type IconProps,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { TableNode } from '../contract.ts'
import type { BrowseActions, BrowseState } from './browse.ts'
import type { QueryActions, QueryState } from './query.ts'
import { DatabaseTree } from './DatabaseTree.tsx'
import { QueryWork } from './QueryWork.tsx'
import styles from './workbench.module.css'

/** Everything the workbench's slot entry injects: both halves and their hooks. */
export interface DbWorkbenchFace {
  hooks: {
    /** The tree's snapshot, bound by the renderer as `useDbBrowse`. */
    dbBrowse: SnapshotStore<BrowseState>
    /** The editor's snapshot, bound by the renderer as `useDbQuery`. */
    dbQuery: SnapshotStore<QueryState>
  }
  /** The tree's gestures. */
  browse: BrowseActions
  /** The editor's gestures. */
  work: QueryActions
}

/** Props the renderer binds for this right-sidebar tab. */
export type DatabaseWorkbenchPanelProps =
  PropsRuntime<'sidebar.right.pane.tab'>
  & PropsLocale<'settings.db'>
  & InjectFace<DbWorkbenchFace>

/**
 * Width the tree starts at, and the bounds a drag is kept inside.
 *
 * The two minimums together fit the sidebar's own default width, so the divider
 * never jumps on its first nudge: a tree at its basis already leaves the work
 * half its minimum.
 */
const TREE_BASIS = 200
const TREE_MIN = 120
const WORK_MIN = 180

/** How far one arrow key moves the divider. */
const KEY_STEP = 16

/**
 * The width the reader last dragged the tree to.
 *
 * Module state rather than a store: it belongs to the open page, not to the
 * connection or the settings document, and a tab closed and reopened should come
 * back the width it was left at.
 */
let rememberedTree = TREE_BASIS

/**
 * The guide card's glyph for this tab type.
 * @param props - the square edge the guide asks for.
 * @returns the database glyph.
 */
export function DbPanelIcon({ size }: IconProps): ReactNode {
  return <IconDatabaseOutline16 size={size} />
}

/**
 * The workbench's chip title.
 *
 * Registered rather than left to the type definition, because the chip otherwise
 * keeps the title the registry captured when the tab opened and a language
 * switch would leave it behind.
 * @param props - the slot's locale seat.
 * @returns the page's name in the active language.
 */
export function DatabaseWorkbenchTitle({ t }: PropsLocale<'settings.db'>): ReactNode {
  return t('panelTitle')
}

/**
 * Render the workbench.
 * @param props - both halves' state and gestures, and the localized copy.
 * @returns the toolbar and the tree-split-editor layout; or the notice that
 * replaces them when there is nothing to open.
 */
export function DatabaseWorkbenchPanel(props: DatabaseWorkbenchPanelProps): ReactNode {
  const { t, useDbBrowse, useDbQuery, browse, work } = props
  const tree = useDbBrowse(snapshot => snapshot)
  const query = useDbQuery(snapshot => snapshot)
  const columns = useRef<HTMLDivElement | null>(null)
  const editor = useRef<HTMLTextAreaElement>(null)
  /** Where the caret last was, so an insert from the tree lands there. */
  const caret = useRef<number | null>(null)
  const pendingCaret = useRef<number | null>(null)
  const [treeWidth, setTreeWidth] = useState(rememberedTree)
  const [treeOpen, setTreeOpen] = useState(true)

  // Restores the caret an insert moved, once React has written the new value.
  useEffect(() => {
    const at = pendingCaret.current
    const area = editor.current
    if (at === null || area === null) return
    pendingCaret.current = null
    area.focus()
    area.setSelectionRange(at, at)
  })

  if (!tree.available) return <p className={styles.notice} role="status">{t('unavailable')}</p>
  if (tree.connections.length === 0) return <p className={styles.notice} role="status">{t('browseEmpty')}</p>

  // The picker always shows a connection the workbench can address: a snapshot
  // held while the settings document moves under it can name one no longer
  // saved, and an empty picker would say nothing about where a statement goes.
  const selected = tree.connections.some(entry => entry.id === tree.connection)
    ? tree.connection
    : tree.connections[0]?.id ?? ''

  /** One connection for both halves: the tree and the editor move together. */
  const chooseConnection = (id: string): void => {
    browse.chooseConnection(id)
    work.chooseConnection(id)
  }

  /** Show what a table holds; the controller composes the statement it runs. */
  const readTable = (table: TableNode): void => { work.readTable(table.sqlName) }

  /** Put one statement-spelled name where the caret was. */
  const insert = (name: string): void => {
    // A page whose editor was never touched has no caret to speak of: the
    // controller then puts the name at the end, and says where it landed.
    const after = work.insertSql(name, caret.current ?? undefined)
    caret.current = after
    pendingCaret.current = after
  }

  /**
   * Put the divider at one width, inside the bounds the two halves need.
   *
   * The bounds are the panel's, so they are read here rather than kept in state:
   * the shell resizes this pane as well as the divider does.
   */
  const resize = (next: number): void => {
    const span = columns.current?.getBoundingClientRect().width ?? next
    const clamped = Math.min(Math.max(next, TREE_MIN), Math.max(TREE_MIN, span - WORK_MIN))
    rememberedTree = clamped
    setTreeWidth(clamped)
  }

  const startDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    // The default is prevented to keep the drag from selecting the text it moves
    // past, which also keeps the browser from focusing the divider — so it is
    // focused by hand, and a click then follows with arrow keys like a tab does.
    event.preventDefault()
    event.currentTarget.focus()
    const from = event.clientX
    const start = treeWidth
    const move = (moving: PointerEvent): void => { resize(start + moving.clientX - from) }
    const end = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
  }

  /** Move the divider by keyboard: a splitter that only answers a drag is unusable. */
  const moveWithKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    const step = event.key === 'ArrowLeft' ? -KEY_STEP : event.key === 'ArrowRight' ? KEY_STEP : 0
    if (step === 0) return
    event.preventDefault()
    resize(treeWidth + step)
  }

  return (
    <section className={styles.panel} data-ds-db-workbench>
      <header className={styles.toolbar}>
        <label className={styles.picker}>
          <span className={styles.srOnly}>{t('currentConnection')}</span>
          <select
            className={styles.select}
            value={selected}
            onChange={event => { chooseConnection(event.target.value) }}
          >
            {tree.connections.map(connection => (
              <option key={connection.id} value={connection.id}>
                {connection.active ? `${connection.name} · ${t('inUse')}` : connection.name}
              </option>
            ))}
          </select>
        </label>
        <Button size="sm" variant="outline" icon={<IconRefreshOutline16 />} onClick={browse.refresh}>
          {t('refresh')}
        </Button>
        <button
          type="button"
          className={styles.iconButton}
          aria-label={t('toggleTree')}
          aria-pressed={treeOpen}
          title={t('toggleTree')}
          onClick={() => { setTreeOpen(!treeOpen) }}
        >
          <IconBrowseOutline16 size={14} />
        </button>
      </header>

      <div className={styles.columns} ref={columns}>
        {treeOpen
          ? (
            <>
              <div className={styles.treePane} style={{ flex: `0 0 ${String(treeWidth)}px` }}>
                <DatabaseTree state={tree} browse={browse} onReadTable={readTable} onInsert={insert} t={t} />
              </div>
              <div
                className={styles.divider}
                role="separator"
                aria-orientation="vertical"
                aria-label={t('resizeTree')}
                // Focusable and arrow-operable: the width it sets is the whole
                // reason it is here, and a drag is not the only way to give it.
                tabIndex={0}
                onPointerDown={startDrag}
                onKeyDown={moveWithKey}
              />
            </>
            )
          : null}
        <div className={styles.workPane}>
          <QueryWork
            state={query}
            work={work}
            editor={editor}
            onCaret={(at) => { caret.current = at }}
            t={t}
          />
        </div>
      </div>
    </section>
  )
}
