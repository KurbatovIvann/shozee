---
paths:
  - "apps/web/**"
---

# Web panel (apps/web)

Before writing or editing files under `apps/web`, load the `showzy-web` skill
(`.claude/skills/showzy-web/SKILL.md`) and read `apps/web/AGENTS.md`. Skills
are advisory: the constitution, ADRs, and `apps/web/AGENTS.md` win. Do not
follow vendored advice to use Next.js App Router, NativeWind, Zustand, raw
`fetch`, or to hand-edit `src/routeTree.gen.ts`.

## Magic Patterns → web panel port

Canonical rule: `docs/design/mapping/mp-to-web.md`. Chrome lock:
`docs/design/mapping/web-panel-chrome.md`. Decisions: ADR-0024, ADR-0030.
Canvas: https://www.magicpatterns.com/c/fdsqxjz1djvww5spay7zey — the mobile
canvas is a different file; do not port web screens from it.

Before writing a product screen:

1. Magic Patterns MCP: `get_design_status` on that editor id, then read
   `canvas.manifest.js`. Find the Screens entry for this surface.
2. Read the canvas files that render that `state.screen` (list, detail,
   create, picker — not only the happy-path panel).
3. Classify **shared** vs **feature**. Shared (Button, StatusPill,
   PaneHeader, DetailStage, Field, Dialog) → `src/components/ui/`. Feature →
   `src/features/<area>/{list,detail,form,shared}/`.
4. Bind color/space/radius/type to `src/theme/`. No hardcoded hex.
5. If the surface is missing from `canvas.manifest.js`, stop and design it
   there first (new ScreenId). Do not invent layout from chrome.md.

Do not paste Tailwind, `react-router-dom`, `PrototypeSwitcher`, or mock
`data/*.ts`. Do not activate a Magic Patterns design-system preset. If MCP
auth fails, stop — do not implement the screen from prose. Google and guest
login on any prototype must not ship (ADR-0006).
