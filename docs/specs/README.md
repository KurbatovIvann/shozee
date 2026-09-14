# Protocol manuals

These files document **already-frozen** foundation packages. They are not
a `/spec` stage and not a Living/Active/Mixed conveyor (ADR-0023).

New domain work uses `/feature`. The executable contract is
`*.contract.ts` plus the tests in the definition of done. Domain novels
that used to live here are historical files in `docs/archive/specs/`.
Agents must not open that tree unless a human names a file (ADR-0033).

## What stays

| File | Documents |
| --- | --- |
| `core.md` | `packages/core` action runtime |
| `contract.md` | `@showzy/contract` client/server boundary |
| `db.md` | `packages/db` schema conventions, roles, capabilities |
| `jobs.md` | `@showzy/jobs` runner boundary, `pgboss` schema, grants |
| `money.md` | Money snapshot rules |
| `security-operations.md` | Auth, logging, backups, rate-limit numbers |
| `companies-foundation.md` | Companies/RBAC foundation slice |

Change a protocol manual when a test proves it wrong (same PR) or when
an ADR changes the runtime. Do not add new domain modules here.

## What moved

`catalog`, `companies`, `customers`, `orders`, `chat`, `pricing`,
`documents`, `payments`, `search`, `feature-flags`, and the old spec
template live in `docs/archive/specs/` for humans. They are not
authority. Agents use `docs/reference/` for v1 archaeology and must not
open the archive.
