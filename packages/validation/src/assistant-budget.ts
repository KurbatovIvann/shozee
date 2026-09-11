/**
 * The most one staff assistant turn may reserve against the daily budgets,
 * in USD (SHO-560).
 *
 * The reservation itself is configuration (`AI_UNKNOWN_MODEL_TURN_USD`), so no
 * static value exists for a contract to be bounded by. This is that bound, in
 * the one place both sides may import: the assistant module's contract refuses
 * a stored hold above it, and the runtime's budget guard refuses limits whose
 * reservation exceeds it, so a hold that reaches a turn row can always be
 * released without driving a counter below what was reserved.
 */
export const ASSISTANT_TURN_RESERVATION_MAX_USD = 1;

/** The same bound in the integer micro-USD a turn row stores. */
export const ASSISTANT_TURN_RESERVATION_MAX_MICRO_USD =
  ASSISTANT_TURN_RESERVATION_MAX_USD * 1_000_000;
