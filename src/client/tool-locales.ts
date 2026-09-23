/**
 * Copy for the tool-call rows this plugin owns, in both supported languages.
 *
 * A namespace of its own rather than the settings page's: these strings render
 * inside a turn, and a tool row is registered by wire tool name, so its copy
 * travels with the toolview rather than with a settings section.
 *
 * @module dsh-ds-db/src/client/tool-locales
 */

/** Chinese dictionary; also the key source for the namespace. */
export const zh = {
  rows: '{count} 行',
  cut: '已截断',
  noColumns: '该语句没有返回列。',
  result: '查询结果',
  databases: '数据库',
  tables: '表',
  empty: '没有结果。',
}

/** English dictionary; every key mirrors {@link zh}. */
export const en: typeof zh = {
  rows: '{count} rows',
  cut: 'cut',
  noColumns: 'The statement returned no columns.',
  result: 'Query result',
  databases: 'Databases',
  tables: 'Tables',
  empty: 'No results.',
}

/** Keys of this namespace's dictionary. */
export type ToolLocaleKey = keyof typeof zh

/** Namespace the tool rows read their copy through. */
export const TOOL_NS = 'tool.db'
