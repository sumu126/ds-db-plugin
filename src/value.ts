/**
 * Lossless JSON projection for driver cell values, plus the loose cell readers
 * a dialect uses while normalizing its own metadata rows.
 *
 * A tool result must be reconstructable from JSON, so `Date`, `bigint`, and
 * `Buffer` cells are projected here before any dialect projection or tool
 * mapping sees them.
 *
 * @module dsh-ds-db/src/value
 */

/** Lossless JSON value, the only shape a tool result may carry. */
export type DbJson = string | number | boolean | null | DbJson[] | { [key: string]: DbJson }

/** One result row keyed by column name, already projected to lossless JSON. */
export type DbRow = Record<string, DbJson>

/** A value a dialect may bind into one of its own prepared statements. */
export type DbScalar = string | number

/** Bytes of a binary cell kept in a result before the preview truncates. */
const BINARY_PREVIEW_BYTES = 256

/**
 * Project one driver value onto lossless JSON.
 *
 * Drivers return `Date`, `Buffer`, and `bigint` cells, none of which is
 * lossless JSON; a tool result carrying one would be rejected at the tool
 * boundary, so every cell is projected here instead.
 * @param value - one cell value from a driver.
 * @returns the JSON value standing in for it.
 */
export function toJsonValue(value: unknown): DbJson {
  if (value === null || value === undefined) return null
  switch (typeof value) {
    case 'string':
    case 'boolean': return value
    case 'number': return Number.isFinite(value) ? value : String(value)
    case 'bigint': return value.toString()
    default: break
  }
  if (value instanceof Date) return value.toISOString()
  if (value instanceof Uint8Array) return binaryPreview(value)
  if (Array.isArray(value)) return value.map(entry => toJsonValue(entry))
  const projected: Record<string, DbJson> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    projected[key] = toJsonValue(entry)
  }
  return projected
}

/** Render a binary cell as a bounded hexadecimal preview. */
function binaryPreview(bytes: Uint8Array): string {
  const head = Buffer.from(bytes.subarray(0, BINARY_PREVIEW_BYTES)).toString('hex')
  return bytes.byteLength <= BINARY_PREVIEW_BYTES
    ? `0x${head}`
    : `0x${head}… (${String(bytes.byteLength)} bytes)`
}

/**
 * Project one driver row onto a JSON-safe row.
 * @param row - one raw row from a driver.
 * @returns the row with every cell projected.
 */
export function toJsonRow(row: unknown): DbRow {
  return toJsonValue(row) as DbRow
}

/**
 * Render a cell as text, with absent values as the empty string.
 * @param value - one projected cell.
 * @returns the cell's text.
 */
export function cellText(value: DbJson | undefined): string {
  if (value === null || value === undefined) return ''
  return typeof value === 'string' ? value : JSON.stringify(value)
}

/**
 * Render a cell as a whole number, or null when it does not hold one. A driver
 * may hand a numeric column back as a string, so both spellings count.
 * @param value - one projected cell.
 * @returns the whole number, or null.
 */
export function cellInteger(value: DbJson | undefined): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return Number(value)
  return null
}

/**
 * The text of a cell the schema declares nullable: absent and empty read as
 * nothing rather than as an empty string.
 * @param value - one projected cell.
 * @returns the cell's text, or null when it carries none.
 */
export function cellOptionalText(value: DbJson | undefined): string | null {
  const text = cellText(value)
  return text.length === 0 ? null : text
}

/**
 * Whether a cell spells an affirmative flag, in any spelling the supported
 * servers use: a real boolean, a nonzero number, `YES`, `TRUE`, or `1`.
 * @param value - one projected cell.
 * @returns true when the cell is affirmative.
 */
export function cellFlag(value: DbJson | undefined): boolean {
  if (value === true) return true
  if (typeof value === 'number') return value !== 0
  if (typeof value !== 'string') return false
  const spelling = value.trim().toUpperCase()
  return spelling === 'YES' || spelling === 'TRUE' || spelling === '1'
}

/**
 * Whether a numeric cell is zero — a flag a dialect spells as an inverted
 * number, such as MySQL's `NON_UNIQUE = 0` for a unique index.
 * @param value - one projected cell.
 * @returns true when the cell holds the number zero.
 */
export function cellIsZero(value: DbJson | undefined): boolean {
  return cellInteger(value) === 0
}