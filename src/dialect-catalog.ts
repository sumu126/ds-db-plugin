/**
 * Database types a deployment may install.
 *
 * A type appears in the hint list when a package could register it but none is
 * registered in this deployment. It is how the settings page says "install this
 * package" instead of silently offering nothing; the list never affects
 * resolution — only a registered dialect does.
 *
 * Every entry, including MySQL, is an ordinary dialect package: the core plugin
 * ships no dialect of its own and names no default database type, so this list
 * is a hint for the page, not a statement of what the plugin can reach.
 *
 * {@link SHIPPED_DIALECT_PACKAGES} is only the list a deployment that configures
 * none gets: a dialect published outside this repository is one this module
 * cannot know about, so the `knownDialectPackages` configuration field replaces
 * it entirely.
 *
 * @module dsh-ds-db/src/dialect-catalog
 */

import type { KnownDialectPackage } from './contract.ts'

/** Hint list a deployment that configures no `knownDialectPackages` gets. */
export const SHIPPED_DIALECT_PACKAGES: readonly KnownDialectPackage[] = [
  { name: 'mysql', label: 'MySQL', package: 'dsh-dialect-mysql' },
  { name: 'postgres', label: 'PostgreSQL', package: 'dsh-dialect-postgres' },
  { name: 'oracle', label: 'Oracle', package: 'dsh-dialect-oracle' },
]
