/**
 * Result-card surface registry (SHO-385 / SHO-456). The descriptor,
 * unlocalized parse, and compose rule live in
 * `@showzy/validation/assistant-surfaces`. This file re-exports that
 * registry for mobile consumers. Localization stays in `./` card views.
 *
 * Adding the **second list-shaped** surface (customers, price lists):
 * build it generic — one card driven by a typed column descriptor — and
 * move `orders-list` onto it in the same PR. Do not copy `orders-list.ts`
 * and swap the columns.
 *
 * Not done already because there is nothing to generalise from yet:
 * `orders-list` is the only table here. An abstraction derived from one
 * example is the wrong abstraction — wait for the second real case.
 */
export {
  ASSISTANT_SURFACE_REGISTRY as ASSISTANT_RESULT_SURFACE_REGISTRY,
  type AssistantSurfaceDescriptor as AssistantResultSurfaceDefinition,
  type AssistantSurfaceKind as AssistantResultSurfaceKind,
} from "@showzy/validation/assistant-surfaces";
