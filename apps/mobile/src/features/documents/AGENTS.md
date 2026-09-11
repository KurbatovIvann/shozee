# Documents — mobile list + create + public token + QES (SHO-237 / SHO-238 / SHO-260)

Folder roles follow `src/features/catalog/products/` (`api/`, `list/`,
`form/`, `shared/`). Options-sheet **writes** follow
`src/features/pricing/list/` (catalog list does not own writes). Create composes the shared form-kit (`src/components/form-kit`:
`runFormSave`, `useFormSave`, `useUnsavedGuard`, `FormScreenScaffold`).
The create form uses type/layout cards, `SelectorRow`, and
`FormTextField` for optional delivery-note Підстава. `src/app/` stays one-line
re-exports. Feature code lives here, not under
`src/components/screens/`.

UI state ownership is `.claude/rules/mobile-ui-state.md`. List filters
and options-sheet chrome are `useState` / local view state, never XState.
Writes on the list (share / cancel) use `useContractMutation`. Cancel is
UI confirm (`presentConfirmDialog`) after the options sheet hides — the
action does not declare protocol confirmation. Sign is HITL: local
confirm → `submitWithProtocolConfirmation` (`documents.requestSign`) →
key sheet. Confirmation does not replace key possession. Share mints the
page token once per sheet session; do not log the raw token, key,
password, or signed URL.

Create is `/documents/new` only (no edit snapshots). Totals come from
the server snapshot — do not reprice on the client. Public `/d/[token]`
is an in-app Expo route that calls `documents.getShared`; the API HTML
landing stays in SHO-235.

## Folders (one role each)

| Folder     | Owns                                                                                                                                                                         | Does not own                       |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `api/`     | `documents.list` infinite binder, `documents.get`, cancel/share/create mutations, order/counterparty lookups, `docGeneration.listLayouts`, `documents.getShared`, cache keys | JSX, RHF                           |
| `list/`    | Screen, view, composer hook, options chrome hook, presenter, row, options sheet, list writes. Filter chips are `ChoiceField` (not `BottomNav` / `SegmentedTabs`)             | Create editor, public token screen |
| `form/`    | Create editor: schema, draft, plan, save (form-kit), load, copy, pickers, layout catalog, screen/view. Type/layout cards are not list `ChoiceField`                          | List, public HTML landing          |
| `share/`   | Handover sheet/chrome (list + form), public `/d/[token]` screen (unsigned PDF + signed ASiC when `signedDownloadUrl` is set)                                                 | Form RHF, list filters             |
| `signing/` | QES sheet, `useReducer` session, HITL helper, Nitro/web runtime split, JS ASiC packer. List Sign uses `supplierSigned`; options chip uses `documents.get.signing`            | List filters, form RHF             |
| `shared/`  | Permissions, hrefs, ids, share-token parse, issued-on formatting, mutation banners, lookup caps                                                                              | Transport                          |

`list/` must not grow a combined `*-model.ts`. Query keys are
`[actionName, companyId, input]` (SHO-102) for staff actions. Public
`documents.getShared` keys `[actionName, null-company, { token }]` and
does not send `companyId`. Type filter maps onto `documents.list`
`type`. Optional `orderId` is a query param, never an access grant. List
has no search. Row buyer label is the list snapshot (`buyerLabel`), not
a live CRM join. Generation status and the panel PDF URL come from
`documents.get` on the options / open-PDF path — not from an N+1 get on
every list row, and not from a list-row `generation` field (the list
contract has none). List Sign uses the list `supplierSigned` flag.
Options signing chip uses nested `documents.get.signing`.

**`form/` must not import `list/`.** **`signing/` must not import `list/`.**
Shared hrefs, permissions, and handover helpers live in `shared/` or
`share/`. Compose `OptionSelectSheet` / `SelectorRow` from
`src/components/ui/` and `useDrainInfinitePages` /
`useSheetHiddenWaiter` from `src/hooks/` — do not copy picker chrome
into `form/` and do not import `features/orders` or `features/customers`.

Do not import `@showzy/db` or `@showzy/core`. Domain reads and writes go
through `@showzy/contract`.
