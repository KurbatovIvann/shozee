# Spec: security and operations foundation

> Status: Active. Approved by: owner, 2026-08-18.
> Active surface: entire file.
> Ledger catch-up: first merged auth/ops implementation (fnd-T6, fnd-T26…T28).
> Applies to phase 0 and every module. Written against blueprint §2.1/§3/§7,
> ADR-0006, ADR-0009, ADR-0010, ADR-0012, ADR-0013, ADR-0018, ADR-0020,
> ADR-0021, ADR-0022, and foundation specs.

## 1. Data classification and trust boundaries

- **Public:** allowlisted published company/catalog/profile/comment facts and
  aggregate social counters.
- **Internal:** non-public business configuration and operational metadata.
- **Personal:** phone, email, names, addresses, chat, device identifiers.
- **Financial/legal:** requisites, orders, documents, payments, bank data.
- **Cryptographic/secret:** sessions, OTPs, API/provider credentials, QES
  private keys. QES private keys never enter the server boundary.

### Authorization matrix (principal x classification)

| Classification | `staff` | `customer` | `public` | `consumer` | `account` | `share` | `system` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **Public** (published facts) | Yes, within verified membership company | Yes, via typed `resolveTarget` visibility | Yes — target resolver or declared global published projection; unpublished/internal fields forbidden | Yes — **global published-only discovery**; no company scope; unpublished/draft/internal facts forbidden | Yes — may read published facts while listing companies or bootstrapping; no company scope | Yes — typed `resolveTarget` over hashed capability token; fields outside the owning spec's share allowlist forbidden | Per explicit `systemScope` |
| **Internal** | Permission-gated | No | No | No | No | No | Per explicit scope / job |
| **Personal** | Permission-gated or self | Own resources only | No | No (session identity for auth/rate-limit only; never CRM/PII discovery leakage) | Own-user resources only (personal profile, own company list) | No (no session; never CRM/PII) | Per explicit scope / job |
| **Financial/legal** | Permission-gated | Own orders/docs/payments only | No | No | No | Yes — only the token-bound document/artifact the owning spec allowlists; no other orders/docs/payments | Per explicit scope / job |
| **Cryptographic/secret** | Never returned to clients; server-side handling only | Never | Never | Never | Never | Never; QES keys never enter the server; raw token never returned | Constrained server jobs only; QES keys never enter the server |

Notes:
- Classification **Public** (published facts) is not the same as principal `public`.
- Public-global actions are anonymous, projection-only, read-only, unaudited,
  event-free, and rate-limited by rotating IP HMAC. Public-target actions
  retain typed target resolution (ADR-0020).
- `consumer` actions never create CRM records, never write audit, never emit
  events (ADR-0018; enforced by core contract check).
- `account` actions are scoped to own-user data; `permissions` must be `[]`
  (no company RBAC applies); they may perform writes (create company, update
  personal profile) unlike `consumer`. `account` actions must not access
  another user's data or company-scoped resources (ADR-0013).
- `share` actions are unauthenticated capability-token holders (ADR-0022).
  Company scope comes only from typed `resolveTarget` over the hashed token
  (a selector, never a `companyId` grant). `public` stays read-only; share
  may write when the owning spec allowlists it. Access-log actor is
  `anonymous`; durable audit/events use `actorType: system` and
  `actorId: "share"` (`audit_log` CHECK is `user|system`). Raw token never
  appears in logs, audit, or events. Expired, revoked, or mismatched tokens
  are indistinguishable `NotFoundError`. Co-sign (and any other share write)
  MUST NOT create CRM rows.
- Authorization remains in action principal/permissions/target resolution or
  a declared public projection grant (ADR-0009, ADR-0020); this matrix is the
  ops policy those checks must satisfy.

Untrusted inputs include every client field, chat/catalog/document content,
file upload, webhook, provider response, queue payload, event payload, and AI
tool result. Zod validation is necessary but never grants tenant access.

### Discovery and social surface security (ADR-0018, ADR-0020, ADR-0022)

- **Information disclosure of unpublished entities:** public-global and
  consumer discovery must never surface draft/unpublished company, product,
  or comment data, or fields outside the response allowlist. Publication
  predicates are enforced in search projections and validated by inherited
  isolation suites (core.md §12). Errors for absent/unpublished entities
  must be indistinguishable (same error shape, same status code) to prevent
  enumeration of unpublished entity IDs.
- **CRM/identity leakage prevention:** discovery must not reveal whether a
  browsing user has a CRM record in any company, nor expose personal data of
  other users, follower/liker identities, private collections, order counts,
  or chat history. Projections never store CRM state or identity collections.
