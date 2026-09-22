/**
 * Database types this plugin knows of but does not ship.
 *
 * A type appears here when someone could publish a dialect package for it but
 * no package is installed in this deployment. It is how the settings page says
 * "install this package" instead of silently offering nothing; the list never
 * affects resolution — only a registered dialect does.
 *
 * @module dsh-ds-db/src/dialect-catalog
 */

import type { KnownDialectPackage } from './contract.ts'

/** Known dialect packages a deployment may install. */
export const KNOWN_DIALECT_PACKAGES: readonly KnownDialectPackage[] = [
  { name: 'postgres', label: 'PostgreSQL', package: 'dsh-dialect-postgres' },
  { name: 'oracle', label: 'Oracle', package: 'dsh-dialect-oracle' },
]
