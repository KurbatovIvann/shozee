# Pricing — mobile price-list slice (SHO-189 / SHO-190)

Folder roles follow `src/features/catalog/products/` and customers list
chrome. `src/app/` stays one-line re-exports. Feature code lives here.
Form-kit adoption is SHO-304 (`src/components/form-kit`) — do not clone
the catalog form stack.

UI state ownership is `.claude/rules/mobile-ui-state.md`. List filters
and options-sheet chrome are `useState` / local view state, never XState.
Writes on the list (default / active / delete) use `useContractMutation`.
Delete is UI confirm (`presentConfirmDialog`) then protocol confirmation
(`submitWithProtocolConfirmation`). Catalog list does not own writes; this
slice does, because default/active/delete live on the options sheet.

The editor is RHF `Controller` + UI draft Zod + a save planner. Dirty is
a keyed origin map + per-path reconcile (do not `watch()` the whole form
into `useState`). Price rows are FlashList-virtualized. Create saves the
list then navigates to edit to fill prices. Employees (`pricing:view`
only) are gated with `canManagePriceLists` before any write; the server
still re-checks `pricing:manage`. Compose `src/components/form-kit` for
guard/scaffold/`FormTextField`. The save loop stays in
`use-price-list-save.ts` (`useBoundContractMutation` + `runPriceListFormSave`)
because `runFormSave` is a single pass.

## Folders (one role each)

| Folder    | Owns                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Does not own                          |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `api/`    | list binders with `query` + `availability`, get/entries/catalog reads, status and delete mutations, form mutation, cache keys                                                                                                                                                                                                                                                                                                                                                       | JSX, RHF, the customers picker binder |
| `list/`   | Screen, view, composer hook, presenter, row, options sheet, list writes. Filter chips are `ChoiceField` (not `BottomNav` / `SegmentedTabs`)                                                                                                                                                                                                                                                                                                                                         | Editor form fields                    |
| `form/`   | Create/edit screen, view, UI draft Zod, RHF `Controller` sections, save loop, form-kit guard/scaffold, price rows. Pure roles: `price-list-form-draft.ts`, `price-list-form-plan.ts`, `price-list-form-copy.ts`, `price-list-form-load.ts`, `price-list-form-diff.ts`, `price-list-form-bulk.ts`, `variant-expansion.reducer.ts`, `price-list-form.presenter.ts`. Composer (`use-price-list-form.ts`) hydrates + RHF + save; queries/dirty/variant-expand/origin are sibling hooks. | List filters; a combined `*-model.ts` |
| `shared/` | Permissions, hrefs, caps, entry-count labels, mutation banners, ids                                                                                                                                                                                                                                                                                                                                                                                                                 | Transport                             |

`form/` must not import `list/`. Shared hrefs, permissions, and caps stay
in `shared/`. Reuse `api/price-list-status.ts` and `api/price-list-cache.ts`.

Do not import `apps/mobile/src/features/customers/api/price-list.queries.ts`
from this slice — that binder stays picker-safe (`{}` / `{ limit }`). List
reads with `query` / `availability` live here. Do not import `@showzy/db`
or `@showzy/core`. Domain reads/writes go through `@showzy/contract`.