- **Rate/scraping abuse:** public uses 30/min per rotating IP HMAC; consumer
  uses 60/min per user. Both require bounded pagination and monitoring for
  sustained extraction; raw IP never enters domain logs.
- **Social write abuse:** follow/like use authenticated desired-state writes
  with idempotency and target visibility checks. Comments/replies have
  bounded length/depth, normalized/sanitized text, author/staff authorization,
  per-user/action rate overrides, and moderation logging. Counter updates and
  own-user collections must remain transactionally consistent under retries.
- **Account principal write scope:** `account` actions can create companies
  and modify personal profile. Abuse vector: mass company creation. Defended
  by rate limiting, optional CAPTCHA/verification on company creation, and
  monitoring for anomalous creation patterns.
- **Share-token abuse (ADR-0022):** unauthenticated writes are allowlisted
  only. Rate-limited 30/min per rotating IP HMAC, fail-closed on Redis
  failure (reads and writes). Token A cannot read or write token B's
  resource. A present session on a share invocation is ignored (no extra
  access; log actor stays `anonymous`). AI never lists share tools.
- **Atomic capability boundary (ADR-0021):** `ctx.callAtomic` is never a
  transport route. CI and runtime require a mutually declared caller/callee
  edge, matching principal and verified tenant, one root transaction, and no
  nested atomic call. Callee authorization/audit still run; the capability
  cannot widen schema ownership or grant access.

## 2. Authentication and sessions

- Better-auth is the only session authority. OTP codes never persist to
  Postgres — they live only in TTL'd secondary storage (Redis), hashed where
  the plugin supports it — expire after 5 minutes, allow at most 5
  verification attempts, resend no faster than 60 seconds, and are never
  logged. Sessions are stored in Postgres.
- Default OTP limits: 5 sends/hour per phone and 20/hour per
  trusted-proxy-normalized IP, plus provider abuse controls. Variant A: the
  Better Auth IP consume key (`${ip}|${path}`) is stored as
  HMAC-SHA256(`IP_HMAC_SECRET`, key) hex truncated to 32 characters — **no
  24h rotation** (unlike public/share action buckets in core.md §10), so the
  20-send window does not reset at a rotation boundary. Redis never stores
  the raw address. Identifier keys (`otp-send:phone:…` / `otp-send:email:…`)
  are not HMAC'd. Responses do not disclose whether an account exists.
- Cookie sessions use `Secure`, `HttpOnly`, and appropriate `SameSite`. Expo
  clients persist those cookies in OS secure storage (`@better-auth/expo`)
  and replay them as a `Cookie` header. Bearer tokens remain supported for
  non-RN callers. Sessions last 7 days and slide after 1 day of activity
  (`get-session` / authenticated `/rpc`). Session/device list and remote
  revocation are required before launch.
- Password/session/token changes invalidate affected sessions. High-risk
  actions may require recent authentication in addition to core confirmation.
- Staff active-company headers remain selectors verified against membership
  on every action (ADR-0013). Share capability tokens travel as action input
  (hashed by `resolveTarget`), never as `x-company-id` or a session
  (contract.md §3). A present session on a share invocation is ignored.
  Socket.IO/SSE room joins run the same principal/tenant authorization as
  HTTP actions.
- Hono trusts forwarded IP headers only from configured ingress proxies;
  direct/spoofed values are ignored. Rate-limit tiers (defaults owned by
  `docs/specs/core.md` §10; do not fork numbers here):
  - `public` — 30/min per rotating HMAC of trusted-proxy-normalized IP;
  - `share` — 30/min per rotating HMAC of trusted-proxy-normalized IP
    (same class as `public`; fail-closed on Redis failure for reads and
    writes);
  - `consumer` — 60/min per authenticated user (read-only discovery; tighter
    than staff/customer, looser than public);
  - `account` — 90/min per authenticated user (moderate; own-user writes
    need more headroom than read-only consumer discovery);
  - `customer` / `staff` — 120/min per user;
  - `system` — unlimited (job policy may still bound outbound calls).

  Raw IP is transport-only: never the Redis key for authenticated principals,
  and never copied into domain logs/audit. Redis failure (owned by core.md
  §10; do not fork here): fail-closed for public actions, every share action
  (reads and writes), and every mutation (`draft`/`write`/`high`); fail-open
  with an error log for ordinary authenticated reads (`risk: read` on
  staff/customer/consumer/account). System actions default to fail-open.

## 3. Files and object storage

- Clients never choose object keys. `files` issues short-lived signed uploads
  under a server-derived company/owner prefix, with single-use finalize.
- Every action declares size and MIME allowlists. Foundation defaults:
  10 MiB images, 25 MiB PDF/document/chat files; a module may lower them.
