/**
 * Provenance marks a result-card view may carry (SHO-469 frame chrome,
 * SHO-497).
 *
 * **No surface produces marks today, and none will until SHO-464 ships.**
 * Every live card omits `marks`, and an omitted `marks` renders nothing:
 * no unvouched fill, no origin sparkle. Do not invent a mark on a surface
 * to give the path a producer — a sparkle on a card whose provenance
 * nobody wrote is worse than no sparkle.
 *
 * The producer is the deferred vouching lifecycle of SHO-464. When it
 * lands it has to: carry `createdVia` / `vouchedBy` on the façade output,
 * parse them into the surface data, and map them here — the assistant
 * channel in `createdVia` becomes `origin` (with `originLabel`), a record
 * no principal has vouched for becomes `provisional`. The columns exist
 * (`packages/db/src/schema/tenant-columns.ts`); nothing reads them yet.
 *
 * This is a declared field rather than a duck-typed `object` so that step
 * cannot half-land. A card view that names the field anything else is a
 * compile error at the read, not a mark that stays silently dark — the
 * failure mode SHO-421 and SHO-460 already paid for twice.
 */
export type AssistantResultMarks = {
  readonly provisional: boolean;
  readonly origin: boolean;
  readonly originLabel: string | null;
};

/** A card view that may declare provenance marks. Absent = no marks. */
export type AssistantResultMarksCarrier = {
  readonly marks?: AssistantResultMarks;
};
