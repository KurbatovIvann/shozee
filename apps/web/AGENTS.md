# @showzy/web — Agent Instructions

Staff panel SPA (ADR-0030). Vite + React + TanStack Router + TanStack
Query. Classic UI executes the same `@showzy/contract` actions as
mobile and chat. This is **not** the public storefront (later app) and
**not** the Expo client.

Load this file and `.cursor/skills/showzy-web/SKILL.md` before writing
code under `apps/web`. Skills are advisory: `.cursor/rules/`, accepted
ADRs, and this file win.

## Sources of truth

| Concern                              | Source                                                                                                                                                                              |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product screen visuals               | Web canvas Screens + files ([`mp-to-web.md`](../../docs/design/mapping/mp-to-web.md)); inventory in [`web-panel-chrome.md`](../../docs/design/mapping/web-panel-chrome.md) §Screens |
| Theme tokens                         | `src/theme/`                                                                                                                                                                        |
| Chrome / tokens lock                 | [`web-panel-chrome.md`](../../docs/design/mapping/web-panel-chrome.md) (breakpoints, nav IA, tones — not a screen substitute)                                                       |
| Directory / route / data conventions | [`web-panel-architecture.md`](../../docs/design/web-panel-architecture.md)                                                                                                          |
| Stack / cookies / slug vs UUID       | [ADR-0030](../../docs/adr/0030-web-panel-spa-and-deferred-storefront.md)                                                                                                            |
| Domain behavior                      | Linear feature card + `@showzy/contract`                                                                                                                                            |
| Query keys / mutations               | `src/api/query-options.ts`, `src/api/contract-mutation.ts`                                                                                                                          |
| Golden feature slice                 | `src/features/companies/` (api, onboarding form, company scope)                                                                                                                     |
| Auth / sessions                      | better-auth over `/api/auth` (ADR-0006). Browser cookies, same-origin.                                                                                                              |

Figma is not a source of spacing or color. Never modify the V1
repository. Do not paste Magic Patterns React/Tailwind as-is.

## Placement

