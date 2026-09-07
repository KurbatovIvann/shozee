# @showzy/mobile — Agent Instructions

Expo client (fnd-T48 shell, fnd-T49 auth). Primary V2 surface (ADR-0010).
Product screens are blocked by the Experience Foundation UX gate. Runtime is
Expo SDK 57.0.14 / React Native 0.86.2. Keep Unistyles on 3.2.2 (V1) and
Reanimated on 4.5.1 with worklets 0.10.1 — do not float Unistyles to 3.3
(worklets 0.11) or Reanimated to 4.5.0.

## Sources of truth

| Concern              | Source                                                                                                                                                                                                           |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Visual language      | Unistyles `src/theme/` mapped from the Magic Patterns canvas ([`mp-to-mobile.md`](../../docs/design/mapping/mp-to-mobile.md))                                                                                    |
| How to port a screen | Inventory the canvas → classify shared vs feature → reuse/create in `components/ui`, `components/form-kit`, or `src/features/<module>/` — [`mp-to-mobile.md`](../../docs/design/mapping/mp-to-mobile.md)         |
| Domain behavior      | The Linear feature card, `@showzy/contract`, and the golden UI slice when it exists                                                                                                                              |
| UI state             | [`.cursor/rules/mobile-ui-state.mdc`](../../.cursor/rules/mobile-ui-state.mdc) — Query vs RHF vs `useReducer` vs view. Compose `src/components/form-kit` for save/guard/scaffold (photos = `useReducer` session) |
| Auth / sessions      | better-auth over `/api/auth` (ADR-0006, security-operations §2). Expo cookies via `@better-auth/expo` in SecureStore.                                                                                            |

Figma is not a source of spacing, color, or components. Never modify the
V1 repository (`E:\showzy`). Do not paste Magic Patterns React/Tailwind
into this app.

## Layout

Every file is kebab-case; components export PascalCase names. One folder =
one role — do not mix transport, domain state, screens, UI kit, and copy in
the same directory.

- `src/app/` — expo-router routes **only**, each a one-line re-export of a
  screen component. Auth routes live in the `(auth)` group with `OtpProvider`;
  signed-in routes live in `(app)` under the `(tabs)` shell. `/session`
  redirects into the tabs (SHO-122, owner decision 1); session identity
  lives on the More tab. No logic in route files besides layout guards
  and redirects. Company-scoped hierarchical stacks (customers, documents,
  more, orders, price-lists, products) re-export `HierarchicalCompanyStack`.
  Auth / root / tabs stay excluded. Guard-layout loading uses
  `CenteredSpinner`.
- `src/navigation/` — shared native-stack screen options and
  `HierarchicalCompanyStack` for hierarchical pushes. Auth / root / tabs
  stay excluded.
- `src/components/ui/` — **shared** primitives only (Button, Card, TextField,
  `SegmentedTabs`, `TabView`, `ListSurface` / `ListRow`, `EditorFooter`,
  inputs, Sheet / StatusPill / EmptyState / `CenteredSpinner`,
  `OptionSelectSheet`, `SelectorRow`). Never imports
  feature code; feature policy values (e.g. OTP length, search caps, copy)
  arrive as props. Before adding a new file here, confirm the canvas piece
  is actually shared. In-screen tabs are `SegmentedTabs` + `TabView` only —
  see the decision table in
  [`mp-to-mobile.md`](../../docs/design/mapping/mp-to-mobile.md).
  Do not add a second pill bar, PagerView wrapper, or `react-native-tab-view`.
  Staff shell tabs stay `BottomNav`. Filter chips stay `ChoiceField`.
  Do not fork a second `OptionSelectSheet` or `SelectorRow` in a feature
  folder — compose these and pass policy via props.
- `src/hooks/` — shared hooks (`useDebouncedValue`, `useDrainInfinitePages`,
  `useSheetHiddenWaiter`) and the pure `shouldDrainNextPage` predicate.
  Do not copy these into a feature folder.
- `src/components/form-kit/` — **shared form stack** (SHO-300): `runFormSave`,
  `useFormSave` (on `useBoundContractMutation`), `useUnsavedGuard`,
  `FormScreenScaffold`, `FormTextField`. Import and compose. Do not clone
  `catalog/products/form` save/guard/view chrome. Feature folders keep
  draft/plan/schema/copy/load and feature-only fields. Picker chrome lives
  in `components/ui` (`OptionSelectSheet`, `SelectorRow`) — do not invent
  a second picker home here.
