/**
 * The dialect-author API, as a built entry point.
 *
 * A dialect package is installed separately from this one and runs under the
 * deployed `dsh`, which loads built JavaScript with no TypeScript loader: an
 * import of `dsh-ds-db/src/*.ts` cannot resolve there, because Node refuses to
 * strip types under `node_modules`. This entry is the supported surface — it is
 * built like the rest of the plugin, exported as `./dialect-api`, and holds the
 * one implementation of the read-only guard, the value readers, and the
 * contract audit that every dialect shares.
 *
 * The exports are explicit rather than a re-export of whole modules, so the
 * surface a dialect may depend on is reviewable here.
 *
 * @module dsh-ds-db/dialect-api
 */

export { DIALECT_CAPABILITIES, type DialectCapability } from './dialect.ts'
export type { ConnectionDefaults } from './contract.ts'
export type {
  DatabaseConnection,
  DatabaseDialect,
  DialectColumnRow,
  DialectDatabaseRow,
  DialectIndexRow,
  DialectQuery,
  DialectSession,
  DialectStatement,
  DialectTableRow,
} from './dialect.ts'

export {
  assertReadOnlyStatement,
  familiesPhrase,
  ROW_PRODUCING_LEAD,
  scanStatement,
  SHARED_FORBIDDEN,
  type ForbiddenConstruct,
  type LineComment,
  type QuoteRegion,
  type ReadOnlyRules,
  type ScannedStatement,
  type SqlLexical,
} from './sql-guard.ts'

export {
  cellFlag,
  cellInteger,
  cellIsZero,
  cellOptionalText,
  cellText,
  toJsonRow,
  toJsonValue,
  type DbJson,
  type DbRow,
  type DbScalar,
} from './value.ts'

export { auditDialect } from './dialect-audit.ts'
