/**
 * Prove this package's dialect satisfies the contract without a PostgreSQL
 * server in front of it: the audit judges what the dialect declares and what
 * its pure functions produce.
 *
 *   pnpm install && npm run verify
 */
import assert from 'node:assert/strict'
import { auditDialect } from 'dsh-ds-db/src/dialect-audit.ts'
import { POSTGRES_DIALECT } from '../src/index.ts'

const problems = auditDialect(POSTGRES_DIALECT)
for (const problem of problems) console.error(`  - ${problem}`)
assert.deepEqual(problems, [], 'the PostgreSQL dialect passes the contract audit')
console.log('dialect audit: postgresql passes')

// The absent ability is the point: PostgreSQL has no built-in create statement,
// so `db_describe` omits the field instead of running something that fails.
assert.equal(POSTGRES_DIALECT.capabilities.has('createStatement'), false)
assert.equal(POSTGRES_DIALECT.capabilities.has('indexes'), true)
console.log(`capabilities: ${[...POSTGRES_DIALECT.capabilities].join(', ')}`)

// Its own bound, its own quoting, and one field of its own.
assert.match(POSTGRES_DIALECT.applyRowLimit('SELECT 1', 5), /LIMIT 6$/)
assert.equal(POSTGRES_DIALECT.quoteIdentifier('a"b'), '"a""b"')
assert.deepEqual(POSTGRES_DIALECT.configFields.map(field => field.key), ['sslMode'])
console.log(`row bound: ${POSTGRES_DIALECT.applyRowLimit('SELECT 1', 5)}`)
console.log('example dialect check passed')
