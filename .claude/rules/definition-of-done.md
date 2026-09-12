# Definition of done

A task (one branch = one PR) is done only when all of the following hold.
The size budget is 400 changed source lines, tests and generated files and
markdown excluded (`CLAUDE.md` -> Ticket size).

1. **Required tests** — tests-required, not tests-first-or-fail:
   - **New/changed actions:** happy path; mode-appropriate authorization
     denial (`staff` permission, `customer` ownership, `public` visibility,
     or `system` scope); validation failure; cross-tenant isolation;
     idempotency/confirmation/event cases required by the action metadata.
   - **Schema / config / tooling / migrations:** tests that prove the change
     (constraints, drift, boot). A red-then-green ritual is not required.
   - Tests assert behavior, not mocks. Do not weaken or delete tests to pass.
   - Schema columns freeze when their schema PR merges.
2. **CI is green**: format + secret/dependency checks → `tsc --noEmit` →
   ESLint (boundaries, no `any`) → Vitest (unit + integration with
   Testcontainers Postgres) → contract check (mandatory metadata including
   `principal`, transport exposure/resolvers/callbacks valid, contract and
   implementation paired) → migration drift/schema checks → e2e smoke.
   Locally: `node .claude/scripts/verify.mjs` runs the code gates (secret
   scan and dependency audit run in CI only).
3. **The feature card is satisfied** — behavior matches the Linear feature
   card and the `*.contract.ts` files in the PR (ADR-0023). Stop for a product
   fork (new capability, new principal, invariant, new table the card did not
   name). Amend mechanical contract detail in the same PR (timeout/rate-limit
   defaults, a Zod refine a test proved, a CHECK/column the card implied).
4. **Runtime protocols are real** — output validation, idempotency,
   confirmation, events, tenant scope, and audit implied by the action
   metadata are implemented and tested, not just declared.
5. **PR description** states: the Linear ticket / feature card, what was
   tested, and any deviations or open questions; for a bug fix, the root
   cause and why the fix sits at that level.
