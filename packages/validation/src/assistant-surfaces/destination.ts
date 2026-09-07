/**
 * Every registered assistant surface declares where the card leads
 * (SHO-470). Discriminated so `terminal` cannot be reached by omitting
 * a route. `document` is shape-only — no routes until that work exists.
 *
 * Canonical list screen hrefs match the mobile app (`/orders`,
 * `/customers`) and are re-exported there. Per-record routes live in
 * the app (`orderDetailHref`, `customerEditorHref`). Do not invent
 * document routes here.
 */

export type AssistantSurfaceDestinationDeclaration =
  | { readonly kind: "screen" }
  | { readonly kind: "document" }
  | { readonly kind: "terminal" };

export type AssistantSurfaceDestination =
  | { readonly kind: "screen"; readonly href: string }
  | { readonly kind: "document" }
  | { readonly kind: "terminal" };

/** Orders list screen. Same string as mobile `ASSISTANT_ORDERS_LIST_HREF`. */
export const ASSISTANT_ORDERS_LIST_SCREEN_HREF = "/orders";

/** Customers tab. Same string as mobile `ASSISTANT_CUSTOMERS_LIST_HREF`. */
export const ASSISTANT_CUSTOMERS_LIST_SCREEN_HREF = "/customers";

export function resolveAssistantSurfaceDestination(
  declaration: AssistantSurfaceDestinationDeclaration,
  screenHref: string,
): AssistantSurfaceDestination {
  switch (declaration.kind) {
    case "screen":
      return { kind: "screen", href: screenHref };
    case "document":
      return { kind: "document" };
    case "terminal":
      return { kind: "terminal" };
  }
}

/**
 * Href the frame may hand off to. `screen` only. `terminal` and
 * `document` return null — never treat a missing destination as terminal.
 */
export function assistantSurfaceHandoffHref(
  destination: AssistantSurfaceDestination,
): string | null {
  switch (destination.kind) {
    case "screen":
      return destination.href;
    case "document":
    case "terminal":
      return null;
  }
}
