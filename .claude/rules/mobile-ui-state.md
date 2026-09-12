---
paths:
  - "apps/mobile/**"
---

# Mobile UI state

Copy this split. Do not invent a fourth store.

## State ownership

- **TanStack Query** — server state in `api/` and surface hooks. Do not
  persist the cache. No Zustand. No `@orpc/tanstack-query`.
- **RHF + UI Zod draft** — form fields only. Use `Controller` or section
  components that take `control`. Read errors from `formState` (messages
  are copy keys) plus wire `VALIDATION` issues mapped onto the same
  shape. Do not keep a parallel `clientErrors` `useState`. Do not
  `watch()` the entire form as the render model. Do not use `useState`
  per field on a form that already has RHF. After a successful UI parse,
  run the **write planner** and a wire-schema gate; never treat
  `handleSubmit` as the only mutate. `too_many_variants` is a local
  banner, not a field error.
- **`useReducer` + a pure `reduce*`** — local sessions: photo
  slots/commit queue, sheet chrome, OTP-style flows. The reduce function
  lives in a `.ts` file without React. The hook composes reducer + I/O
  ports.
- **XState** — not in this slice. Do not add it back unless a later
  feature card names a protocol statechart (acquiring connect, QES
  on-device). List filters and sheet chrome are never XState.
- **View** — view-model + callbacks. No transport, no Query, no RHF
  internals leaking into rows.

## Anti-god-hook

- Screen = hook + view. Route file stays a one-line re-export.
- Composer / facade hook target ≤ ~150 lines; extract when over.
- Pure domain: one role per file (schema, plan, snapshot, copy, load).
  Do not grow a combined `*-model.ts` past a single role.
- Cross-surface helpers (ids, hrefs, shared caps, permissions) live in
  `shared/`. `form/` must not import `detail/`. `detail/` must not import
  `form/` except `VariantEditorSheet` and the pure plan/draft/copy
  modules so detail variant writes do not fork a second payload. Detail
  must never import the form hook, screen, or view.
- Photos hydrate from parent `imageFileIds`. No second `getProduct`.

When a later screen grows (description, specs, inventory): add a
**section** that takes `control`, extend the UI draft schema, keep the
planner. Do not add a new `useState` field pile.

## Form stack

Compose `apps/mobile/src/components/form-kit` (`runFormSave`,
`useFormSave`, `useUnsavedGuard`, `FormScreenScaffold`, `FormTextField`).
Do not clone `catalog/products/form` save/guard/view chrome. Copy only
the feature-specific slices: draft, plan, schema, copy, load, and
fields that are not a `FormTextField`. Picker chrome
(`OptionSelectSheet`, `SelectorRow`) lives in `src/components/ui`;
sheet-hidden waiters live in `src/hooks`. Pickers over open-ended sets
search the server with a debounced query and page on scroll (golden:
`features/catalog/products/list/use-products-list.ts`); `useDrainInfinitePages`
(also in `src/hooks`) is only for small bounded reference sets (groups,
price lists, one customer's counterparties), not the lookup/picker
default.
