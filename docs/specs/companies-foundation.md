# Spec: companies foundation schema slice

> Status: Active. Approved by: owner, 2026-08-17.
> Active surface: entire file.
> This is a deliberately minimal phase-0 prerequisite, not the full companies
> module spec. It creates tenant/RBAC identity required by core tests, plus
> the 1:1 `company_legal_info` table named by SHO-222.

## 1. Purpose and boundary

This slice gives core a real tenant root and membership/permission model.
`companies` owns the tables in `packages/db/src/schema/companies.ts`; they
never move into `foundation.ts`. Onboarding, profile, taxonomy, publication,
team-management actions, and UI remain in the later full companies spec.
Seller legal requisites live in `company_legal_info` in this same file
(SHO-222 / SHO-223) — not columns on `companies`, and not on
`counterparties` / `customer_legal_profiles`.

## 2. Tables

`companies`: `id uuid` PK, `name text`, unique `slug text`, unique
`prefix text`, `created_at`, `updated_at`. The foundation slice adds no
profile/search/geo/counter/embedding columns.

`company_members`: `id uuid` PK, `company_id uuid` FK to companies
(`ON DELETE CASCADE`), `user_id` using the generated better-auth user ID type
(`ON DELETE RESTRICT`), `role text CHECK
(owner|admin|manager|employee)`, `permissions jsonb` with canonical
`{ granted: string[], denied: string[] }`, timestamps, unique
`(company_id, user_id)`, unique `(company_id, id)` (ADR-0025 FK target).
Indexes `(user_id, company_id)` and `(company_id, role)`.

`company_legal_info`: 1:1 seller legal face. `id uuid` PK, `company_id uuid`
FK to companies (`ON DELETE CASCADE`) **UNIQUE** (one row per company),
unique `(company_id, id)` (ADR-0025), `company_type text NOT NULL` default
`fop` CHECK (`fop` | `tov`), nullable text `legal_name`, `edrpou`,
`legal_address`, `iban`, `bank_name`, `bank_mfo`, `bank_edrpou`, `phone`,
`email`, timestamps. No row is required at company create — absence is
“legal not yet filled”. No backfill.

`role_permission_defaults`: global seed table, `role text`, `permission text`,
PK `(role, permission)`. Owner has all known permissions implicitly; explicit
deny wins, then explicit grant, then role default. Unknown permission keys
fail the action contract/catalog check. Admin is seeded `settings:payments`
(SHO-223); manager and employee are not.

Precedence, amended 2026-10-02 (SHO-830, ADR-0015): a permission declares
the **prerequisites** its job needs — `pricing:manage` requires
`products:view`, because a price list cannot be changed without seeing the
products. The declaration is `PERMISSION_PREREQUISITES` in
`packages/core/src/runtime/context/permission-prerequisites.ts`; the stored
rows (`role_permission_defaults`, `company_members.permissions`) keep only
what was granted. The effective set of a membership is therefore:

1. an explicit deny removes the denied permission **and, transitively,
   every permission that requires it** — deny stays the strongest rule;
2. role defaults plus explicit grants that survived (1);
3. the closure of (2) over `PERMISSION_PREREQUISITES`.

`resolveEffectivePermissions` is the only place this is computed, and
`staffHasPermission` is the only read API; the owner short-circuit is
unchanged, so no deny row binds an owner. A resolved set never holds a job
without the reads that job performs, which is what `ctx.call` re-checks
inside the caller's transaction.

The invariant “a company has at least one owner” is enforced by later
companies actions/transactions, not a hidden DB trigger. Test factories may
insert fixtures directly only under the test harness.

## 3. v1 migration slice

- `companies`: TRANSFORM from
  `20260301000003_companies.sql`; carry only id/name/slug/prefix/timestamps in
  phase 0. Profile/FTS fields wait for the full spec; embeddings and
  denormalized social counters drop. Seller legal is `company_legal_info`,
  not columns on `companies`.
- `company_legal_info`: TRANSFORM from
  `20260320000004_company_legal_info.sql` (SHO-223). RLS policies drop in
  favor of action permissions. No backfill — v1 seeded from
  `payment_settings`, which does not exist here.
- `company_members`, `role_permission_defaults`: TRANSFORM from
  `20260301000005_company_members.sql`; Supabase `users.id` FKs are remapped
  to better-auth IDs. SQL permission helpers/RLS policies drop in favor of
  core factories and action checks.
- Business-category REVIEW rows in the global matrix are outside this slice
  and do not authorize importing those tables.

## 4. Acceptance criteria

- [ ] Staff context derives company only from a membership matching
      authenticated user + selected company; missing/foreign membership is
      denied.
- [ ] Owner/default/granted/denied precedence matches the rule above.
- [ ] Cross-company role/override rows cannot influence another company.
- [ ] Runtime role can read membership for authorization but no client route
      or client bundle can reach these tables.
- [ ] Schema/migration tests use the generated better-auth ID type without
      casts and reconcile v1 member user IDs through the auth mapping.
- [ ] Full companies spec can add profile/publication fields without moving
      or renaming the foundation tables.

## Changelog

| Date | Change | Why | Reported by |
| --- | --- | --- | --- |
| 2026-10-02 | Permission prerequisites: the effective set is the closure of defaults + grants, and a deny removes dependents | A permission to do a job implies the reads that job needs (SHO-822/SHO-829 were the same hidden requirement twice) | Human owner (SHO-830) |
| 2026-08-29 | Named `company_legal_info` in this file; admin `settings:payments` seed | SHO-222 / SHO-223 seller legal face; table the card named | companies-T3 (SHO-223) |
| 2026-08-20 | `company_members` unique `(company_id, id)` | Match ADR-0025 tenant FK-target convention | Human owner |
| 2026-08-17 | Initial foundation slice | Unblock staff principal integration without giving core domain ownership | GPT-5.6 Sol |
