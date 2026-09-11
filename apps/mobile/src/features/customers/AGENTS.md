# Customers — mobile CRM slice

Folder roles follow `src/features/catalog/products/`. `src/app/` stays
one-line re-exports. Feature code lives here. Form save/guard/scaffold
adoption is SHO-307 via `src/components/form-kit` — do not clone the
catalog form stack.

UI state ownership is `.claude/rules/mobile-ui-state.md`. List filters
and tab chrome are `useState` / local view state, never XState. Writes
on the list (archive / restore / delete) use `useContractMutation`.
Delete re-invokes with the confirmation challenge (protocol). Archive
is a UI confirm only. Catalog list does not own writes; this slice does,
because archive / restore / delete live on the row.

The client form (SHO-180 / SHO-307) composes `src/components/form-kit`
(`runFormSave` / `useFormSave` / `useUnsavedGuard` / `FormScreenScaffold`
/ `FormTextField`). Each CRM form is a single create/update write, so
`useFormSave` fits (unlike SHO-304's multi-write price-list loop). View
models live in `*-form.presenter.ts`; leftover composer glue above ~150
lines is Query + RHF + save wiring (same waiver as SHO-303/304/305).
The group form (SHO-181) lives in `groups/` next to the list presenter.
The counterparty form (SHO-196) lives in `counterparties/` next to the
list presenter. The invitation create form (SHO-206) lives in
`invitations/` next to the list presenter. Invitation leave is form-kit
`armedLeave: "dispatch-only"` so the once-only token/url stay until
Done. Do not log invite secrets.

Debounce is `src/hooks/use-debounced-value.ts` and protocol confirmation is
`src/api/protocol-confirm.ts` (SHO-219 / SHO-220). They do not live under
this `shared/`.

## Import directions (SHO-221)

UI subdomains may import `api/` and `shared/`. `shared/` must not import a
feature subdomain. `form/` must not import list/group/counterparty/
invitation **UI**. Cross-subdomain imports must be a deliberate reusable
primitive, not convenience reach-through.

Picker chrome (`OptionSelectSheet`, `SelectorRow`) and
`optionSelectItems` / `filterOptionSelectItems` / `flattenPages` live in
`src/components/ui/`. Lookup drain (`useDrainInfinitePages`) lives in
`src/hooks/`. Consume those; do not copy them into this slice.
`selectorLookupValue` (CRM inherit display) stays in `shared/option-select.ts`
and re-exports `optionSelectItems` for lookup hooks.

Client-form inherit / Юрособи helpers (`groupAssignedPriceListId`,
`inheritedPriceListPlaceholder`, counterparties body kind) stay in
`form/customer-form-pickers.ts`. Invitation create may import those inherit
helpers and `useCustomerFormLookups` from `form/` so it copies client
assignment UX instead of forking client-form-only modules. Groups and
counterparties must not import `form/`.

`list/` is the CRM home: it may compose groups / counterparties /
invitations **list** panes and list hooks. It must not import `form/`.

`api/` owns query/mutation binders and cache keys. Mutation binders may
import write-plan types from the owning UI subdomain (`*-form-plan.ts`).
They must not import JSX, RHF, screens, or views.

Leaf routes under `src/app/(app)/customers/` and the customers tab stay
one-line re-exports. `_layout.tsx` is stack chrome only.

Concrete forbidden directions are lint-enforced in
`apps/mobile/eslint/customers-boundaries.mjs` (mobile-local
`no-restricted-imports`). Not linted, because a folder-wide ban would
false-positive:

- `api/` → `*-form-plan.ts` / draft types used by mutation binders
- `invitations/` → `form/` inherit helpers and `useCustomerFormLookups`
- `list/` → groups / counterparties / invitations list panes

## Folders (one role each)

| Folder            | Owns                                                                                                                                                                                                                                                                                                             | Does not own                                                      |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `api/`            | list/query binders, status and delete mutations, `getCustomer` / `getGroup` / `getCounterparty`, `listCounterparties` / `deleteCounterparty`, `invites.list` / `invites.revoke` / `invites.create`, form mutations, cache invalidation keys                                                                      | JSX, RHF, screens, views                                          |
| `list/`           | Home screen, view, composer hook, clients presenter/row, `use-client-writes`. Top chrome is shared `TabView` + `SegmentedTabs` `layout="scroll"` (full-bleed swipe scenes; not `BottomNav`)                                                                                                                      | Group/counterparty/invitation row internals, form fields          |
| `groups/`         | Groups presenter, composer hook, group row, `use-group-writes`, create/edit group form (RHF, UI Zod, form-kit save/guard/scaffold, `group-form.presenter.ts`). Price-list picker reuses shared `OptionSelectSheet`                                                                                               | Client filters; client form fields; counterparties; invitations   |
| `counterparties/` | Counterparties presenter, composer hook, row, `use-counterparty-writes`, create/edit form (RHF, UI Zod, form-kit save/guard/scaffold, `counterparty-form.presenter.ts`). Search is name/EDRPOU. Delete is protocol confirmation (`customers:edit`)                                                               | Client filters; invitations; client form fields                   |
| `invitations/`    | Invitations presenter, composer hook, row, `use-invite-writes` (UI confirm revoke), create form (RHF, UI Zod, form-kit save/guard/scaffold, dispatch-only leave, once-only token/url). List is `invites.list`; create is `invites.create`; revoke is `invites.revoke`. No recopy from the list, no accept screen | Client filters; group/counterparty form fields; `list/` internals |
| `form/`           | Create/edit client screen, view, UI draft Zod, form-kit fields/save/guard/scaffold, `customer-form.presenter.ts`, picker lookups, archive/restore/delete on the editor, Юрособи list via `api/`, client inherit helpers                                                                                          | List filters; group/counterparty/invitation UI                    |
| `shared/`         | Permissions, hrefs, caps, initials, count labels, paged-list helpers, entity card chrome, `selectorLookupValue` (re-exports `optionSelectItems`), confirmed-write helper, shared client status writes                                                                                                            | Transport; feature subdomain imports; picker chrome               |

Do not add a feature-local tab bar. Compose `TabView` + `SegmentedTabs`
from `src/components/ui/` (decision table in
`docs/design/mapping/mp-to-mobile.md`).
