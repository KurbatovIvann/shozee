---
name: showzy-web
description: >
  Showzy staff panel (apps/web): Vite SPA, TanStack Router, TanStack Query,
  Tailwind v4, better-auth browser cookies, typed oRPC client. Use whenever
  editing apps/web, panel routes, feature slices, the contract client, or
  web AGENTS.md. Load this skill before writing web code.
---

# Showzy web skill router

Load this skill **before writing or changing** anything under `apps/web`.
Then read `apps/web/AGENTS.md` and
`docs/design/web-panel-architecture.md`.

## Constitution wins

On any conflict, in this order: `.claude/rules/`, accepted ADRs
(especially ADR-0030), `apps/web/AGENTS.md`, `docs/pipeline.md`, then
this skill.

Do not add npm dependencies. Do not introduce Zustand, XState, a
hand-written REST/`fetch` client, Next.js App Router, NativeWind, or a
universal form/page/view-model framework.

Staff copy (how to add a namespace, shared vs leftover, typed
extensions) lives in `packages/copy/AGENTS.md`. Point there; do not
duplicate the how-to. Feature screens keep importing `src/i18n/<ns>`.

## What to read (web only)

| Task | Read |
| --- | --- |
| Any `apps/web` change | `apps/web/AGENTS.md` |
| Routes, layouts, folder tree | `docs/design/web-panel-architecture.md` |
| Stack / same-origin cookies | `docs/adr/0030-web-panel-spa-and-deferred-storefront.md` |
| Canvas chrome lock | `docs/design/mapping/web-panel-chrome.md` |
| Product screen port | `docs/design/mapping/mp-to-web.md` + Magic Patterns canvas Screens |
| Query keys / mutations | `apps/web/src/api/query-options.ts`, `contract-mutation.ts` |
| Golden feature slice | `apps/web/src/features/companies/` |

## Do not load

Expo skills (`showzy-mobile`, `expo-router`, `expo-native-ui`,
`expo-design-system`, `expo-animation`, `expo-dev-client`,
`vercel-react-native-skills`). This app is not React Native.

Do not load Next.js App Router, `expo-data-fetching`, or storefront
skills. The public storefront is a later app (ADR-0030).

## Placement (one line each)

- URL adapter → `src/routes/` (validate params/search, optional prefetch,
  render a feature page). Parent with children renders `<Outlet />`.
- Product screens → `src/features/<area>/{api,list,detail,form,shared}`.
- Panel chrome → `src/layouts/panel` (layout, not a domain feature).
- App assembly → `src/app/` (`main.tsx`, `router.tsx`, `providers.tsx`,
  `runtime.ts`).
- Generic primitives → `src/components/ui/` (no domain, no panel CSS).
- Contract access → `src/api/` + `features/<area>/api/`. Views never
  call the client.
- Auth infrastructure → `src/auth/`. Auth screens → `features/auth/`.
- Tests: colocated with the owner, or `src/test/` for shared MSW /
  `renderApp` / cross-feature integration (`src/test/integration`).
  Playwright smoke (`e2e/`) intercepts `/rpc` and `/api/auth` against the
  built SPA; it is the `e2e-smoke` CI job, not a domain E2E suite.

Feature subfolders are demand-driven. Do not create empty directories
to match the diagram.

## Hard rules

- Thin route files. No business workflows in `routes/`.
- No pathname prefix parsing or regex to reconstruct hierarchy.
- No direct `fetch` for domain data, no DB/module import, no
  `@showzy/contract/server`.
- Query keys: `[actionName, companyScope, input]` via
  `contractQueryKey` / `contractQueryOptions`.
- One `createMutationAttempt()` per logical submit; retry reuses it.
  `CONFIRMATION_REQUIRED` reuses that attempt via `withChallenge(id)`.
- Never hand-edit `src/routeTree.gen.ts`.
- Test public behavior; mock `/rpc` (MSW) or a feature `api/` boundary.

## Golden data path (list / detail / form)

One request path: feature `api/` adapter → `createShowzyClient` → `/rpc`.
Views never import `src/api/client`. Loaders and hooks share the same
options factory (`ensureQueryData` + `useQuery`).

```ts
// features/companies/api/list-mine.ts — account-scoped
listMineQueryOptions(client, sessionUserId)
// key: [actionName, null-company, sessionUserId, input]

// features/companies/api/get.ts — company-scoped
companyGetQueryOptions({ client, companyId })
// key: [actionName, companyId, input] — companyId from React state
// assert: () => client.getActiveCompany() (live x-company-id)

// routes/_authed.tsx — same factory as useListMine
loader: ({ context }) =>
  context.queryClient.ensureQueryData(
    listMineQueryOptions(context.apiClient, context.session.userId),
  )

// form — one createMutationAttempt per submit
const mutation = useContractMutation(bindCreateCompanyMutate(client))
await mutation.submit(input)          // new attempt
await mutation.retry()                // same attempt.options
await mutation.confirm(challengeId)  // same attempt.withChallenge(id)
applyCreatedCompany({ queryClient, sessionUserId, ... })
// invalidateQueries({ queryKey: listMineQueryKey(sessionUserId) })
```

Copy `features/companies/api/` and `features/companies/onboarding/`.
Do not add a repository/service layer.
