# Documentation map

Start with the root [AGENTS.md](../AGENTS.md), the instructions nearest
the files being changed, and the task's context pack. Read the relevant
manual sections on demand; this directory is not a mandatory reading list.

## Which source answers which question?

| Question | Source | Scope |
| --- | --- | --- |
| What are we building, and in what sequence? | [Blueprint](blueprint.md), [scope](scope.md) | Approved destination and release boundaries; not a shipped-feature inventory |
| Why is a technical decision binding? | [Accepted ADRs](adr/README.md) | Check the decision's own status and superseding ADRs |
| What owns a table or capability? | [Module ownership](module-ownership.md) | Ownership and sanctioned composition boundaries |
| What must this feature do? | Approved Linear feature card, `*.contract.ts`, DoD tests | Current work and executable domain behavior; do not create new module spec novels |
| How does a foundation protocol work? | [Protocol manuals](specs/README.md) | Runtime, DB, client boundary, money, security, RBAC |
| How do agents plan, implement, and review? | [Pipeline](pipeline.md), [Cursor commands](../.cursor/commands/), [rules](../.cursor/rules/) | Workflow overview, executable command instructions, mandatory guardrails |
| How should a screen look and behave? | [Design entry point](design/README.md) | Canvas, port rules, recorded UX approval; app-specific architecture |
| How do we operate or recover the system? | [Operations](operations/) | Backups, restore drills, incidents, alerts, CI, branch protection |
| What did V1 contain? | [V1 audit](reference/v1-backend-audit.md), [migration matrix](reference/v1-migration-matrix.md) | Read-only evidence; V2 schema is in `packages/db/src/schema/` |
| What have we researched about external tax/bank systems? | [Tax reference](reference/tax/README.md) | Dated evidence, verification levels, open questions; not implementation approval |
| Where did the old specs/plans go? | `docs/archive/` | Historical, not authority; normal implementation must not load it (ADR-0033) |

Accepted ADRs and repository prohibitions constrain feature cards and
code. A test or a newer file is not permission to override an ADR. If
sources disagree, report the concrete conflict; architectural changes
need an accepted superseding ADR. Protocol corrections follow the
[manual update rule](specs/README.md).

## Reading by task

- **Backend:** feature card → relevant contracts/actions and tests →
  ownership map → required protocol sections. Use the current references
  in [Golden slices](pipeline.md#golden-slices).
- **Mobile:** [app instructions](../apps/mobile/AGENTS.md) → mobile skill
  router → feature-local instructions → canvas mapping and gate evidence.
- **Web:** [app instructions](../apps/web/AGENTS.md) → web skill router →
  [architecture](design/web-panel-architecture.md) and web canvas mapping.
- **Operations:** the specific runbook plus current workflow/configuration.
  A documented procedure is not proof that production has executed it.

## Keep documentation maintainable

- `AGENTS.md` holds local guardrails and navigation. Protocol algorithms
  belong in `docs/specs/`; workflow details belong in commands; avoid
  copying their full bodies into every entry point.
- Link to checked-in contracts, helpers, and tests for copyable examples.
  Label illustrative or future examples explicitly. Do not maintain a
  second action schema or a full live source-tree inventory in prose.
- Keep work status and approval evidence on the relevant Linear card.
  If a document records a snapshot, date it and name its scope; do not
  present an old `In Progress` or closed gate as a permanent rule.
- Prefer relative Markdown links and section headings to line numbers.
  Repair links when moving files and update the ADR index when status changes.
- Length alone is not a deletion criterion. The core protocol, design
  research, tax references, and V1 SQL/type snapshots have different jobs.
  Use section links for long manuals; read research/reference files only
  when relevant. Do not split a protocol merely to hit a line count.
- Archive obsolete decisions/plans only with their historical status and
  replacement identified. V1 snapshots remain read-only references;
  approved decisions are superseded through ADRs, not erased.
