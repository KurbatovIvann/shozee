# ADR-0030: Web panel is a Vite SPA; storefront is a separate later app

- **Status**: Accepted
- **Date**: 2026-08-31
- **Deciders**: Human owner (+ proposing agent)

## Context

The web panel UX is locked: the Magic Patterns web canvas (SHO-262,
[`web-panel-chrome.md`](../design/mapping/web-panel-chrome.md)) defines a
three-pane master–detail chrome for staff operations, an OTP auth flow, and
a public share landing. The backend is client-agnostic by design (ADR-0010):
Hono mounts better-auth at `/api/auth` and the oRPC action router at `/rpc`,
and clients consume the typed `@showzy/contract` client — the mobile app
already does (TanStack Query v5, react-hook-form + Zod, feature folders).

`docs/blueprint.md` names **Next.js App Router** as the post-launch web
stack. That assumption predates the web-panel canvas and conflates two very
different surfaces:

1. **The panel** — authenticated staff tooling. No SEO, no anonymous
   traffic. Its hard problems are multi-level routing (three panes, list
   tabs, full-shell takeovers, dirty-form guards) and URL-addressable state.
2. **The storefront / consumer surface** — public company pages, discovery,
   `/me`. SEO and SSR matter (v1 rendered `/{slug}` with `generateMetadata`,
   OG tags, JSON-LD). Its API surface (`consumer` and public-global
   projections, the `search` module — ADR-0018/0020) does not exist yet.

In v1 both zones lived in one Next.js app but were already path-separated
(`/panel`, `/me`, `/{slug}`) with distinct chrome and users; they shared
little beyond design tokens. Deployment target is a VPS via Coolify
(blueprint §deployment), so a static artifact is cheaper to operate than an
SSR runtime.

## Decision

`apps/web` is the staff panel only: a **Vite + React SPA using TanStack
Router**, talking to `/rpc` through `createContractClient` with better-auth
browser cookies, deployed as static files behind a reverse proxy that serves
`/rpc` and `/api/auth` same-origin (no CORS surface).

The public storefront / consumer surface will be a **separate app in its own
post-launch phase**; its framework (Next.js or TanStack Start) is chosen in
that phase, when its API surface exists.

Panel URLs scope the tenant by **company slug**, not UUID:
`/:companySlug/orders/...`. The slug is resolved client-side against
`companies.listMine`; the verified transport selector remains the
`x-company-id` header. The slug is a display selector, never an access
grant (ADR-0013 unchanged).

## Alternatives considered

- **One Next.js app for panel + storefront (v1 pattern, blueprint
  default)** — rejected: forces an SSR runtime from day one for a surface
  that gains nothing from it, couples panel availability and deploys to
  public bot/crawler traffic, and the storefront cannot start now anyway
  (no `consumer`/`search` API). The zones share only design tokens.
- **TanStack Start now (one SSR-capable app for both, later)** — rejected
  for now: buys SSR the panel does not need from a younger ecosystem;
  remains a candidate for the storefront phase.
- **Company UUID in panel URLs** — rejected by the owner: leaks internal
  identifiers into shareable links; `companies.slug` is already globally
  unique in the shipped schema.
- **Stored-only company selector (mobile prefs pattern) without URL
  scope** — rejected: browser links must be unambiguous and multi-tab
  sessions must support different companies per tab.

## Consequences

- Blueprint's web stack row must be updated to reference this ADR (panel =
  Vite SPA + TanStack Router; storefront framework deferred).
- New client dependencies are approved for `apps/web`: TanStack Router,
  Tailwind CSS v4, selectively vendored shadcn/ui primitives (Radix-based),
  lucide-react. Server state stays TanStack Query v5; forms stay
  react-hook-form + Zod — mirroring `apps/mobile`.
- API prerequisites (part of the web-panel feature card, not a separate
  project): add the web origin to better-auth `trustedOrigins`; document
  the reverse-proxy topology (static + `/rpc` + `/api/auth`); Vite dev
  proxy for local work. No CORS middleware is needed under same-origin.
- The panel gets URL-addressable state (selected record, list tabs,
  filters as typed search params) and route-level dirty-form blocking —
  replacing the prototype's in-memory `selectedId` state machine.
- The existing `/d/:token` share landing remains served by the API until
  the web share route ships; the cutover is a follow-up inside the web
  feature work.
- ESLint `clientApp` boundaries apply to `apps/web` unchanged (imports
  limited to `@showzy/contract`, `@showzy/validation`, `@showzy/copy`,
  `@showzy/ui`, `@showzy/document-signing`).
- When the storefront phase starts, shared design tokens may be extracted
  into a package; premature extraction is explicitly avoided.
