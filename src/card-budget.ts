/**
 * The size one tool call's card metadata may take.
 *
 * A module of its own, and nothing imports anything into it, because three places
 * need the same numbers and they must not drift: the Host that writes a card, the
 * checks that bound it, and the tool that measures a recorded session. Drift is
 * not hypothetical — a budget counted with `JSON.stringify(...).length` is counted
 * in UTF-16 code units, so CJK text was admitted at three times the bytes it
 * really takes while every check agreed with every other one.
 *
 * The three values are this module's defaults and the `ds-db` row's configuration
 * schema defaults, so a deployment that changes one changes what is written and
 * what is checked together.
 *
 * @module dsh-ds-db/src/card-budget
 */

/** Serialized UTF-8 bytes one card may take, its own fields included. */
export const CARD_BYTES = 16 * 1024

/** Rows one table card carries at most; the metadata is written into the session log. */
export const CARD_ROWS = 50

/** Items one list card carries at most, for the same reason. */
export const CARD_ITEMS = 100

/** The bounds one call's card metadata is written under. */
export interface CardBudget {
  /** Serialized UTF-8 bytes one card may take, its own fields included. */
  bytes: number
  /** Rows one table card carries at most. */
  rows: number
  /** Items one list card carries at most. */
  items: number
}

/** The bounds a deployment that configures none gets. */
export const CARD_BUDGET: CardBudget = {
  bytes: CARD_BYTES,
  rows: CARD_ROWS,
  items: CARD_ITEMS,
}
