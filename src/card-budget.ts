/**
 * The size one tool call's card metadata may take.
 *
 * A module of its own, and nothing imports anything into it, because three places
 * need the same number and they must not drift: the Host that writes a card, the
 * checks that bound it, and the tool that measures a recorded session. Drift is
 * not hypothetical — a budget counted with `JSON.stringify(...).length` is counted
 * in UTF-16 code units, so CJK text was admitted at three times the bytes it
 * really takes while every check agreed with every other one.
 *
 * @module dsh-ds-db/src/card-budget
 */

/** Serialized UTF-8 bytes one card may take, its own fields included. */
export const CARD_BYTES = 16 * 1024
