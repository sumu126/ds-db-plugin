/**
 * The work half of the database workbench: the statement editor and the one
 * outcome the last run left.
 *
 * It draws what the query state holds and reads nothing else: each phase decides
 * what shows — the sentence a refusal came back as, the running notice, or the
 * result grid. The editor's element is handed in rather than owned, because the
 * browse tree inserts names into it at the caret.
 *
 * @module dsh-ds-db/src/client/QueryWork
 */

import type { ReactNode, RefObject } from 'react'
import {
  Button, IconPlayOutline16, IconStopFill16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { QueryCell } from '../contract.ts'
import type { QueryActions, QueryAnswer, QueryState } from './query.ts'
import type { DbCopy } from './locales.ts'
import styles from './query.module.css'

/** Everything the work half renders, and the editor element it writes through. */
export interface QueryWorkProps {
  /** The query state as the controller holds it. */
  state: QueryState
  /** Its gestures. */
  work: QueryActions
  /** The editor's element, so an insert from the tree lands at the caret. */
  editor: RefObject<HTMLTextAreaElement>
  /**
   * Where the caret is, whenever it moves.
   *
   * Reported rather than owned: the element lives here, but the name the tree
   * inserts has to land where the reader left the caret, and the tree is a
   * sibling. A blurred textarea still remembers its caret, so this survives the
   * click on the tree that sends the insert.
   * @param at - the caret's offset in the statement.
   */
  onCaret: (at: number) => void
  /** The copy seat. */
  t: DbCopy
}

/**
 * One cell as the workbench shows it.
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
 * Render the editor and the last run's outcome.
 * @param props - the query state, its gestures, the editor element, and the copy seat.
 * @returns the statement editor and one outcome below it.
 */
export function QueryWork({ state, work, editor, onCaret, t }: QueryWorkProps): ReactNode {
  const running = state.phase.status === 'running'
  return (
    <div className={styles.work} data-ds-db-work>
      <div className={styles.editor}>
        <textarea
          ref={editor}
          className={styles.sql}
          value={state.sql}
          aria-label={t('querySql')}
          placeholder={t('queryPlaceholder')}
          spellCheck={false}
          onChange={event => { work.editSql(event.target.value) }}
          onSelect={event => { onCaret(event.currentTarget.selectionStart) }}
          onKeyDown={(event) => {
            // The shortcut a terminal user reaches for; the button stays the
            // discoverable path.
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault()
              work.run()
            }
          }}
        />
        <div className={styles.actions}>
          <span className={styles.hint}>{t('queryHint')}</span>
          {running
            ? (
              <Button size="sm" variant="outline" icon={<IconStopFill16 />} onClick={work.cancel}>
                {t('cancel')}
              </Button>
              )
            : (
              <Button size="sm" variant="primary" icon={<IconPlayOutline16 />} onClick={work.run}>
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
    </div>
  )
}

/** Props of one run's result. */
interface ResultProps {
  answer: QueryAnswer
  t: DbCopy
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
