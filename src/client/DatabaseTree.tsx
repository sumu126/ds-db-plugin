/**
 * The browse tree: a connection's databases, the tables opened under them, and
 * the columns opened under those.
 *
 * It draws rows and reads nothing: the tree arrives through its props, and each
 * node's own state decides whether it shows a spinner, a list, or the sentence
 * the server refused with. Two gestures belong to the workbench rather than to
 * the tree — reading a table, and putting a name into the editor — so they are
 * handed in as callbacks.
 *
 * @module dsh-ds-db/src/client/DatabaseTree
 */

import { useEffect, useState, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  IconChevronDownOutline14, IconChevronRightOutline14, IconCheckOutline16,
  IconCopyOutline16, IconDataOutline16, IconPlusOutline16, IconSearchOutline16,
} from './icons.ts'
import type { ColumnNode, TableNode } from '../contract.ts'
import type { BrowseActions, BrowseState, OpenDatabase } from './browse.ts'
import type { DbCopy } from './locales.ts'
import styles from './tree.module.css'

/** Everything the tree renders, and the two gestures it hands back. */
export interface DatabaseTreeProps {
  /** The tree as the browse controller holds it. */
  state: BrowseState
  /** The tree's own gestures: expanding, filtering, refreshing. */
  browse: BrowseActions
  /** Read one table: put its statement in the editor and run it. */
  onReadTable: (table: TableNode) => void
  /** Put one statement-spelled name into the editor at the caret. */
  onInsert: (name: string) => void
  /** The copy seat. */
  t: DbCopy
}

/** A name matches when the filter is empty or is a substring of it. */
function matches(name: string, needle: string): boolean {
  return needle.length === 0 || name.toLowerCase().includes(needle)
}

/**
 * Render the browse tree.
 * @param props - the tree state, its gestures, and the workbench's two callbacks.
 * @returns the filter and the three-level tree.
 */
export function DatabaseTree(props: DatabaseTreeProps): ReactNode {
  const { state, browse, onReadTable, onInsert, t } = props
  const [copied, setCopied] = useState('')

  useEffect(() => {
    if (copied === '') return
    const timer = setTimeout(() => { setCopied('') }, 1200)
    return () => { clearTimeout(timer) }
  }, [copied])

  const copy = (key: string, text: string): void => {
    // A non-loopback page has no clipboard; the row simply keeps its icon.
    void navigator.clipboard?.writeText(text)
    setCopied(key)
  }

  const needle = state.filter.trim().toLowerCase()
  const databases = state.databases.status === 'ready' ? state.databases.rows : []

  return (
    <div className={styles.tree} data-ds-db-tree>
      <div className={styles.search}>
        <IconSearchOutline16 size={14} />
        <input
          className={styles.searchInput}
          value={state.filter}
          aria-label={t('filter')}
          placeholder={t('filter')}
          onChange={event => { browse.editFilter(event.target.value) }}
        />
      </div>
      <div className={styles.scroll}>
        {state.databases.status === 'loading' ? <p className={styles.notice}>{t('loadingDatabases')}</p> : null}
        {state.databases.status === 'failed'
          ? <Failure message={state.databases.message} label={t('retry')} onRetry={browse.refresh} />
          : null}
        {state.databases.status === 'ready' && databases.length === 0
          ? <p className={styles.notice}>{t('noDatabases')}</p>
          : null}
        <ul className={styles.list}>
          {databases
            .filter(node => {
              const entry = state.open[node.name]
              const children = entry?.tables.status === 'ready' ? entry.tables.rows : []
              return matches(node.name, needle) || children.some(table => matches(table.name, needle))
            })
            .map((node) => {
              const entry = state.open[node.name]
              return (
                <li key={node.name}>
                  <div className={styles.row}>
                    <Caret
                      open={entry?.open === true}
                      name={node.name}
                      t={t}
                      onClick={() => { browse.toggleDatabase(node.name) }}
                    />
                    <span className={styles.name} title={node.name}>{node.name}</span>
                    <span className={styles.meta}>{node.charset}</span>
                    <CopyButton
                      label={t('copyName', { name: node.name })}
                      copied={copied === node.name}
                      onCopy={() => { copy(node.name, node.name) }}
                    />
                  </div>
                  {entry?.open === true
                    ? (
                      <TableList
                        entry={entry}
                        database={node.name}
                        needle={needle}
                        t={t}
                        copied={copied}
                        onReadTable={onReadTable}
                        onInsert={onInsert}
                        onToggle={browse.toggleTable}
                        onRetry={() => { browse.toggleDatabase(node.name) }}
                        onCopy={copy}
                      />
                      )
                    : null}
                </li>
              )
            })}
        </ul>
      </div>
    </div>
  )
}

