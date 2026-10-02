# ADR-0015: Cross-module composition — internal calls for queries, events for effects

- **Status**: Accepted
- **Date**: 2026-08-17
- **Deciders**: owner (+ Claude Fable 5, foundation review)
- **Amended by**: ADR-0021
- **Amended**: 2026-10-02 — a permission implies the reads its job needs
  (SHO-830, see Amendment below)
- **See also**: ADR-0033 (task-complete lists/writes; missing match/resolve is an owner-module internal read, not a join)

## Context

The conventions said "cross-module effects go through domain events, not
direct imports" — correct for effects, but silent about **synchronous
reads**. `orders.create` must synchronously resolve prices from `pricing`
and validate products from `catalog` before persisting money snapshots
(invariant §2.1-3); an asynchronous event cannot return a value. `search`
(FTS) and `analytics` need read access across many modules' tables. Left
undefined, agents will either import other modules' services directly,
duplicate pricing logic, or abuse events as RPC.

## Decision

Three sanctioned composition channels, and no others:

1. **Asynchronous effects → domain events** (unchanged). Anything that
   *changes* another module's state or triggers side effects goes through
   the transactional outbox. A module never synchronously invokes another
   module's write, except through the narrowly declared same-transaction
   atomic capability defined by ADR-0021.
2. **Synchronous reads → internal action invocation.** An action handler may
   call another module's action via the registry: `ctx.call(action, input)`.
   Constraints enforced by `packages/core`:
   - only `risk: "read"` actions are callable cross-module (`ctx.call` of a
     write action from another module is a runtime + CI contract error);
   - the callee must declare the same principal mode as the caller (a
     capability needed by staff and customers is exposed as two thin read
     actions over one module service, per ADR-0013);
   - the callee runs in the **same transaction** and the **same principal
     context; its `permissions`/target resolver are re-evaluated in that
     transaction (defense in depth);
   - customer/public nested resolvers receive the caller's verified company
     scope and must resolve the callee resource to that same company; a
     mismatch is a core invariant failure;
   - the call is recorded in the audit/log trail as a child of the caller
     (correlation + causation ids), sharing the caller's timeout budget;
   - imports go through the callee module's `index.ts` only (actions are
     already its public API) — deep imports stay an ESLint error.
3. **Declared read-model exceptions** for cross-cutting projections
   (`search`, `analytics`): a projection module may run **read-only** queries
   against another module's tables when the owning module's spec explicitly
   grants it (table list recorded in both specs). Writes remain exclusive to
   the owner.

Same-module composition stays free: actions of one module share `services/`.

## Amendment, 2026-10-02 — a permission implies the reads its job needs

Because the callee's `permissions` are re-evaluated inside the call, a
caller carried a hidden permission requirement its own contract never
declared: `pricing.setPriceListEntries` declares `pricing:manage` but
failed for a member without `products:view` (SHO-822, SHO-829). The owner's
decision: *if a member may change a price list, they may see the products —
without products they cannot change it.* The access model, not the call,
was wrong.

- Permissions have **prerequisites**, from two sources, both in
  `packages/core/src/runtime/context/permission-prerequisites.ts` and read
  through the one function `permissionPrerequisites`:
  1. **Same resource, structural.** Every non-view `<resource>:<verb>`
     implies `<resource>:view` when that key exists in
     `PERMISSION_CATALOG` — you cannot change what you may not see. It is
     derived from the catalog, not listed by hand; `assistant:use` and
     `settings:payments` have no `:view` sibling and are therefore
     excluded. In-module reads need no `ctx.call` edge, so this source is
     the one the edges cannot show.
  2. **Cross-module, from the declared call graph.**
     `PERMISSION_CALL_PREREQUISITES` holds one pair per declared `ctx.call`
     edge: each callee permission is a prerequisite of the caller's.

  Role defaults (`role_permission_defaults`) and explicit grants stay as
  they are.
- The **effective set is the closure** of role defaults + grants over those
  prerequisites, computed once in `resolveEffectivePermissions`. Nothing
  is written back to the membership row or the defaults table — one
  derivation, at resolution.
- An explicit **deny of a prerequisite also removes every permission that
  requires it**, transitively — a deny of `pricing:view` removes
  `pricing:manage`. Deny stays the strongest rule and the
  resolved set stays consistent: it never holds a job without the reads
  that job performs. Owner-all is unchanged — an owner holds every
  permission and no deny row binds them.
- `ctx.call` keeps re-evaluating the callee's declared permissions. It now
  passes because the caller's effective set contains the prerequisite.
- The contract check gains: for every declared `ctx.call` **and**
  `ctx.callAtomic` edge with a `staff` caller, each callee permission must
  be covered by the closure of the caller's declared permissions. CI names
  the action, the edge and the missing permission.
- One exception, declared per edge as `permissionGuarded: true` in
  composition: the caller checks the callee's permission itself with
  `staffHasPermission` and skips the edge when the member lacks it. Such
  an edge grants nothing, so its permissions are not prerequisites. The
  allowlist is `search.query`'s five per-type reads and nothing else, held
  by a test over the real composition.

The edge-derived pairs include the ones a write's confirmation preview
takes: a job's preview reads what the job reads.

## Alternatives considered

- **Direct import of another module's services** — rejected: bypasses
  permissions, audit, and timeout; invisible coupling that ESLint boundaries
  exist to prevent.
- **Events as request/response (reply events)** — rejected: async machinery
  for a synchronous need; latency, complexity, and transactional integrity
  all suffer.
- **Duplicating logic per module** (each module re-implements price
  resolution) — rejected: guarantees drift in exactly the logic (money) where
  drift is most expensive.
- **A shared "domain services" package outside modules** — rejected: becomes
  an ownerless dumping ground; capabilities must live with their owning
  module.

## Consequences

- `packages/core` implements `ctx.call` with transaction/context propagation
  and the read-only constraint; the reference slices must exercise it
  (orders → pricing is the canonical example).
- Conventions updated: "events over calls" becomes "events for effects,
  `ctx.call` for reads, read-model grants for projections".
- The contract check gains: every cross-module `ctx.call` target is
  `risk: "read"` and principal-compatible; every read-model table grant is
  declared in the owning spec.
- Module specs must list: events consumed, actions called via `ctx.call`,
  and read-model grants — making the dependency graph reviewable.
- Missing match/resolve capability is a new **internal** read on the owning
  module (ADR-0033). Do not join another module’s tables from the caller.
