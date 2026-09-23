/**
 * Card models derived from the metadata the Host persists for a tool call.
 *
 * Pure by construction, and it imports no React: a client replays sessions that
 * older versions of this plugin recorded, so every field below is re-checked
 * rather than trusted, and a Node check can import this module directly (see
 * `scripts/verify-cards.mjs`).
 *
 * @module dsh-ds-db/src/client/card-model
 */

import type { ToolCallBlock } from '@deepseek-ai/dsh-client-ui-chat/client'

/** One cell a card draws: the Host flattens a row to scalars before persisting it. */
export type CardCell = string | number | boolean | null

/**
 * What a card's header shows.
 *
 * A card that knows what it read says `database.table` — a name no dictionary can
 * translate. One that does not falls back to copy, so a header never shows a raw
 * wire tool name to the person reading the turn.
 */
export interface CardTitle {
  /** The name the card is about, when it has one; the header prefers it. */
  scope: string | undefined
  /** Dictionary key of the copy used when {@link scope} is absent. */
  key: 'result' | 'tables' | 'databases'
}

/** A result table, as `db_query` and `db_sample` persist one. */
export interface TableCard {
  /** Which shape this is. */
  kind: 'table'
  /** What the header shows. */
  title: CardTitle
  /** Database the rows came from, when the tool named one. */
  database?: string
  /** Table the rows came from, when the tool named one. */
  table?: string
  /** Column names, in the order the server answered them. */
  columns: string[]
  /** Cells, one array per row, each as long as `columns`. */
  rows: CardCell[][]
  /** Rows the server answered with, which may exceed the rows carried here. */
  rowCount: number
  /** Whether what the card shows is not all of it. */
  truncated: boolean
  /**
   * The call's whole text, kept when the card was cut.
   *
   * The card trims rows and cells to keep a turn readable; the result the model
   * read is still the text it was given, so a reader can open that instead of
   * rerunning the query. Absent when nothing was cut.
   */
  recovery?: string
  /** How long the server took, when the tool measured it. */
  elapsedMs?: number
}

/** A listing, as `db_tables` and `db_databases` persist one. */
export interface ListCard {
  /** Which shape this is. */
  kind: 'list'
  /** What the header shows: the copy naming the kind of thing listed. */
  title: CardTitle
  /** What the items are. */
  label: 'databases' | 'tables'
  /** Database the items came from, when the tool named one. */
  database?: string
  /** The items to draw. */
  items: { name: string, detail?: string }[]
  /** Items the tool answered with, which may exceed the items carried here. */
  total: number
  /** Whether what the card shows is not all of it. */
  truncated: boolean
  /** The call's whole text, kept when the card was cut; see {@link TableCard.recovery}. */
  recovery?: string
}

/** What one settled call draws: a card, or nothing when the generic row owns it. */
export type DbCard = TableCard | ListCard

/**
 * The wire tool names this plugin draws cards for.
 *
 * It lives here rather than beside the views so a Node check can read it: the view
 * module imports CSS, which a plain Node run cannot load.
 */
export const TOOL_ROW_KEYS = ['db_query', 'db_sample', 'db_tables', 'db_databases'] as const

/** Whether one value is the kind of object a field can be read off. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A non-negative integer, as every count in a card has to be. */
function countOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null
}

/** A string field, or nothing when the Host of that version did not send one. */
function textOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** Column names, or nothing when the field is not a list of names. */
function columnsOf(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  return value.every(column => typeof column === 'string') ? [...value] as string[] : null
}

/** Rows of scalar cells, or nothing when any cell is not one. */
function cellsOf(value: unknown): CardCell[][] | null {
  if (!Array.isArray(value)) return null
  const rows: CardCell[][] = []
  for (const row of value) {
    if (!Array.isArray(row)) return null
    const cells: CardCell[] = []
    for (const cell of row) {
      if (cell !== null && typeof cell !== 'string' && typeof cell !== 'number' && typeof cell !== 'boolean') {
        return null
      }
      cells.push(cell)
    }
    rows.push(cells)
  }
  return rows
}

