/**
 * Read-only statement guard: the plugin's first line of defence behind the
 * deployment's own read-only database account.
 *
 * The guard is dialect-neutral in structure and dialect-fed in rules: how the
 * dialect spells literals, quoted identifiers, and comments comes from its
 * lexical rules, and which syntax is refused although it looks read-only comes
 * from its forbidden list. The guard itself masks every literal and comment,
 * refuses anything but one row-returning statement, and leaves row bounding to
 * the dialect, because the syntax for that differs (`LIMIT` here, `FETCH FIRST`
 * there).
 *
 * @module dsh-ds-db/src/sql-guard
 */

/** One quoted region: a string literal or a quoted identifier. */
export interface QuoteRegion {
  /** The character that opens and closes this region. */
  readonly quote: string
  /** Whether a backslash escapes the next character inside it. */
  readonly backslashEscapes: boolean
}

/** One line-comment opener. */
export interface LineComment {
  /** The marker text that opens this comment. */
  readonly marker: string
  /**
   * Whether whitespace (or end of input) must follow the marker. MySQL requires
   * that after `--`; standard SQL does not, so a dialect sets this per marker.
   */
  readonly requiresWhitespace: boolean
}

/** How one dialect spells the lexemes the guard has to mask before judging. */
export interface SqlLexical {
  /** Quoted-region openers, in no particular order. */
  readonly quotes: readonly QuoteRegion[]
  /** Line-comment openers. */
  readonly lineComments: readonly LineComment[]
}

/** One construct that looks read-only and is not. */
export interface ForbiddenConstruct {
  /** Pattern matched against the masked statement. */
  readonly pattern: RegExp
  /** Why it is refused, as the refusal tells the model. */
  readonly reason: string
}

/** What one dialect's statements are judged by. */
export interface ReadOnlyRules {
  /** The dialect's lexemes. */
  readonly lexical: SqlLexical
  /** Statement leads admitted, as one anchored alternation over the masked statement. */
  readonly lead: RegExp
  /** Statement families the refusal names, in the order the message lists them. */
  readonly families: readonly string[]
  /** Constructs refused although they look read-only. */
  readonly forbidden: readonly ForbiddenConstruct[]
}

/** Row-producing statements whose row count a row bound can limit. */
export const ROW_PRODUCING_LEAD = /^(?:select|with|table|values)\b/i

/**
 * Constructs refused on every supported dialect: they take row locks while
 * reading, which no read-only account should be asked to do.
 */
export const SHARED_FORBIDDEN: readonly ForbiddenConstruct[] = [
  { pattern: /\bfor\s+update\b/i, reason: 'takes row locks' },
  { pattern: /\block\s+in\s+share\s+mode\b/i, reason: 'takes row locks' },
]

/** A statement split into its executable text and a literal-free copy for scanning. */
export interface ScannedStatement {
  /** The statement as written, without its trailing terminator. */
  readonly statement: string
  /** The same statement with every literal emptied and every comment removed. */
  readonly code: string
}

/**
 * Whether the character after a line-comment marker still makes it a comment.
 * @param character - the character following the marker.
 * @returns true when the marker opens a comment here.
 */
function isWhitespaceOrEnd(character: string | undefined): boolean {
  return character === undefined || character === '' || /\s/.test(character)
}

/**
 * Split one statement into its executable text and a literal-free copy.
 *
 * Only the copy is judged: a semicolon or a forbidden word inside a string
 * literal or a comment must not decide whether a statement is refused.
 * @param sql - the statement exactly as the model wrote it.
 * @param lexical - how this dialect spells quotes and comments.
 * @returns the executable statement and its masked copy.
 */
export function scanStatement(sql: string, lexical: SqlLexical): ScannedStatement {
  let statement = ''
  let code = ''
  let quote: QuoteRegion | undefined
  let inLineComment = false
  let inBlockComment = false
  for (let index = 0; index < sql.length; index++) {
    const character = sql[index]
    /* v8 ignore next -- index is bounded by sql.length. */
    if (character === undefined) break
    if (inBlockComment) {
      statement += character
      if (character === '*' && sql[index + 1] === '/') {
        statement += '/'
        index++
        inBlockComment = false
        code += ' '
      }
      continue
    }
    if (inLineComment) {
      statement += character
      if (character === '\n') {
        inLineComment = false
        code += ' '
      }
      continue
    }
    if (quote !== undefined) {
      statement += character
      if (quote.backslashEscapes && character === '\\') {
        const escaped = sql[index + 1]
        if (escaped !== undefined) {
          statement += escaped
          index++
        }
        continue
      }
      if (character === quote.quote) {
        quote = undefined
        code += character
      }
      continue
    }
    const opener = lexical.quotes.find(region => region.quote === character)
    if (opener !== undefined) {
      quote = opener
      statement += character
      code += character
      continue
    }
    const comment = lexical.lineComments.find(entry => sql.startsWith(entry.marker, index)
      && (!entry.requiresWhitespace || isWhitespaceOrEnd(sql[index + entry.marker.length])))
    if (comment !== undefined) {
      statement += comment.marker
      index += comment.marker.length - 1
      inLineComment = true
      continue
    }
    if (character === '/' && sql[index + 1] === '*') {
      statement += '/*'
      index++
      inBlockComment = true
      continue
    }
    statement += character
    code += character
  }
  return { statement: statement.trim(), code: code.trim() }
}

/** A statement terminator, with any comments trailing it, at the very end of the text. */
const TRAILING_TERMINATOR = /;\s*(?:(?:--[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/)\s*)*$/u

/** Remove the terminator a caller typed, so the executed text carries exactly one statement. */
function withoutTerminator(sql: string): string {
  return sql.replace(TRAILING_TERMINATOR, '').trim()
}

/**
 * Name the admitted statement families the way a sentence lists them.
 * @param families - the dialect's families, in listing order.
 * @param conjunction - the word before the last family: `or` where the text says what is admitted, `and` where it enumerates them.
 * @returns the families joined for a sentence.
 */
export function familiesPhrase(families: readonly string[], conjunction: 'or' | 'and' = 'or'): string {
  const last = families[families.length - 1]
  if (last === undefined) return ''
  return families.length === 1 ? last : `${families.slice(0, -1).join(', ')}, ${conjunction} ${last}`
}

/**
 * Judge one statement for read-only execution, or explain the refusal.
 * @param sql - the statement the model asked to run.
 * @param rules - the dialect's lexical rules, admitted leads, and forbidden constructs.
 * @returns the executable statement, with its terminator removed.
 * @throws {Error} when the statement is empty, compound, outside the admitted families, or a forbidden read-only-looking construct.
 */
export function assertReadOnlyStatement(sql: string, rules: ReadOnlyRules): string {
  const scanned = scanStatement(sql, rules.lexical)
  const body = scanned.code.replace(/;+$/, '').trim()
  const executable = withoutTerminator(scanned.statement)
  if (body.length === 0) throw new Error('sql must be one non-empty statement')
  if (body.includes(';')) {
    throw new Error('sql must be exactly one statement: multiple statements are refused because this plugin is read-only')
  }
  if (!rules.lead.test(body)) {
    throw new Error(`sql must start with ${familiesPhrase(rules.families)}; anything else is refused because this plugin is read-only`)
  }
  for (const { pattern, reason } of rules.forbidden) {
    if (pattern.test(body)) throw new Error(`sql contains a construct this read-only plugin refuses: "${pattern.source}" ${reason}`)
  }
  return executable
}