/** Props of one expanded database's table list. */
interface TableListProps {
  entry: OpenDatabase
  database: string
  needle: string
  t: DbCopy
  copied: string
  onReadTable: (table: TableNode) => void
  onInsert: (name: string) => void
  onToggle: (database: string, table: string) => void
  onRetry: () => void
  onCopy: (key: string, text: string) => void
}

/**
 * The tables of one expanded database.
 * @param props - the database's own state and the workbench's callbacks.
 * @returns the table rows, or the sentence the read refused with.
 */
function TableList(props: TableListProps): ReactNode {
  const { entry, database, needle, t, copied, onReadTable, onInsert, onToggle, onRetry, onCopy } = props
  if (entry.tables.status === 'loading') return <p className={styles.notice}>{t('loadingTables')}</p>
  if (entry.tables.status === 'failed') {
    return <Failure message={entry.tables.message} label={t('retry')} onRetry={onRetry} />
  }
  const tables = entry.tables.rows.filter(table => matches(table.name, needle) || matches(database, needle))
  if (tables.length === 0) return <p className={styles.notice}>{t('noTables')}</p>
  return (
    <ul className={`${styles.list} ${styles.child}`}>
      {tables.map(table => (
        <li key={table.name}>
          <div className={styles.row}>
            <Caret
              open={entry.openTables[table.name]?.open === true}
              name={table.name}
              t={t}
              onClick={() => { onToggle(database, table.name) }}
            />
            <span
              className={styles.name}
              title={t('readTable', { name: table.name })}
              // The gesture a database client is read through: the caret still
              // shows the columns, and reading the table is a double click. The
              // row's own button is the same read, for a pointer that cannot
              // double-click and for a keyboard that has no such gesture.
              onDoubleClick={() => { onReadTable(table) }}
            >
              {table.name}
            </span>
            <span className={styles.meta}>{tableDetail(table, t)}</span>
            <IconAction
              label={t('readTable', { name: table.name })}
              icon={<IconDataOutline16 size={13} />}
              onClick={() => { onReadTable(table) }}
            />
            <IconAction
              label={t('insertName', { name: table.name })}
              icon={<IconPlusOutline16 size={13} />}
              onClick={() => { onInsert(table.sqlName) }}
            />
            <CopyButton
              label={t('copyName', { name: `${database}.${table.name}` })}
              copied={copied === `${database}.${table.name}`}
              onCopy={() => { onCopy(`${database}.${table.name}`, `${database}.${table.name}`) }}
            />
          </div>
          {entry.openTables[table.name]?.open === true
            ? (
              <ColumnList
                columns={entry.openTables[table.name]?.columns}
                t={t}
                onInsert={onInsert}
                onRetry={() => { onToggle(database, table.name) }}
              />
              )
            : null}
        </li>
      ))}
    </ul>
  )
}

/** The one-line detail a table row shows: type, engine, and row estimate. */
function tableDetail(table: TableNode, t: DbCopy): string {
  const parts = [table.type]
  if (table.engine !== null && table.engine.length > 0) parts.push(table.engine)
  parts.push(table.estimatedRows === null ? t('rowsUnknown') : t('rows', { count: String(table.estimatedRows) }))
  if (table.comment.length > 0) parts.push(table.comment)
  return parts.join(' · ')
}

/** Props of one table's column list. */
interface ColumnListProps {
  columns: OpenDatabase['openTables'][string]['columns'] | undefined
  t: DbCopy
  onInsert: (name: string) => void
  onRetry: () => void
}

