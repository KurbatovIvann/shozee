# Orders — mobile list + detail + create (SHO-211 / SHO-212 / SHO-213)

Folder roles follow `src/features/catalog/products/` and customers list
chrome. `src/app/` stays one-line re-exports. Feature code lives here.
Compose `src/components/form-kit` (`useFormSave`, `useUnsavedGuard`) for
the create save/leave shell. Do not clone the catalog form stack.

UI state ownership is `.claude/rules/mobile-ui-state.md`. List filters
and the status-filter sheet are `useState` / local view state, never
XState. Detail sheet chrome is a `useReducer`. The create form uses RHF

- a UI Zod draft, a write planner, and the shared unsaved-leave guard. Views take
  a view-model and callbacks. No RHF on list or detail.

Do not import `src/features/customers/` from this slice. List rows use
the `orders.list` customer name snapshot (localize sentinel `unlinked`).
Detail still hydrates `customers.getCustomer` through `@showzy/contract`
(binder in `api/customer-name-query.ts`). Picker lists use orders-owned
binders in `api/order-customers-query.ts` and `api/order-catalog-query.ts`.
Compose `OptionSelectSheet` / `SelectorRow` from `src/components/ui/` —
do not copy picker chrome. Do not join customers in the orders backend
module.

## Folders (one role each)

| Folder    | Owns                                                                                                                                                                                                                          | Does not own                            |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `api/`    | `orders.list` infinite binder, `orders.get`, confirm/cancel/create writes, detail customer-name hydration, picker list/get binders                                                                                            | JSX, other modules' query files         |
| `list/`   | Screen, view, composer hook, presenter, row, filter sheet                                                                                                                                                                     | Detail / editor; per-row getCustomer    |
| `detail/` | Screen, view, facade, query/actions hooks, sheet reducer, line row, actions sheet                                                                                                                                             | List filters; editor                    |
| `form/`   | Create-only screen, view, UI draft Zod, RHF sections, save loop, unsaved guard, picker sheets. Pure roles: `order-form-draft.ts`, `order-form-plan.ts`, `order-form-copy.ts`, `order-form-load.ts`, `order-form.presenter.ts` | List filters; detail; edit-after-create |
| `shared/` | Permissions, hrefs, item-count labels, order id, load classification, customer-name, status, create caps                                                                                                                      | Transport                               |

`list/` must not grow a combined `*-model.ts` and must not grow into
`detail/` or `form/`. `form/` must not import `list/` or `detail/`.
Query keys are `[actionName, companyId, input]` (SHO-102).
Empty selected statuses omit `filter.statuses` (every CHECK status). List
search is `orders.list` `filter.query` (debounced); do not filter
client-side across the cursor. No payment filter. Create and detail never call
`pricing.resolveProductPrices` or show `basePriceMinor` as the line
price. Create is `/orders/new` only — no `/orders/[id]/edit`.
