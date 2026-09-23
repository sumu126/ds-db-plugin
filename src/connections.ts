/**
 * Addressing one saved connection out of the section's list.
 *
 * A tool call may name the connection it wants; absent, it addresses the one
 * the page marks as in use. Nothing here reads a password: a profile carries a
 * credential reference's name, and the secret stays in the credential store.
 *
 * @module dsh-ds-db/src/connections
 */

import { UNSET_PORT, type ConnectionDefaults, type ConnectionProfile, type DatabaseSettings } from './contract.ts'

/** What one saved connection really reaches, once its dialect's defaults apply. */
export interface EffectiveConnection {
  /** Server host name or address. */
  host: string
  /** Server TCP port, always a real port. */
  port: number
  /** Account to connect as. */
  user: string
  /** Default database, empty when every call names one. */
  database: string
  /** Credential reference holding the account password. */
  passwordEnv: string
}

/**
 * The values a saved connection really uses.
 *
 * A field the profile leaves empty falls back to what its dialect declares,
 * exactly as a call resolves it — so a page and a tool never disagree about
 * where a connection points. `port` is always a real port here: `0` means "the
 * dialect's", and a dialect that declares none is a refusal at call time.
 * @param profile - the saved connection.
 * @param defaults - what the profile's dialect declared, if anything.
 * @returns the values to show and to connect with.
 */
export function effectiveConnection(
  profile: ConnectionProfile,
  defaults: ConnectionDefaults | undefined,
): EffectiveConnection {
  return {
    host: profile.host.trim().length > 0 ? profile.host.trim() : defaults?.host ?? '',
    port: profile.port !== UNSET_PORT ? profile.port : defaults?.port ?? UNSET_PORT,
    user: profile.user.trim().length > 0 ? profile.user.trim() : String(defaults?.user ?? ''),
    database: profile.database.trim().length > 0 ? profile.database : defaults?.database ?? '',
    passwordEnv: profile.passwordEnv.trim().length > 0
      ? profile.passwordEnv
      : defaults?.passwordEnv ?? profile.passwordEnv,
  }
}

/** The fields of a saved connection a model may see. */
export interface ConnectionSummary {
  /** Id the section addresses it by. */
  id: string
  /** Display name the page shows. */
  name: string
  /** Dialect key it is addressed through; empty means the deployment's first. */
  dialect: string
  /** Server host name or address. */
  host: string
  /** Server TCP port the connection really uses. */
  port: number
  /** Default database, empty when every call names one. */
  database: string
  /** Whether a call that names none addresses this one. */
  active: boolean
}

/**
 * The connection a call addresses when it names none: the one `activeId` names,
 * else the only saved one.
 * @param settings - the current settings section.
 * @returns the connection every unnamed call runs against.
 * @throws {Error} when nothing usable is saved, naming what is saved otherwise.
 */
export function activeConnection(settings: DatabaseSettings): ConnectionProfile {
  // An empty id means the first saved connection, the same way an empty dialect
  // means the first registered one: neither names anything, so both fall to the
  // only sensible referent instead of refusing.
  const wanted = settings.activeId.trim().length === 0
    ? settings.connections[0]
    : settings.connections.find(profile => profile.id === settings.activeId)
  if (wanted !== undefined) return wanted
  const only = settings.connections.length === 1 ? settings.connections[0] : undefined
  if (only !== undefined) return only
  const names = settings.connections.map(profile => profile.name).join(', ')
  throw new Error(settings.connections.length === 0
    ? 'no database connection is saved; add one on the database settings page'
    : `connection "${settings.activeId}" is not saved; saved connections: ${names}`)
}

/**
 * The connection one call addresses.
 *
 * A name is what a model reads off the list, so it resolves by name first; the
 * id is what the section guarantees unique, so it resolves second and is what
 * an ambiguous name points at.
 * @param settings - the current settings section.
 * @param requested - the name or id the call named, if any.
 * @returns the connection to run against.
 * @throws {Error} when the name is unknown, or when two connections share it.
 */
export function resolveProfile(settings: DatabaseSettings, requested: string | undefined): ConnectionProfile {
  const wanted = requested?.trim() ?? ''
  if (wanted.length === 0) return activeConnection(settings)
  const named = settings.connections.filter(profile => profile.name === wanted)
  const first = named[0]
  if (named.length === 1 && first !== undefined) return first
  if (named.length > 1) {
    throw new Error(`two saved connections are named "${wanted}"; address one by id: ${named.map(profile => profile.id).join(', ')}`)
  }
  const byId = settings.connections.find(profile => profile.id === wanted)
  if (byId !== undefined) return byId
  const names = settings.connections.map(profile => profile.name).join(', ')
  throw new Error(settings.connections.length === 0
    ? 'no database connection is saved; add one on the database settings page'
    : `no saved connection is named "${wanted}"; saved connections: ${names}`)
}

/**
 * Every saved connection as a model may see it, reporting where each one
 * really reaches rather than the raw document.
 * @param settings - the current settings section.
 * @param defaultsFor - what each connection's dialect declared, read per profile.
 * @returns one summary per saved connection, in document order.
 */
export function connectionSummaries(
  settings: DatabaseSettings,
  defaultsFor: (profile: ConnectionProfile) => ConnectionDefaults | undefined,
): ConnectionSummary[] {
  return settings.connections.map((profile) => {
    const effective = effectiveConnection(profile, defaultsFor(profile))
    return {
      id: profile.id,
      name: profile.name,
      dialect: profile.dialect,
      host: effective.host,
      port: effective.port,
      database: effective.database,
      active: profile.id === settings.activeId,
    }
  })
}