- Finalization verifies size, magic bytes, declared MIME, checksum, ownership,
  and object prefix. Executables and archives are denied by default.
- New uploads remain non-public/quarantined until validation and malware
  scanning pass. Scanner selection/dependency requires human approval.
- Downloads are signed, short-lived, disposition-safe, and authorization is
  rechecked when the URL is issued. Object keys and signed URLs are not
  durable action/idempotency outputs.

## 4. External services and webhooks

- Secrets come through validated env/secret management and are redacted by
  key/path policy before logs, Sentry, events, or audit.
- Webhooks verify signature, timestamp/replay window, provider account, and
  payload before constructing a system context. Provider delivery ID is the
  idempotency key.
- `pki-proxy` accepts no arbitrary destination URL. Host, scheme, port, path,
  redirects, DNS resolution, and private/link-local IP ranges are checked
  against an explicit allowlist to prevent SSRF.
- Outbound calls have timeouts, bounded retries with jitter, circuit/alert
  behavior, and correlation IDs. Retrying a side effect requires provider
  idempotency or reconciliation.
- **Invocation `channel` (phase 0):** every HTTP transport invocation —
  oRPC at `/rpc` and OpenAPI REST aliases at `/api/v1` — is labeled
  `channel: "ui"`. `POST /assistant/kit/*` uses `channel: "ai"`. Webhooks
  and workers set `system` / `webhook` when those mounts exist. Do not add
  a client-spoofable `x-channel` header on `/rpc`.

## 5. Environments, database, and release safety

- Production/staging/dev use separate credentials, buckets, Redis, databases,
  and provider projects. Production data is not copied to lower environments
  without an approved anonymization procedure.
- Runtime and migration DB roles, PITR, RPO/RTO, destructive migration policy,
  and restore drills follow `docs/specs/db.md`.
- Deploy order: compatible migration → application → deferred cleanup.
  Forward-only recovery never assumes an unsafe schema rollback.
- A staging migration rehearsal and reconciliation report are mandatory for
  every release containing a data migration; the full v1 cutover is rehearsed
  at least twice before launch.

## 6. Logging, detection, and incident response

- Structured logs contain request/correlation/action/accountable actor/channel
  and resolved company scope when present. For public-global, `consumer`,
  `account`, and declared global `system` work, `company_id` is null.
  Public-global uses log actor `anonymous`; public-target additionally carries
  its resolved company. Consumer/account lines carry accountable user actor.
  Share uses log actor `anonymous` with `company_id` from the resolved target.
  Durable audit rows and domain events for share writes use `actorType:
  system` and `actorId: "share"` — never `anonymous` (db.md `audit_log`
  CHECK is `user|system`). Consumer actions never write durable audit rows
  or domain events; `account` actions may write audit when declared
  (`audit: true`); share writes must (`audit: true` + redacted certificate
  `auditSnapshot`). Logs never contain raw OTPs, tokens (including share
  capability tokens), secrets, full documents, raw payment/webhook
  payloads, or unredacted personal input.
- Alert on sustained auth/rate-limit abuse, dead event deliveries, queue
  exhaustion, payment/provider reconciliation failures, backup failure,
  elevated 5xx, and cross-tenant invariant failures. Phase-0 wiring notes:
  [`docs/operations/alerts.md`](../operations/alerts.md). Backups and PITR:
  [`docs/operations/backups.md`](../operations/backups.md). Restore drill:
  [`docs/operations/restore-drill.md`](../operations/restore-drill.md).
  Incident response skeleton:
  [`docs/operations/incident-response.md`](../operations/incident-response.md).
  Process logs and Sentry payloads are scrubbed by `@showzy/config`
  (`createProcessLogger`, `scrubTelemetryEvent`).
- Severity, owner, containment, credential rotation, customer notification,
  evidence preservation, and post-incident review are documented in the
  production runbook before launch.

## 7. CI and dependency controls

Every PR runs formatting, typecheck, ESLint/boundaries, unit/integration,
contract/event checks, migration drift/safety, secret scanning, and dependency
review. Lockfiles are committed. A new runtime dependency or external service
requires explicit human approval and a reason in the PR.

Sensitive changes (auth, payments, QES, webhooks, file authorization,
tenant/runtime protocols) require a separate security review and full human
review. A critical/high unresolved finding blocks merge.

## 8. Acceptance criteria

- [ ] OTP expiry/attempt/send/IP limits and non-enumerating responses are
      integration-tested.
- [ ] Session revocation and unauthorized Socket.IO/SSE room join are tested.
- [ ] Signed upload cannot cross company/owner prefix; size/MIME/magic-byte
      mismatch and executable/archive uploads fail.
