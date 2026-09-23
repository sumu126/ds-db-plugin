/**
 * Tool-call rows for this plugin's tools.
 *
 * Registering a key is a takeover rather than an addition: once `db_query` is
 * claimed, every state of that call — still running, failed, dispatched inside
 * another call, or carrying metadata that does not describe a card — renders
 * here. So each view has a real fallback branch of its own instead of assuming
 * the card is there.
 *
 * @module dsh-ds-db/src/client/DbToolRows
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the renderer's Context merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type { ToolCallBlock } from '@deepseek-ai/dsh-client-ui-chat/client'
import { dbCardModel, errorText, genericText, type ListCard, type TableCard } from './card-model.ts'
import { TOOL_NS, type ToolLocaleKey } from './tool-locales.ts'
import styles from './db-rows.css'

/** Props the renderer binds for one row this plugin owns. */
type DbRowProps = ToolCallViewProps & PropsLocale<typeof TOOL_NS>

/** The copy binder a row receives. */
type Translate = DbRowProps['t']

/**
 * The row drawn for every state the cards do not own: still running, failed,
 * dispatched inside another call, or metadata this version cannot read.
 */
function FallbackRow({ toolName, block }: { toolName: string, block: ToolCallBlock }) {
  const failure = errorText(block)
  const text = failure.length === 0 ? genericText(block) : failure
  return (
    <div className={styles.row}>
      <div className={styles.head}>
        <span className={styles.title}>{toolName}</span>
      </div>
      {text.length === 0 ? null : <pre className={styles.plain}>{text}</pre>}
    </div>
  )
}

/**
 * One result table: the header, the count the server reported, and the cells.
 *
 * The count is the server's, which can exceed the rows carried here — that is
 * what {@link TableCard.truncated} is about, and the two are shown together so a
 * reader never takes the drawn rows for the whole result.
 */
function TableView({ card, toolName, t }: { card: TableCard, toolName: string, t: Translate }) {
  const scope = card.database === undefined && card.table === undefined
    ? toolName
    : [card.database, card.table].filter(part => part !== undefined).join('.')
  return (
    <div className={styles.row}>
      <div className={styles.head}>
        <span className={styles.title}>{scope}</span>
        <span className={styles.count}>{t('rows', { count: String(card.rowCount) })}</span>
        {card.truncated ? <span className={styles.badge}>{t('cut')}</span> : null}
        {card.elapsedMs === undefined ? null : <span className={styles.count}>{`${String(card.elapsedMs)} ms`}</span>}
      </div>
      {card.columns.length === 0
        ? <p className={styles.note}>{t('noColumns')}</p>
        : (
          <div className={styles.scroll}>
            <table className={styles.table}>
              <thead>
                <tr>
                  {card.columns.map(column => <th key={column} className={styles.th}>{column}</th>)}
                </tr>
              </thead>
              <tbody>
                {card.rows.map((row, rowIndex) => (
                  // Rows have no identity of their own: the server answered an
                  // ordered set, so the position is what identifies one here.
                  <tr key={String(rowIndex)}>
                    {row.map((cell, cellIndex) => (
                      <td key={String(cellIndex)} className={styles.td}>{cell === null ? '' : String(cell)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </div>
  )
}

/** One listing: the count it was cut from, and one line per item. */
function ListView({ card, t }: { card: ListCard, t: Translate }) {
  return (
    <div className={styles.row}>
      <div className={styles.head}>
        <span className={styles.title}>{t(card.label)}</span>
        <span className={styles.count}>{t('rows', { count: String(card.total) })}</span>
        {card.truncated ? <span className={styles.badge}>{t('cut')}</span> : null}
        {card.database === undefined ? null : <span className={styles.count}>{card.database}</span>}
      </div>
      {card.items.length === 0
        ? <p className={styles.note}>{t('empty')}</p>
        : (
          <ul className={styles.list}>
            {card.items.map(item => (
              <li key={item.name} className={styles.item}>
                <span className={styles.itemName}>{item.name}</span>
                {item.detail === undefined || item.detail.length === 0
                  ? null
                  : <span className={styles.itemDetail}>{item.detail}</span>}
              </li>
            ))}
          </ul>
        )}
    </div>
  )
}

/** The row for one `db_query` or `db_sample` call. */
export function TableRow({ toolName, block, t }: DbRowProps) {
  const card = dbCardModel(block)
  if (card === null || card.kind !== 'table') return <FallbackRow toolName={toolName} block={block} />
  return <TableView card={card} toolName={toolName} t={t} />
}

/** The row for one `db_tables` or `db_databases` call. */
export function ListRow({ toolName, block, t }: DbRowProps) {
  const card = dbCardModel(block)
  if (card === null || card.kind !== 'list') return <FallbackRow toolName={toolName} block={block} />
  return <ListView card={card} t={t} />
}

/**
 * Register the four rows a card can describe.
 *
 * The keys are the wire tool names, so a tool this plugin does not register —
 * `db_describe`, `db_explain`, and anything a dialect package adds later — keeps
 * the shell's generic row.
 * @param ctx - browser plugin context.
 */
export function registerToolRows(ctx: ClientContext): void {
  ctx.slots.inject('tool.call.toolview', function* () {
    yield ctx.slots.register({ name: 'tool.call.toolview', key: 'db_query', locale: TOOL_NS }, TableRow)
    yield ctx.slots.register({ name: 'tool.call.toolview', key: 'db_sample', locale: TOOL_NS }, TableRow)
    yield ctx.slots.register({ name: 'tool.call.toolview', key: 'db_tables', locale: TOOL_NS }, ListRow)
    yield ctx.slots.register({ name: 'tool.call.toolview', key: 'db_databases', locale: TOOL_NS }, ListRow)
  })
}

/** Keys this plugin claims, for the copy check that keeps the four in step. */
export const TOOL_ROW_KEYS = ['db_query', 'db_sample', 'db_tables', 'db_databases'] as const

/** Re-exported so a check can name the keys without importing the view. */
export type { ToolLocaleKey }
