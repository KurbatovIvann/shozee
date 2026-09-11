# Catalog products — golden mobile slice

Folder roles here (`api/`, `list/`, `detail/`, `form/`, `photos/`,
`shared/`) are the layout for the next staff module. `src/app/` stays
one-line re-exports. Feature code lives here, not under
`src/components/screens/<feature>/`.

**Compose shared kits; do not clone this tree's form stack.** Save,
guard, scaffold, and `Controller`+`TextField` chrome live in
`src/components/form-kit` (SHO-300). Picker chrome
(`OptionSelectSheet`, `SelectorRow`, `option-select.ts`) lives in
`src/components/ui/`; `useDrainInfinitePages` and `useSheetHiddenWaiter`
live in `src/hooks/` (SHO-301).
Copy only what is product-specific: draft/plan/schema/copy/load, the
photos `useReducer` session, the variant sheet, and the multi-write
save loop (`photos.flush`, `too_many_variants`).

UI state ownership is `.claude/rules/mobile-ui-state.md`. The form uses
RHF `Controller` for create/edit scalar fields (name, price) and a nested
RHF sheet for variants (SHO-163). Pin exact `react-hook-form` /
`@hookform/resolvers` in `apps/mobile/package.json`. Photos is a
`useReducer` session (`reducePhotoSession`, SHO-162) — not XState.

## Folders (one role each)

| Folder    | Owns                                                                                                                                                                                                                                                                                                                                         | Does not own                                                                                                   |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `api/`    | `product.queries.ts`, mutation binders, `product-cache.ts` invalidation keys                                                                                                                                                                                                                                                                 | JSX, RHF, session reducers                                                                                     |
| `list/`   | Screen, view, composer hook, presenter, row, `use-product-thumbnails.ts`                                                                                                                                                                                                                                                                     | Writes, photo session                                                                                          |
| `detail/` | Screen, view, facade (`ProductDetailModel` is `ReturnType<typeof useProductDetail>`), query/actions/variant hooks (`use-variant-editor.ts`, `variant-actions-labels.ts`), sheet reducer                                                                                                                                                      | Form field state, photo session internals                                                                      |
| `form/`   | Create/edit screen, view, UI draft Zod, RHF `Controller` sections, save loop, unsaved guard, variant sheet (`use-product-form-variants.ts`). Pure roles: `product-form-draft.ts`, `product-form-plan.ts`, `product-form-copy.ts` (`resolveProductFormPresentation`), `product-form-load.ts`                                                  | List filters; photo session internals; a combined `*-model.ts`                                                 |
| `photos/` | `useReducer` session, thin manager hook (`use-product-photos-query.ts` / `use-product-photos-runtime.ts`), commit/runtime I/O, upload runner, native, picker. Pure roles: `product-photos-slots.ts`, `product-photos-plan.ts`, `product-photos-banners.ts`, `product-photos-prepare.ts`. Strip download binders: `product-photos-queries.ts` | A second `catalog.getProduct` when the parent already has `imageFileIds`; a combined `product-photos-model.ts` |
| `shared/` | Permissions, presenters (`variant-count`), `product-id.ts`, `product-hrefs.ts`, `product-caps.ts`, `classify-product-load.ts` (`classifyProductDetail` + `classifyProductPhotosLoad`), sheet chrome used by more than one surface                                                                                                            | Transport                                                                                                      |

## Compose-me rules

- **Query vs RHF vs `useReducer` vs view.** TanStack Query stays in
  `api/` and surface hooks. Form fields belong in RHF `Controller` (or
  `FormTextField` / section components that take `control`) — not the
  detail/list hooks, not `watch()` of the whole form as the render model,
  and not a parallel `useState` per field. After a successful UI parse
  (`handleSubmit` / `parseProductFormUiDraft`), run `planProductFormSave`
  then `photos.flush()`. After submit, parent field and variant row errors
  come from `formState` (copy keys) mapped onto draft keys, plus wire
  `VALIDATION` issues on the same shape — not a parallel `clientErrors`
  store. RHF gates the write; compacting a blank unsaved row must not
  hide remaining variant failures. `too_many_variants` is a local
  banner, not a field error. Photo session belongs in `useReducer` +
  `reducePhotoSession`. `use-product-photos.ts` composes the session with
  `use-product-photos-query.ts` (download URLs) and
  `use-product-photos-runtime.ts` (commit/runtime) — it does not own
  slots or the handshake. `use-product-form.ts` composes
  `use-product-form-variants.ts`; field errors go through
  `resolveProductFormPresentation`. `use-variant-actions.ts` composes
  `use-variant-editor.ts` and `variant-actions-labels.ts`. List filters
  and sheet chrome are `useReducer`
  (or local view state), never XState. Views take a view-model and
  callbacks. `use-products-list.ts` stays a thin composer: filter/search
  state + query + presenter + thumbnails + navigation.
  `use-product-detail.ts` stays a thin facade: `useProductDetailQuery`
  (`catalog.getProduct` only) + product actions + variant actions + photo
  manager + `product-detail.reducer.ts`. Pass `imageFileIds` from the
  detail query into photos; do not start a second `getProduct`. No RHF on
  detail.
- **No second `getProduct`.** If the parent already has `imageFileIds`,
  hydrate photos from that list. Do not start another `catalog.getProduct`
  for thumbnails.
- **Kebab-case files**, PascalCase component exports. Query binders live
  in `product.queries.ts` and `product-detail-query.ts`. Photo-strip
  download binders live in `photos/product-photos-queries.ts`. Writes go
  through the real mutation binders — `product-form-mutation.ts`
  (`createProduct` / `updateProduct` / `createVariant` / `updateVariant`),
  `product-photos-mutation.ts` (`setProductImages`), `product-archive.ts`
  — not a fictional `product.commands.ts`. The list presenter is
  `products-list.presenter.ts`. Ids, hrefs, shared caps, and permissions
  live in `shared/`; `form/` must not import `detail/`. `detail/` may
  import from `form/` only `VariantEditorSheet`, `product-form-plan.ts`,
  `product-form-draft.ts`, and `product-form-copy.ts` so detail variant
  writes do not fork a second payload. Detail must never import the
  form hook, screen, or view.
- **Catalog limits** come from `@showzy/validation/catalog` (or
  `ContractClient` types), not a second local number. List search uses
  `LIST_PRODUCTS_QUERY_MAX`. Photos uses `SET_PRODUCT_IMAGES_MAX`.
  Form/detail share `PRODUCT_FORM_MAX_VARIANTS` / `PRODUCT_NAME_MAX` from
  `shared/product-caps.ts`. Thumbnail URLs go through
  `src/api/file-download-query.ts`.
- **Screens do not own transport.** Routes re-export a screen. Screens
  compose a hook + view. Hooks call `api/` binders. Never import
  `@showzy/core`.
- **Form stack.** New forms import `src/components/form-kit`
  (`runFormSave`, `useFormSave`, `useUnsavedGuard`, `FormScreenScaffold`,
  `FormTextField`). Do not copy `product-form-save.ts`,
  `use-product-save.ts`, `use-unsaved-product-guard.ts`, or the view
  StyleSheet. This slice still owns the product multi-write loop and
  photos flush until a later ticket adopts the kit.