- [ ] Webhook replay/invalid signature cannot create a system context.
- [ ] pki-proxy tests block redirects and public-host DNS rebinding to private,
      loopback, link-local, or metadata addresses.
- [ ] Redaction tests prove representative secrets/PII never reach logs,
      Sentry, events, or audit.
- [ ] Runtime DB role, backup restore drill, migration rehearsal, and
      reconciliation gates pass before launch.
- [ ] CI secret/dependency/security gates cannot be bypassed by ordinary PRs.
- [ ] Consumer principal: unpublished/internal/personal/financial facts are
      denied; no CRM side effects; no audit/event emission (integration).
- [ ] Public-global: unpublished/non-allowlisted fields denied; no CRM/domain
      side effects, resolver, audit, event, or foreign projection access;
      anonymous null-company log and 30/min IP-HMAC limit verified.
- [ ] Consumer rate limit defaults to 60/min per user; public remains IP-HMAC
      keyed; raw IP absent from domain logs (test).
- [ ] Consumer structured logs include request/actor/channel with null
      company_id (test).
- [ ] Account principal: cannot access another user's companies or personal
      data; cannot access company-scoped resources; structured logs include
      request/actor/channel with null company_id (test).
- [ ] Account rate limit defaults to 90/min per user (test).
- [ ] Share principal: token A cannot read/write token B's resource;
      expired/revoked/mismatch are indistinguishable `NotFoundError`;
      no CRM side effects; raw token absent from logs/audit/events (test).
- [ ] Share rate limit defaults to 30/min per IP-HMAC; Redis failure
      fail-closed for share reads and writes (test).
- [ ] Share structured logs use actor `anonymous` with resolved company_id;
      share-write audit/event actor is `system`/`share` (test).
- [ ] Discovery surface: unpublished entity requests return indistinguishable
      errors; projection responses contain no CRM/personal data or
      follower/liker identities (test).
- [ ] Social writes: desired-state retries do not duplicate counters/events;
      user A cannot read user B's private collections; comment abuse,
      author/staff moderation, and cross-company target denials are tested.
- [ ] Atomic capability: client invocation, undeclared edge, tenant/principal
      mismatch, nested call, and foreign-schema access are rejected.

## Changelog

| Date | Change | Why | Reported by |
| --- | --- | --- | --- |
| 2026-09-01 | §4: `POST /assistant/chat` uses `channel: "ai"`; `/rpc` and `/api/v1` stay `ui` | Staff AI SSE mount (SHO-322 / SHO-318) | SHO-322 |
| 2026-08-25 | §2: OTP IP cap remains 20/hour per trusted-proxy IP; Redis stores HMAC-SHA256 of the Better Auth consume key (32 hex chars, no 24h rotation) | Variant A (SHO-147): Redis must not retain client IPs of OTP senders; rotation would reset the 20-send bucket | SHO-147 |
| 2026-08-21 | Session TTL 7d / sliding 1d; Expo cookie origin `showzy://`; bearer kept for non-RN | Pin better-auth defaults; mobile uses `@better-auth/expo` cookies | owner |
| 2026-08-19 | Seventh principal `share` (ADR-0022): matrix column, 30/min IP-HMAC fail-closed, access-log `anonymous` vs audit/event `system`/`share` | Unauthenticated capability-token writes for owner-first dual-sign; core.md and contract.md already amended | owner via `/rework-spec security-operations.md` |
| 2026-08-19 | Status: Active; Active surface: entire file | Ledger catch-up: first merged auth/ops (fnd-T6, fnd-T26…T28) | owner via spec-process-after-phase-0 |
| 2026-08-19 | §4: phase-0 HTTP invocations (including `/api/v1` REST aliases) are `channel: "ui"`; revisit when external consumers or the AI mount land | Align living spec with the API composition (fnd-G1 A12) | scaffold (fnd-G1 A12) |
| 2026-08-18 | Linked ops runbooks and log/Sentry redaction helpers | fnd-T28 security/ops baseline | scaffold (fnd-T28) |
| 2026-08-17 | Added public projection, bounded social-abuse, and atomic capability security controls | Align foundation with ADR-0020/0021 mobile parity | Human owner via mobile parity rework |
| 2026-08-17 | Added `account` principal to authorization matrix, rate-limit tiers, logging classification; added discovery surface security considerations | Complete Step 2 of spec-rework queue (ADR-0018 integration) | Spec-rework agent |
| 2026-08-17 | Added consumer authorization/classification matrix, rate-limit tiers, and null-company logging rules | Align security and operations with ADR-0018 consumer discovery | Human owner via spec-rework queue |
| 2026-08-17 | Initial foundation draft | Close phase-0 security/operations contract gap | GPT-5.6 Sol |