- `src/features/<module>/<surface>/` — feature slices. Folder roles follow
  `src/features/catalog/products/` (`api/`, `list/`, `detail/`, `form/`,
  `photos/`, `shared/`). Screens take view models and callbacks; they do
  not own transport. Compose `components/ui` and `components/form-kit`; do
  not duplicate button/card chrome, picker chrome, or the form
  save/guard/scaffold. Read
  that folder's `AGENTS.md` and `.cursor/rules/mobile-ui-state.mdc` before
  adding files. Do not add XState unless a later feature card names a
  protocol statechart.
- `src/components/screens/<feature>/` — unmigrated feature screens (auth,
  panel, onboarding, company-resolution). Do not add new product modules
  here.
- `src/auth/` — auth logic only, no screens. `better-auth` and
  `@better-auth/expo` may be imported **only here**: `client.ts`
  (`createAuthClient` + `expoClient` cookie jar), `errors.ts` (HTTP status
  → kind, never `error.message`), `otp/` (identifiers, UI policy, pure
  `otpReducer` + `createOtpSessionStore` action ports, `OtpProvider`,
  TanStack `useMutation` send/verify),
  `session-provider.tsx` (`useSession` + `signOut`), `storage.ts` /
  `platform-storage.ts` (memory jar; native hydrates SecureStore; web stays
  in-memory), `use-sign-in.ts` / `use-verify.ts`.
  Tests cover the non-RN modules (`*.test.ts`).
- `src/prefs/` — device preferences (theme + last staff company selector).
  Native = MMKV (`platform-storage.native.ts`); web + tests = memory
  (`platform-storage.ts`). Never cookies, never the query cache.
- `src/i18n/` — `locale.ts` (device bind over `@showzy/copy/locale`
  `detectLocale(tag)` + interpolation) plus
  `device-locale.ts` / `install-locale.ts` (read `getLocales()` once at app
  start so no-argument `detectLocale()` follows the device; Ukrainian is
  still the default before init and for non-`en*` tags). Shared form chrome
  lives in `@showzy/copy/chrome`; `copy.ts` re-exports it (`WriteErrorsCopy`,
  `FormChromeCopy`) plus `CountForms` / `selectCopy` so existing namespace
  spreads keep compiling. Ukrainian one/few/many rules re-export
  `@showzy/copy/plural` from `plural.ts` — do not copy mod-10/mod-100 into
  a feature. Orders copy composes `@showzy/copy/orders` with a mobile
  extension (offline/back leftovers stay here). Customers copy is a
  thin re-export of `@showzy/copy/customers` (wholesale; web has none).
  One copy namespace per remaining feature (`auth.ts`, form namespaces
  still in this folder until their tickets).
  uk/en, matching V1's namespace split. New namespaces: follow
  [`packages/copy/AGENTS.md`](../../packages/copy/AGENTS.md) — feature
  code keeps importing this folder, not the package.
- `src/api/client.ts` — `createShowzyClient` wraps `createContractClient`
  with the env-driven API origin. Mobile passes `getCookie` from the Expo
  plugin; Bearer is optional for other clients.
- `src/api/api-provider.tsx` — contract client with Cookie. Sits inside
  `SessionProvider`. Binds last-company restore on live hydrate (SHO-103).
