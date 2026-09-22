/**
 * Contract audit for a dialect: the checks a dialect author runs before
 * publishing, so a malformed declaration fails on their machine rather than in
 * a deployment.
 *
 * The audit touches no server and no driver. It judges what a dialect declares
 * and what its own pure functions produce, which is everything a package can
 * get wrong without a database in front of it.
 *
 * @module dsh-ds-db/src/dialect-audit
 */

import { DIALECT_CAPABILITIES, type DatabaseDialect } from './dialect.ts'
import { assertReadOnlyStatement } from './sql-guard.ts'
import type { DbRow } from './value.ts'

/** One statement and whether the dialect's rules must admit it. */
interface RuleCase {
  /** Statement text. */
  sql: string
  /** Whether the guard must accept it. */
  allowed: boolean
  /** Why this case is in the set, for the failure a dialect author reads. */
  because: string
}

/**
 * Statements every dialect must judge the same way: a write is refused, a read
 * is admitted, and neither a literal nor a comment can smuggle a second
 * statement past the mask.
 */
const RULE_CASES: readonly RuleCase[] = [
  { sql: 'SELECT 1', allowed: true, because: 'a plain read is admitted' },
  { sql: 'DROP TABLE users', allowed: false, because: 'a write is refused' },
  { sql: 'DELETE FROM users WHERE id = 1', allowed: false, because: 'a delete is refused' },
  { sql: 'SELECT 1; DROP TABLE users', allowed: false, because: 'a second statement after a semicolon is refused' },
  { sql: "SELECT ';' AS x", allowed: true, because: 'a semicolon inside a literal is masked out' },
  { sql: 'SELECT 1 /* ; DROP TABLE users */', allowed: true, because: 'a comment is masked out' },
  { sql: 'SELECT * FROM users FOR UPDATE', allowed: false, because: 'a row lock is refused on every dialect' },
]

/** Whether one value is a number, for a field default's own type. */
function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * Audit one dialect against the contract.
 * @param dialect - the dialect to audit.
 * @returns one message per problem found; empty means the dialect passes.
 */
export function auditDialect(dialect: DatabaseDialect): string[] {
  const problems: string[] = []

  if (dialect.name.trim().length === 0) problems.push('name is empty')
  if (dialect.label.trim().length === 0) problems.push('label is empty')
  if (!/^[a-z][a-z0-9-]*$/.test(dialect.name)) {
    problems.push(`name "${dialect.name}" is not a lowercase registry key`)
  }

  for (const capability of dialect.capabilities) {
    if (!DIALECT_CAPABILITIES.includes(capability)) {
      problems.push(`declares unknown capability "${String(capability)}"`)
    }
  }
  // An ability with nothing behind it would make the tool call fail at runtime,
  // so the two must agree before the dialect is published.
  if (dialect.capabilities.has('sample') && dialect.sample === undefined) {
    problems.push('declares "sample" but implements no sample()')
  }
  if (dialect.capabilities.has('explain') && dialect.explain === undefined) {
    problems.push('declares "explain" but implements no explain()')
  }

  for (const field of dialect.configFields) {
    if (!/^[a-z][A-Za-z0-9]*$/.test(field.key)) problems.push(`config field key "${field.key}" is unusable`)
    if (field.kind === 'number' && !isNumber(field.default)) {
      problems.push(`config field "${field.key}" is numeric but its default is not a number`)
    }
    if (field.kind !== 'number' && isNumber(field.default)) {
      problems.push(`config field "${field.key}" is not numeric but its default is a number`)
    }
  }

  for (const testCase of RULE_CASES) {
    const refused = ((): boolean => {
      try {
        assertReadOnlyStatement(testCase.sql, dialect.rules)
        return false
      } catch {
        return true
      }
    })()
    if (refused === testCase.allowed) {
      problems.push(`rules ${testCase.allowed ? 'refused' : 'admitted'} "${testCase.sql}", but ${testCase.because}`)
    }
  }

  const bounded = dialect.applyRowLimit('SELECT 1', 5)
  const boundWord = dialect.rowBoundHint.trim().split(/\s+/)[0]?.toUpperCase() ?? ''
  if (boundWord.length === 0) problems.push('rowBoundHint is empty')
  else if (!bounded.toUpperCase().includes(boundWord)) {
    problems.push(`applyRowLimit did not bound the statement with ${dialect.rowBoundHint}`)
  }

  const quoted = dialect.quoteIdentifier('a`b')
  if (quoted === 'a`b' || quoted.length <= 'a`b'.length) {
    problems.push('quoteIdentifier left a quote character inside the identifier')
  }

  // The projections are pure: a dialect that cannot project its own rows would
  // only fail later, against a live server, where the cause is far less clear.
  const projections: [string, (row: DbRow) => unknown][] = [
    ['databases', row => dialect.databases().project(row)],
    ['tables', row => dialect.tables('db').project(row)],
    ['columns', row => dialect.columns('db', 't').project(row)],
    ['indexes', row => dialect.indexes('db', 't').project(row)],
    ['version', row => dialect.version().project(row)],
  ]
  for (const [name, project] of projections) {
    try {
      project({})
    } catch (error: unknown) {
      problems.push(`${name}() projection threw on an empty row: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return problems
}
