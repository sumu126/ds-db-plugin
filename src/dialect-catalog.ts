/**
 * Database types a deployment may install, and the one it addresses by default.
 *
 * A type appears in `KNOWN_DIALECT_PACKAGES` when a package could register it
 * but none is registered in this deployment. It is how the settings page says
 * "install this package" instead of silently offering nothing; the list never
 * affects resolution — only a registered dialect does.
 *
 * Every entry, including MySQL, is an ordinary dialect package: the core plugin
 * ships no dialect of its own.
 *
 * @module dsh-ds-db/src/dialect-catalog
 */

import type { KnownDialectPackage } from './contract.ts'

/** Dialect a connection names when the composition configures none. */
export const DEFAULT_DIALECT_NAME = 'mysql'

/** Known dialect packages a deployment may install. */
export const KNOWN_DIALECT_PACKAGES: readonly KnownDialectPackage[] = [
  { name: 'mysql', label: 'MySQL', package: 'dsh-dialect-mysql' },
  { name: 'postgres', label: 'PostgreSQL', package: 'dsh-dialect-postgres' },
  { name: 'oracle', label: 'Oracle', package: 'dsh-dialect-oracle' },
]
