/**
 * The query window: pick a connection, write one read-only statement, run it,
 * and read the rows it produced.
 *
 * The window draws every part of the outcome itself and reads nothing: the state
 * arrives through its inject face, and each phase decides what shows — the
 * sentence a refusal came back as, the running notice, or the result grid.
 *
 * @module dsh-ds-db/src/client/DatabaseQueryPanel
 */

import type { ReactNode } from 'react'
import {
  Button, IconCodeOutline16, IconPlayOutline16, IconStopFill16, type IconProps,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { QueryCell } from '../contract.ts'
import type { DbQueryFace, QueryAnswer } from './query.ts'
import type { DbLocaleKey } from './locales.ts'
import styles from './query.module.css'

/** Props the renderer binds for this right-sidebar tab. */
export type DatabaseQueryPanelProps =
  PropsRuntime<'sidebar.right.pane.tab'>
  & PropsLocale<'settings.db'>
  & InjectFace<DbQueryFace>

/** The translate seat, narrowed to this plugin's dictionary. */
type Copy = (key: DbLocaleKey, params?: Record<string, string>) => string

/**
 * The guide card's glyph for this tab type.
 * @param props - the square edge the guide asks for.
 * @returns the statement glyph.
 */
export function SqlPanelIcon({ size }: IconProps): ReactNode {
  return <IconCodeOutline16 size={size} />
}

/**
 * The window's chip title.
 *
 * Registered rather than left to the type definition, for the reason the
 * catalog's title is: a chip would otherwise keep the title the registry
 * captured when the tab opened.
 * @param props - the slot's locale seat.
 * @returns the window's name in the active language.
 */
export function DatabaseQueryTitle({ t }: PropsLocale<'settings.db'>): ReactNode {
  return t('queryTitle')
}

/**
 * One cell as the window shows it.
 *
 * A null cell and one the row does not carry both show as nothing, the way the
 * tool card's own table shows them: one query answered the same way should not
 * read differently in two places.
 * @param cell - the cell, or undefined when the row carries no such column.
 * @returns the text the cell shows.
 */
function cellText(cell: QueryCell | undefined): string {
  if (cell === undefined || cell === null) return ''
  if (typeof cell === 'string') return cell
  if (typeof cell === 'number' || typeof cell === 'boolean') return String(cell)
  return JSON.stringify(cell)
}

/**
 * Render the query window.
 * @param props - the window's snapshot source, actions, and localized copy.
 * @returns the picker, the editor, and one outcome; or the notice that replaces
 * them when there is nothing to query.
 */
export function DatabaseQueryPanel(props: DatabaseQueryPanelProps): ReactNode {
  const { t, useDbQuery, chooseConnection, editSql, run, cancel } = props
  const state = useDbQuery(snapshot => snapshot)
  const running = state.phase.status === 'running'

  if (!state.available) return <p className={styles.notice} role="status">{t('unavailable')}</p>
  if (state.connections.length === 0) return <p className={styles.notice} role="status">{t('browseEmpty')}</p>

  // The picker always shows a connection the window can address: a snapshot the
  // window holds while the settings document moves under it can name one that is
  // no longer saved, and an empty picker would say nothing about where a run goes.
  const selected = state.connections.some(entry => entry.id === state.connection)
    ? state.connection
    : state.connections[0]?.id ?? ''

  return (
    <section className={styles.panel} data-ds-db-query>
      <header className={styles.head}>
        <label className={styles.picker}>
          <span className={styles.srOnly}>{t('queryConnection')}</span>
          <select
            className={styles.select}
            value={selected}
            onChange={event => { chooseConnection(event.target.value) }}
          >
            {state.connections.map(connection => (
              <option key={connection.id} value={connection.id}>
                {connection.active ? `${connection.name} · ${t('inUse')}` : connection.name}
              </option>
            ))}
          </select>
        </label>
      </header>

      <div className={styles.editor}>
        <textarea
          className={styles.sql}
          value={state.sql}
          aria-label={t('querySql')}
          placeholder={t('queryPlaceholder')}
          spellCheck={false}
          onChange={event => { editSql(event.target.value) }}
          onKeyDown={(event) => {
            // The shortcut a terminal user reaches for; the button stays the
            // discoverable path.
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault()
              run()
            }
          }}
        />
        <div className={styles.actions}>
          <span className={styles.hint}>{t('queryHint')}</span>
          {running
            ? (
              <Button size="sm" variant="outline" icon={<IconStopFill16 />} onClick={cancel}>
                {t('cancel')}
              </Button>
              )
            : (
              <Button size="sm" variant="primary" icon={<IconPlayOutline16 />} onClick={run}>
                {t('queryRun')}
              </Button>
              )}
        </div>
      </div>

      <div className={styles.result}>
        {state.phase.status === 'running' ? <p className={styles.notice} role="status">{t('queryRunning')}</p> : null}
        {state.phase.status === 'failed'
          ? <div className={styles.failure} role="alert">{state.phase.message}</div>
          : null}
        {state.phase.status === 'done' ? <Result answer={state.phase.answer} t={t} /> : null}
      </div>
    </section>
  )
}

/** Props of one run's result. */
interface ResultProps {
  answer: QueryAnswer
  t: Copy
}

/**
 * One run's rows, under the line that says how many there were.
 * @param props - the run's outcome and the copy seat.
 * @returns the summary and the grid, or the notice that the statement returned
 * no row.
 */
function Result({ answer, t }: ResultProps): ReactNode {
  // A dialect that reports no column list still sends rows keyed by column, so
  // the grid falls back to the keys rather than drawing an empty table.
  const columns = answer.columns.length > 0 ? answer.columns : Object.keys(answer.rows[0] ?? {})
  return (
    <>
      <p className={styles.summary}>
        <span>{t('querySummary', { rows: String(answer.rowCount), ms: String(answer.elapsedMs) })}</span>
        {answer.truncated ? <span className={styles.cut}>{t('queryTruncated')}</span> : null}
      </p>
      {answer.rows.length === 0
        ? <p className={styles.notice}>{t('queryNoRows')}</p>
        : (
          <div className={styles.grid}>
            <table className={styles.table}>
              <thead>
                <tr>
                  {columns.map(column => (
                    <th key={column} className={styles.th} title={column}>{column}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {answer.rows.map((row, rowIndex) => (
                  // Rows have no identity of their own: the server answered an
                  // ordered set, so the position is what identifies one here.
                  <tr key={String(rowIndex)}>
                    {columns.map(column => (
                      <td
                        key={column}
                        className={styles.td}
                        // A cell is cut to a fixed width, so hovering is the only
                        // way to the rest of a long value.
                        title={cellText(row[column])}
                      >
                        {cellText(row[column])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          )}
    </>
  )
}