/**
 * The columns of one expanded table.
 * @param props - the table's own state, the copy seat, and the insert gesture.
 * @returns the column rows, or the sentence the read refused with.
 */
function ColumnList(props: ColumnListProps): ReactNode {
  const { columns, t, onInsert, onRetry } = props
  if (columns === undefined || columns.status === 'loading') return <p className={styles.notice}>{t('loadingColumns')}</p>
  if (columns.status === 'failed') return <Failure message={columns.message} label={t('retry')} onRetry={onRetry} />
  if (columns.rows.length === 0) return <p className={styles.notice}>{t('noColumns')}</p>
  return (
    <ul className={styles.list}>
      {columns.rows.map((column: ColumnNode) => (
        <li key={column.name} className={styles.leaf}>
          <span className={styles.leafName}>{column.name}</span>
          <span className={styles.leafType}>{column.type}</span>
          {column.key.length > 0 ? <span className={styles.tag}>{column.key}</span> : null}
          {!column.nullable ? <span className={styles.tag}>{t('notNull')}</span> : null}
          {column.extra.length > 0 ? <span className={styles.tag}>{column.extra}</span> : null}
          <IconAction
            label={t('insertName', { name: column.name })}
            icon={<IconPlusOutline16 size={13} />}
            onClick={() => { onInsert(column.sqlName) }}
          />
        </li>
      ))}
    </ul>
  )
}

/** Props of one node's disclosure. */
interface CaretProps {
  open: boolean
  name: string
  t: DbCopy
  onClick: () => void
}

/**
 * The disclosure one parent row carries.
 *
 * Its own control rather than the row's: reading a table is a double click on
 * the name, and a single click on a button that also owned the name would fire
 * on the way to it. The name it toggles is in its accessible name, so a row's
 * controls do not all read as the node they belong to.
 * @param props - whether the node is open, whose node it is, the copy seat, and the gesture.
 * @returns the caret button.
 */
function Caret({ open, name, t, onClick }: CaretProps): ReactNode {
  const label = t(open ? 'collapseNode' : 'expandNode', { name })
  return (
    <button
      type="button"
      className={styles.caretButton}
      aria-expanded={open}
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      {open ? <IconChevronDownOutline14 /> : <IconChevronRightOutline14 />}
    </button>
  )
}

/** Props of a refusal shown in place of a list. */
interface FailureProps {
  message: string
  label: string
  onRetry: () => void
}

/**
 * One node's refusal, with the gesture that reads it again.
 * @param props - the sentence, the retry's label, and the retry.
 * @returns the refusal block.
 */
function Failure({ message, label, onRetry }: FailureProps): ReactNode {
  return (
    <div className={styles.failure} role="alert">
      <span>{message}</span>
      <Button size="sm" variant="outline" onClick={onRetry}>{label}</Button>
    </div>
  )
}

/** Props of the copy action beside a row. */
interface CopyButtonProps {
  label: string
  copied: boolean
  onCopy: () => void
}

/**
 * The copy control one tree row carries, showing what it did.
 * @param props - the accessible name, whether this row was just copied, and the gesture.
 * @returns the icon button.
 */
function CopyButton({ label, copied, onCopy }: CopyButtonProps): ReactNode {
  return (
    <button
      type="button"
      className={`${styles.iconButton} ${copied ? styles.copied : ''}`}
      aria-label={label}
      title={label}
      onClick={onCopy}
    >
      {copied ? <IconCheckOutline16 size={13} /> : <IconCopyOutline16 size={13} />}
    </button>
  )
}

/** Props of an icon-only row action. */
interface IconActionProps {
  label: string
  icon: ReactNode
  onClick: () => void
}

/**
 * One icon-only action a row carries.
 * @param props - the accessible name, the glyph, and the gesture.
 * @returns the icon button.
 */
function IconAction({ label, icon, onClick }: IconActionProps): ReactNode {
  return (
    <button
      type="button"
      className={styles.iconButton}
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      {icon}
    </button>
  )
}
