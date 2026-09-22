/**
 * Contract audit for this dialect. Run it before publishing: it needs no
 * database server, and it is the same check every other dialect package runs.
 *
 *   npm run verify
 */
import assert from 'node:assert/strict'
import { auditDialect } from 'dsh-ds-db/src/dialect-audit.ts'
import { TEMPLATE_DIALECT } from '../src/index.ts'

const problems = auditDialect(TEMPLATE_DIALECT)
for (const problem of problems) console.error(`  - ${problem}`)
assert.deepEqual(problems, [], 'the dialect passes the contract audit')
console.log(`dialect audit: ${TEMPLATE_DIALECT.name} passes`)

assert.match(TEMPLATE_DIALECT.applyRowLimit('SELECT 1', 5), /LIMIT 6$/)
assert.ok(TEMPLATE_DIALECT.quoteIdentifier('a"b').length > 'a"b'.length)
console.log(`capabilities: ${[...TEMPLATE_DIALECT.capabilities].join(', ')}`)
console.log('template check passed')
