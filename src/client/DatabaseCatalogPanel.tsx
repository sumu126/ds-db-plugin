/**
 * The browser catalog panel: the saved connections, the databases the chosen
 * one sees, and the tables and columns opened under them.
 *
 * The panel draws every row itself and reads nothing: the tree arrives through
 * its inject face, and each node's own state decides whether it shows a
 * spinner, a list, or the sentence the server refused with.
 *
 * @module dsh-ds-db/src/client/DatabaseCatalogPanel
 */

import { useEffect, useState, type ReactNode } from 'react'
import {
  Button, IconCheckOutline16, IconChevronDownOutline14, IconChevronRightOutline14,
  IconCopyOutline16, IconDatabaseOutline16, IconRefreshOutline16, IconSearchOutline16,
  type IconProps,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ColumnNode, TableNode } from '../contract.ts'
import type { DbBrowseFace, OpenDatabase } from './browse.ts'
import type { DbLocaleKey } from './locales.ts'
import styles from './panel.module.css'

/** Props the renderer binds for this right-sidebar tab. */
export type DatabaseCatalogPanelProps =
  PropsRuntime<'sidebar.right.pane.tab'>
  & PropsLocale<'settings.db'>
  & InjectFace<DbBrowseFace>

/** The translate seat, narrowed to this plugin's dictionary. */
type Copy = (key: DbLocaleKey, params?: Record<string, string>) => string

/**
 * The guide card's glyph for this tab type.
 * @param props - the square edge the guide asks for.
 * @returns the database glyph.
 */
export function DbPanelIcon({ size }: IconProps): ReactNode {
  return <IconDatabaseOutline16 size={size} />
}

/**
 * The panel's chip title.
 *
 * Registered rather than left to the type definition, because the chip otherwise
 * keeps the title the registry captured when the tab opened and a language
 * switch would leave it behind.
 * @param props - the slot's locale seat.
 * @returns the panel's name in the active language.
 */
export function DatabaseCatalogTitle({ t }: PropsLocale<'settings.db'>): ReactNode {
  return t('panelTitle')
}

/** A name matches when the filter is empty or is a substring of it. */
function matches(name: string, needle: string): boolean {
  return needle.length === 0 || name.toLowerCase().includes(needle)
}

/**
 * Render the browser catalog.
 * @param props - the panel's snapshot source, actions, and localized copy.
 * @returns the picker, the filter, and the tree; or the notice that replaces it.
 */
export function DatabaseCatalogPanel(props: DatabaseCatalogPanelProps): ReactNode {
  const { t, useDbBrowse, chooseConnection, editFilter, refresh, toggleDatabase, toggleTable } = props
  const state = useDbBrowse(snapshot => snapshot)
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

  if (!state.available) return <p className={styles.notice} role="status">{t('unavailable')}</p>
  if (state.connections.length === 0) return <p className={styles.notice} role="status">{t('browseEmpty')}</p>

  const needle = state.filter.trim().toLowerCase()
  const databases = state.databases.status === 'ready' ? state.databases.rows : []

  return (
    <section className={styles.panel} data-ds-db-catalog>
      <header className={styles.head}>
        <label className={styles.picker}>
          <span className={styles.srOnly}>{t('browseConnection')}</span>
          <select
            className={styles.select}
            value={state.connection}
            onChange={event => { chooseConnection(event.target.value) }}
          >
            {state.connections.map(connection => (
              <option key={connection.id} value={connection.id}>
                {connection.active ? `${connection.name} · ${t('inUse')}` : connection.name}
              </option>
            ))}
          </select>
        </label>
        <Button size="sm" variant="outline" icon={<IconRefreshOutline16 />} onClick={refresh}>
          {t('refresh')}
        </Button>
      </header>

      <div className={styles.search}>
        <IconSearchOutline16 size={14} />
        <input
          className={styles.searchInput}
          value={state.filter}
          aria-label={t('filter')}
          placeholder={t('filter')}
          onChange={event => { editFilter(event.target.value) }}
        />
      </div>

      <div className={styles.tree}>
        {state.databases.status === 'loading' ? <p className={styles.notice}>{t('loadingDatabases')}</p> : null}
        {state.databases.status === 'failed'
          ? <Failure message={state.databases.message} label={t('retry')} onRetry={refresh} />
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
                    <button
                      type="button"
                      className={styles.disclosure}
                      aria-expanded={entry?.open === true}
                      onClick={() => { toggleDatabase(node.name) }}
                    >
                      <span className={styles.caret}>
                        {entry?.open === true ? <IconChevronDownOutline14 /> : <IconChevronRightOutline14 />}
                      </span>
                      <span className={styles.name}>{node.name}</span>
                      <span className={styles.meta}>{node.charset}</span>
                    </button>
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
                        onToggle={toggleTable}
                        onRetry={() => { toggleDatabase(node.name) }}
                        onCopy={copy}
                      />
                      )
                    : null}
                </li>
              )
            })}
        </ul>
      </div>
    </section>
  )
}

/** Props of one expanded database's table list. */
interface TableListProps {
  entry: OpenDatabase
  database: string
  needle: string
  t: Copy
  copied: string
  onToggle: (database: string, table: string) => void
  onRetry: () => void
  onCopy: (key: string, text: string) => void
}

/**
 * The tables of one expanded database.
 * @param props - the database's own state and the panel's callbacks.
 * @returns the table rows, or the sentence the read refused with.
 */
function TableList(props: TableListProps): ReactNode {
  const { entry, database, needle, t, copied, onToggle, onRetry, onCopy } = props
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
            <button
              type="button"
              className={styles.disclosure}
              aria-expanded={entry.openTables[table.name]?.open === true}
              onClick={() => { onToggle(database, table.name) }}
            >
              <span className={styles.caret}>
                {entry.openTables[table.name]?.open === true
                  ? <IconChevronDownOutline14 />
                  : <IconChevronRightOutline14 />}
              </span>
              <span className={styles.name}>{table.name}</span>
              <span className={styles.meta}>{tableDetail(table, t)}</span>
            </button>
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
function tableDetail(table: TableNode, t: Copy): string {
  const parts = [table.type]
  if (table.engine !== null && table.engine.length > 0) parts.push(table.engine)
  parts.push(table.estimatedRows === null ? t('rowsUnknown') : t('rows', { count: String(table.estimatedRows) }))
  if (table.comment.length > 0) parts.push(table.comment)
  return parts.join(' · ')
}

/** Props of one table's column list. */
interface ColumnListProps {
  columns: OpenDatabase['openTables'][string]['columns'] | undefined
  t: Copy
  onRetry: () => void
}

/**
 * The columns of one expanded table.
 * @param props - the table's own state, the panel's copy seat, and its retry.
 * @returns the column rows, or the sentence the read refused with.
 */
function ColumnList(props: ColumnListProps): ReactNode {
  const { columns, t, onRetry } = props
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
        </li>
      ))}
    </ul>
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
