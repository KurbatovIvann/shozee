# Companies — mobile settings hub + legal editor (SHO-226 / SHO-225)

Folder roles follow `src/features/catalog/products/` (`api/`, `hub/`,
`form/`, `shared/`). `src/app/` stays one-line re-exports. Feature code
lives here, not under `src/components/screens/`.

The More → Налаштування компанії hub binds `companies.get` (read). Do
not wrap the hub in `FormScreenScaffold`: it is not a save form (no
cancel/submit), it shows an identity subtitle, and it uses
`edges={["top"]}` so the tab bar can sit under the list. The legal
editor (`form/`) binds `companies.get` to hydrate and
`companies.updateLegal` to save. Compose `src/components/form-kit`
(`runFormSave` / `useFormSave` / `useUnsavedGuard` / `FormScreenScaffold`
/ `FormTextField`). Keep draft/plan/schema/copy/load here. Do not call
`companies.get` when `canViewCompanySettings` is false.

UI state ownership is `.claude/rules/mobile-ui-state.md`. Hub load
classification is a pure presenter. Form fields are RHF + UI Zod. No
XState. No ФОП-registry quick-fill. Named deviation: ship ФОП/ТОВ
(canvas is ФОП-only).

## Folders (one role each)

| Folder    | Owns                                                                                 | Does not own                         |
| --------- | ------------------------------------------------------------------------------------ | ------------------------------------ |
| `api/`    | `companies.get` query binder, `updateLegal` mutation binder, cache invalidation keys | JSX, permissions, hrefs              |
| `hub/`    | Settings screen, view, composer hook, presenter, settings row                        | Form fields, profile/slug write      |
| `form/`   | Legal editor screen, view, UI draft Zod, RHF fields, save loop, unsaved guard        | Hub chrome, profile/slug, quick-fill |
| `shared/` | `settings:payments` affordances, hrefs, field caps                                   | Transport                            |

`hub/` must not invent a profile write. `form/` must not import `hub/`.
Domain reads and writes go through `@showzy/contract`. Do not import
`@showzy/db` or `@showzy/core`.