Use [canonical source ownership](../../docs/design/web-panel-architecture.md#canonical-source-ownership)
and the [route conventions](../../docs/design/web-panel-architecture.md#directory-route-tree).
`app/` composes, `routes/` adapts, `layouts/` owns chrome, and
`features/` owns product behavior. Create feature subfolders only when a
real file needs them. Shared integration support lives in `src/test/`;
feature-local tests colocate. Views do not import the contract client.

## Import direction

```text
app/          → routes, api, auth, layouts, features (composition only)
routes/       → layouts, features/* pages, api (prefetch only)
layouts/      → components/ui, i18n, prefs, auth (session display);
                may compose features/companies switcher/scope
                (`scope/`, `api/`) — not onboarding/, picker/, or other domains
features/A    → api/, components/ui, i18n, src/auth, prefs;
                not layouts, not app, not routes;
                A/api → src/api helpers;
                A/list|detail|form → same-area api/ and shared/
                form/ must not import detail/ (and vice versa)
                other domains only via that domain's shared/
components/ui → nothing in features, layouts, routes, or api
```

Never import `@showzy/core`, `@showzy/db`, `@showzy/config`,
`@showzy/ai`, module packages, or `@showzy/contract/server` (ESLint
`clientApp` boundary). Staff copy comes from `@showzy/copy`. `better-auth`
only under `src/auth/`. Layer
direction is `showzy-web/layer-boundaries` (fixture tests in
`eslint/import-boundaries.test.mjs`).

## Routes

Thin adapter:

1. `createFileRoute` with typed `params` / `validateSearch`.
2. Optional `loader` that `ensureQueryData`s the **same**
   `contractQueryOptions` the page hook uses.
3. Render a feature page (or a layout that renders `<Outlet />`).

Rules:

- A parent route with children **must** render `<Outlet />`.
- The exact URL of a parent is an `index.tsx`, not the layout
  `route.tsx`.
- Company scope lives under `$companySlug`. Pathless `_panel` and
  `_full` groups own chrome without changing URLs. See the intended
  directory tree in `docs/design/web-panel-architecture.md`.
- Folder-local `route.tsx` owns the layout for that folder.
- No `pathname.startsWith` / regex to decide section, list vs detail,
  or full-shell. Use typed router matches and pathless layouts.
- Never hand-edit `src/routeTree.gen.ts` (Vite plugin generates it;
  ESLint ignores it).

Copy today's thin adapters: `src/routes/_auth/sign-in.tsx`,
`src/routes/_authed/$companySlug/route.tsx` (company scope +
`<Outlet />` via `CompanyLayout`),
`src/routes/_authed/$companySlug/_panel/route.tsx` (pathless panel
chrome), and a section folder such as
`src/routes/_authed/$companySlug/_panel/orders/` (`route.tsx` list
layout + `index.tsx` exact list). Template editor lives under `_full`.

## State ownership

No global store (no Zustand, no copied server state). Four owners:

| Owner                           | What                                                                                                                                                                |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Router URL / search             | Navigation, selected record, list tabs, filters, dialog flags                                                                                                       |
| TanStack Query                  | Server state. Keys always include action name, company/account scope, and semantic input. Do not persist the cache.                                                 |
| React Hook Form                 | Form fields (ADR-0030). Already installed with Zod resolvers. The existing onboarding planner in `features/companies/onboarding/` remains an allowed local pattern. |
| Local `useState` / `useReducer` | Ephemeral UI (dialogs, OTP session, tab chrome that is not a route)                                                                                                 |

Do not keep a parallel `clientErrors` pile when RHF `formState` exists.
Do not put selection ids in React state when they belong in the URL.

## FE↔BE

One data path:

- Typed oRPC via `createShowzyClient` → `/rpc`. No hand-written RPC
  paths. Session cookies: `credentials: "include"` in `src/api/client.ts`.
- Tenant selector: URL slug → `companies.listMine` →
  `setActiveCompany` → `x-company-id`. The slug is not an access grant
  (ADR-0013).
- Reads: `contractQueryOptions` / `contractQueryKey` /
  `accountContractQueryOptions`. Company-scoped **keys** include
  `useActiveCompany().activeCompanyId` (React state, so a switch
  re-renders). Account reads (copy `features/companies/api/list-mine.ts`)
  include the session user id. The **assert** is
  `() => client.getActiveCompany()` (live `x-company-id`), never a
  render-closed React id. Golden `companyGetQueryOptions({ client, companyId })`
  binds that getter; do not pass `() => activeCompanyId`.
- Prefetch: route `loader` reuses those options (`ensureQueryData`).
  `_authed` prefetches `listMineQueryOptions` so the picker/scope hooks
  do not issue a second `/rpc`. Do not invent a second cache.
- Mutations: `useContractMutation` / `createContractMutationController`.
  One `createMutationAttempt()` per logical submit; `retry()` reuses
  `attempt.options`. A new submit mints a new key.
- Confirmation: `CONFIRMATION_REQUIRED` → `confirm(challengeId)` on the
  same attempt (`withChallenge`, contract.md §3). Do not put the
  challenge in action input. `confirmationFromError` reads wire extras
  by `error.code`.
- Errors: `describeQueryFailure` / `describeWireCode` on `error.code`,
  never message text.
- Invalidation: invalidate or `setQueryData` only the keys that write
  changed (see `applyCreatedCompany` in
  `features/companies/onboarding/create-company-form.ts`).
- Money: `moneyToWire` / `moneyFromWire` only.
- Views receive data and callbacks. They do not import the contract
  client.

## Extraction

Keep code feature-local until a **third** real repetition. Do not build
a universal form kit, page framework, repository, or view-model layer.
Do not clone `apps/mobile/src/components/form-kit` into web "for
symmetry".

## Testing

- Assert public behavior (URL, headings, buttons, `/rpc` traffic).
- Mock `/rpc` and `/api/auth` with MSW (`src/test/msw.ts`) or a
  feature `api/` function boundary. Never mock internal modules of
  the unit under test.
- Colocate `*.test.ts(x)` with the owner. Cross-feature route tests live
  under `src/test/integration/` and use `renderApp` from
  `src/test/render.tsx`.
- Playwright smoke lives in `e2e/` and is the GitHub Actions `e2e-smoke`
  job: it launches the **built/served** SPA (`vite preview`) and
  intercepts `/rpc` + `/api/auth` in the browser. Do not add a production
  auth bypass. Do not grow this into a domain E2E suite.
- Copy `src/test/integration/app.test.tsx` and `features/companies/onboarding/create-company-mutation.test.ts`.

## Stop-conditions

Halt and ask; do not invent a workaround:

- New backend action, event, table, principal, or authorization rule.
- URL or product UX change beyond preserving/fixing approved panel
  behavior.
- Zustand / XState / global server-state duplication.
- Replacing oRPC / TanStack Query or adding handwritten REST/`fetch`.
- Universal form, page, repository, or view-model framework.
- Hand-editing `src/routeTree.gen.ts`.
- Auth, cookie, proxy, or CORS changes.
- Creating empty folders or abstractions for hypothetical reuse.
- Loading Expo / mobile skills and copying that stack into web.
- Production routing/data behavior change in a documentation-only
  ticket.

## Implementation recipes

Use the architecture manual's [list](../../docs/design/web-panel-architecture.md#list-page),
[detail](../../docs/design/web-panel-architecture.md#detail-route),
[mutation](../../docs/design/web-panel-architecture.md#form-mutation), and
[integration test](../../docs/design/web-panel-architecture.md#route-integration-test)
recipes with the existing companies feature. The manual owns these
examples; do not duplicate them here.