- `src/api/query-client.ts` / `query-options.ts` / `contract-mutation.ts` / `query-provider.tsx` — TanStack Query v5 runtime (SHO-102). Keys are `[actionName, companyId | null-company, input]`. Pass `useActiveCompany().activeCompanyId` into `contractQueryOptions` (and `getActiveCompany`) so a selector change re-renders keys. Company-selector persistence and tenant-cache isolation subscribe via `createShowzyClient().onActiveCompanyChange` from `QueryRuntimeProvider` (`bindActiveCompanyRuntime`) — do not monkey-patch `setActiveCompany`. `useContractMutation` mints one `createMutationAttempt()` per submit via `src/crypto/create-attempt` (`expo-crypto` on native — Hermes Web Crypto throws); `reset` also clears the attempt controller. Bind writes with `useBoundContractMutation` (`use-bound-contract-mutation.ts`) when adopting the shared `apiRef`/busy stanza. Do not persist the cache or add `@orpc/tanstack-query`. `query-platform.ts` is native-only (not imported from tests).
- `src/api/errors.ts` — `describeWireError` / `describeQueryFailure` discriminate on `error.code` / `kind`, never message text.
- `src/theme/tokens.ts` — palettes, spacing, radii, type, shadows, glass fallbacks. Pure TypeScript; no React Native imports.
- `src/theme/light.ts` / `dark.ts` — Unistyles theme objects.
- `src/theme/preference.ts` — `light` / `dark` / `system` resolution (default `light`, matching V1). Persisted via `src/prefs/` on native; web stays in-memory.
- `src/theme/unistyles.ts` — `StyleSheet.configure` only. Import from `index.ts` and `src/app/_layout.tsx` before any component. Do not import from tests. `index.ts` also side-effect-imports `src/crypto/install-web-crypto` first so Hermes gets `expo-crypto` Web Crypto.
- `metro.config.cjs` — NodeNext `.js` specifiers in workspace packages resolve to `.ts` so `@showzy/contract` can be bundled.

## Rules

- Client apps may import only `@showzy/contract`, `@showzy/validation`, `@showzy/copy`, `@showzy/ui` (`@showzy/ui` does not exist yet), and `@showzy/document-signing` (native/web adapters for on-device QES; never `/node`). Never `@showzy/core`, `@showzy/db`, or `@showzy/config`. `better-auth` and `@better-auth/expo` are allowed only under `src/auth/`.
- Staff copy: how to add a namespace, shared vs leftover, and how this app
  composes a typed extension lives in
  [`packages/copy/AGENTS.md`](../../packages/copy/AGENTS.md). Feature
  screens keep importing `src/i18n/<ns>`; device bind stays in this app.
- Config is `EXPO_PUBLIC_API_URL` (Metro-inlined). Empty string is unset. Do not read `process.env` through `@showzy/config`.
- Mobile session transport is a Cookie header from `@better-auth/expo` (SecureStore). Web export-smoke keeps cookies in memory. Never log tokens, cookies, or OTP codes. Classify auth HTTP failures by status, not message text.
- Auth is phone/email OTP only (ADR-0006). Google and guest browse are not in this slice.
- The signed-in company selector is a stub until `companies.listMine` (phase 2). The last selector is restored from device prefs after a **live** session hydrate only. An unsigned hydrate (dead cookie) clears the stored selector so the next sign-in cannot inherit another user's company. The selector is never an access grant (ADR-0013).
- Theme preference persists in MMKV on native (`src/prefs/`). Web and tests use the memory adapter — do not write cookies or the company selector to `localStorage`. Do not add a second storage native module. Session cookies stay in SecureStore.
- Native modules for owner-first launch and near-term surfaces are preinstalled (see `package.json` + `app.config.ts` plugins) so product screens do not force a new Expo/dev-client binary. Unistyles 3 already requires a custom dev client (`expo-dev-client`); do not use Expo Go. Pin new Expo packages with `pnpm --filter @showzy/mobile exec expo install`.
- Icons: `lucide-react-native` (Magic Patterns canvas, ADR-0024). Do not add Ionicons, `@expo/vector-icons`, NativeWind, Google Sign-In, `expo-location`, `@callstack/liquid-glass`, or `@gorhom/bottom-sheet` (sheets are Reanimated; gorhom is unreliable on Reanimated 4.5).
- Before writing mobile UI, routing, theme, animation, or native-module
  code, load `.cursor/skills/showzy-mobile/SKILL.md` and the matching leaf
  (`expo-router`, `expo-native-ui`, `expo-design-system`, `expo-animation`,
  `expo-dev-client`, `vercel-react-native-skills`). Skills are advisory
  (`docs/pipeline.md`): this file, ADRs, and `.cursor/rules/` win. Do not
  load `expo-ui`, `expo-tailwind-setup`, `expo-data-fetching`, or
  `expo-project-structure`.
- Porting a canvas screen: follow the inventory → classify → reuse/create
  loop in [`mp-to-mobile.md`](../../docs/design/mapping/mp-to-mobile.md).
  Bind values to the theme (Class A/B). Product IA is Class C — canvas first.