/** The table a `card: 'table'` metadata object describes, or nothing. */
function tableCard(
  meta: Record<string, unknown>,
  truncated: boolean,
  recovery: string | undefined,
): TableCard | null {
  const columns = columnsOf(meta.columns)
  if (columns === null) return null
  const rows = cellsOf(meta.rows)
  if (rows === null) return null
  // A row shorter or longer than the header is a card that would draw ragged
  // cells, so it is not one this view can render.
  if (!rows.every(row => row.length === columns.length)) return null
  const rowCount = countOf(meta.rowCount)
  if (rowCount === null) return null
  const database = textOf(meta.database)
  const table = textOf(meta.table)
  const elapsedMs = countOf(meta.elapsedMs)
  // Named when the tool named it, so a sample's header reads `app.events` instead
  // of the same copy a bare query gets.
  const named = [database, table].filter((part): part is string => part !== undefined && part.length > 0)
  return {
    kind: 'table',
    title: { scope: named.length === 0 ? undefined : named.join('.'), key: 'result' },
    columns,
    rows,
    rowCount,
    truncated,
    ...recovery === undefined ? {} : { recovery },
    ...database === undefined ? {} : { database },
    ...table === undefined ? {} : { table },
    ...elapsedMs === null ? {} : { elapsedMs },
  }
}

/** The listing a `card: 'list'` metadata object describes, or nothing. */
function listCard(
  meta: Record<string, unknown>,
  truncated: boolean,
  recovery: string | undefined,
): ListCard | null {
  if (meta.label !== 'databases' && meta.label !== 'tables') return null
  const total = countOf(meta.total)
  if (total === null) return null
  if (!Array.isArray(meta.items)) return null
  const items: { name: string, detail?: string }[] = []
  for (const item of meta.items) {
    if (!isRecord(item)) return null
    if (typeof item.name !== 'string') return null
    const detail = item.detail
    if (detail !== undefined && typeof detail !== 'string') return null
    items.push(detail === undefined ? { name: item.name } : { name: item.name, detail })
  }
  const database = textOf(meta.database)
  return {
    kind: 'list',
    title: { scope: undefined, key: meta.label },
    label: meta.label,
    items,
    total,
    truncated,
    ...recovery === undefined ? {} : { recovery },
    ...database === undefined ? {} : { database },
  }
}

/**
 * The card one settled call draws.
 * @param block - the frozen running-or-settled call node.
 * @returns the card, or nothing for every case the generic row owns: a call still
 * running, a failed one, a nested dispatch (which carries no metadata), metadata
 * that is not an object, and a discriminator this version does not know.
 */
export function dbCardModel(block: ToolCallBlock): DbCard | null {
  if (block.parentCallId !== undefined) return null
  if (!('kind' in block)) return null
  if (block.isError) return null
  if (!isRecord(block.meta)) return null
  const truncated = block.meta.truncated
  if (typeof truncated !== 'boolean') return null
  // A card that was cut keeps the call's own text beside it: that text is the
  // whole rendering the model read, so opening it beats rerunning the query.
  const recovery = truncated ? genericText(block) : undefined
  if (block.meta.card === 'table') return tableCard(block.meta, truncated, recovery)
  if (block.meta.card === 'list') return listCard(block.meta, truncated, recovery)
  return null
}

/**
 * The text one call's result carries, for the generic row.
 * @param block - the frozen running-or-settled call node.
 * @returns the call's text blocks joined, empty when it carries none.
 */
export function genericText(block: ToolCallBlock): string {
  if (!('kind' in block)) return ''
  const parts: string[] = []
  for (const part of block.content) {
    const text = (part as { text?: unknown }).text
    if (part.type === 'text' && typeof text === 'string') parts.push(text)
  }
  return parts.join('\n')
}

/**
 * One call's own text: its arguments while it still runs, its result text once
 * settled.
 *
 * A running call has no result to show, and its arguments are what there is —
 * the shell's own row shows them for every tool, so claiming this tool's key must
 * not be the thing that hides the statement being run.
 * @param block - the frozen running-or-settled call node.
 * @returns the text a generic row shows for this call.
 */
export function callText(block: ToolCallBlock): string {
  return 'kind' in block ? genericText(block) : block.argsRaw
}

/**
 * Why one call failed, for the generic row.
 * @param block - the frozen running-or-settled call node.
 * @returns the recorded reason or code, empty when the call did not fail.
 */
export function errorText(block: ToolCallBlock): string {
  if (!('kind' in block) || !block.isError) return ''
  return block.error?.reason ?? block.error?.code ?? ''
}
