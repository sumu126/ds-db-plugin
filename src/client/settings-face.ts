/**
 * What this plugin needs from the shell's settings transport.
 *
 * The transport changed shape across DSH generations:
 *
 * - **0.1.6 and earlier** — `ctx.settingsScope.bind({ namespace })`.
 * - **0.1.7 and later** — that service was removed; `ctx.configForms.get(entryId)`
 *   is the form for one plugin entry's own `Config`. The desktop app ships this
 *   generation.
 *
 * The two forms agree on everything this plugin reads and writes, so the
 * controllers depend on this shape rather than on either class. The differences
 * are only in how a form is obtained, plus two details the narrower shape
 * tolerates: the newer snapshot has no `mode`, and its writes resolve to a
 * boolean rather than nothing.
 *
 * @module dsh-ds-db/src/client/settings-face
 */

import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'

/** One namespace's sync state, as both generations publish it. */
export interface SettingsFaceSnapshot<T> {
  /** `ready` once the Host has answered; `unavailable` when it serves no such namespace. */
  status: 'loading' | 'ready' | 'unavailable'
  /** Last accepted section; undefined before the first answer. */
  value: T | undefined
  /** Composition layer the Host resolved the value over. */
  base: unknown
  /** Raw user layer as stored, when one exists. */
  user: unknown
  /** Revision fencing the next write. */
  revision: number | undefined
  /** Whether the Host document accepts writes. */
  writable: boolean
  /** `host` syncs with the document; `memory` keeps it in this browser (0.1.6 only). */
  mode?: 'host' | 'memory'
}

/** One namespace's values and ordered writes. */
export interface SettingsFace<T> {
  /** @returns the current sync snapshot (stable reference until the next change). */
  getSnapshot(): SettingsFaceSnapshot<T>
  /**
   * Observe snapshot replacements.
   * @param listener - invoked after each snapshot change.
   * @returns the disposer removing this listener.
   */
  subscribe(listener: () => void): () => void
  /**
   * Queue one atomic namespace mutation.
   * @param ops - ordered field operations.
   * @param expectedRevision - optional fixed revision to fence the write.
   * @returns its settlement; the newer generation answers acceptance, the older one answers nothing.
   */
  mutate(ops: readonly SettingsPathOpView[], expectedRevision?: number): Promise<unknown>
}
