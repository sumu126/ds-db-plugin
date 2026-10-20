/**
 * The shell's icons, addressed across the two spellings of the same set.
 *
 * 0.1.x names an icon after its pixel size (`IconPlusOutline16`); 0.2.x renamed
 * the whole set after its weight (`IconPlusOutlineRegular`). The glyphs are the
 * same; which names exist is decided by the shell a deployment happens to run.
 *
 * Why this module exists at all — a client bundle resolves the shell's
 * primitives **at runtime**, so a name the running shell does not serve is
 * `undefined` rather than a load error. Rendering `<undefined />` is React error
 * #130, and the whole surface disappears behind a stack trace that names no
 * export. That is precisely how this plugin lost its settings page on 0.2.1
 * while every gate stayed green: the page only reached an icon once the host
 * started serving its namespace, and until then the earlier generation's names
 * were never resolved at all.
 *
 * So every icon is looked up on the module object, the weight spelling is tried
 * after the size spelling, and an icon neither spelling serves degrades to a
 * component that draws nothing and reports the miss once. A shell that renames
 * another export then costs one icon instead of the page.
 *
 * The exported names keep their 0.1.x shape because that is what the call sites
 * were written against; what they resolve to is whichever spelling the running
 * shell actually serves.
 *
 * @module dsh-ds-db/src/client/icons
 */

import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import type { ComponentType } from 'react'
import type { IconProps } from '@deepseek-ai/dsh-client-ui-primitives'

/** The shell's module object, as a table of icons this plugin may or may not find. */
type IconTable = Record<string, ComponentType<IconProps> | undefined>

/** An icon the shell serves under neither spelling: draws nothing, keeps the page. */
const NoIcon: ComponentType<IconProps> = () => null

/** Spellings already reported, so a shell miss is logged once rather than every render. */
const reported = new Set<string>()

/**
 * Resolve one icon by either generation's spelling.
 *
 * Exported for the gate: the resolution order and the degradation are the two
 * behaviours that must not regress, and neither is observable from a rendered
 * page in this repository — the local shell serves only the older spelling.
 * @param table - the shell's module object.
 * @param sizeSpelled - the name 0.1.x serves.
 * @param weightSpelled - the name 0.2.x serves.
 * @returns the icon to draw, always a component.
 */
export function resolveIcon(
  table: IconTable,
  sizeSpelled: string,
  weightSpelled: string,
): ComponentType<IconProps> {
  const served = table[sizeSpelled] ?? table[weightSpelled]
  if (served !== undefined) return served
  if (!reported.has(sizeSpelled)) {
    reported.add(sizeSpelled)
    console.warn(`dsh-ds-db: the shell serves neither "${sizeSpelled}" nor "${weightSpelled}"; that icon is drawn empty`)
  }
  return NoIcon
}

/** What the running shell actually serves, read once at bundle load. */
const table = primitives as unknown as IconTable

/** Plus, for "new connection". */
export const IconPlusOutline16 = resolveIcon(table, 'IconPlusOutline16', 'IconPlusOutlineRegular')

/** Reload, for re-reading a list. */
export const IconRefreshOutline16 = resolveIcon(table, 'IconRefreshOutline16', 'IconRefreshOutlineRegular')

/** Collapse a tree row. */
export const IconChevronDownOutline14 = resolveIcon(table, 'IconChevronDownOutline14', 'IconChevronDownOutlineRegular')

/** Expand a tree row. */
export const IconChevronRightOutline14 = resolveIcon(table, 'IconChevronRightOutline14', 'IconChevronRightOutlineRegular')

/** A loaded level of the tree. */
export const IconCheckOutline16 = resolveIcon(table, 'IconCheckOutline16', 'IconCheckOutlineRegular')

/** Copy a name. */
export const IconCopyOutline16 = resolveIcon(table, 'IconCopyOutline16', 'IconCopyOutlineRegular')

/** The databases level of the tree. */
export const IconDataOutline16 = resolveIcon(table, 'IconDataOutline16', 'IconDataOutlineRegular')

/** Filter the tree. */
export const IconSearchOutline16 = resolveIcon(table, 'IconSearchOutline16', 'IconSearchOutlineRegular')

/** The browse tab's own mark. */
export const IconBrowseOutline16 = resolveIcon(table, 'IconBrowseOutline16', 'IconBrowseOutlineRegular')

/** The connection picker's mark. */
export const IconDatabaseOutline16 = resolveIcon(table, 'IconDatabaseOutline16', 'IconDatabaseOutlineRegular')

/** Run a statement. */
export const IconPlayOutline16 = resolveIcon(table, 'IconPlayOutline16', 'IconPlayOutlineRegular')

/** Cancel a running statement. */
export const IconStopFill16 = resolveIcon(table, 'IconStopFill16', 'IconStopFillRegular')
