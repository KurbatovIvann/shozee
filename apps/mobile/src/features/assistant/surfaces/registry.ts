/**
 * Result-card surface registry (SHO-385 / SHO-456 / SHO-472). The
 * descriptor, unlocalized parse, and compose rule live in
 * `@showzy/validation/assistant-surfaces`. This file re-exports that
 * registry for mobile consumers. Localization stays in `./` card views.
 *
 * List-shaped surfaces share one collection block driven by a typed
 * column descriptor (per-surface row cap, not one shared constant).
 * `customers-list` is the second list. Do not copy `orders-list.ts` and
 * swap the columns — a later list is a new descriptor, not a new card.
 */
export {
  ASSISTANT_SURFACE_REGISTRY as ASSISTANT_RESULT_SURFACE_REGISTRY,
  type AssistantSurfaceDescriptor as AssistantResultSurfaceDefinition,
  type AssistantSurfaceKind as AssistantResultSurfaceKind,
} from "@showzy/validation/assistant-surfaces";
