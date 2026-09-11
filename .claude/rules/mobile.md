---
paths:
  - "apps/mobile/**"
---

# Mobile app (apps/mobile)

Before writing or editing files under `apps/mobile`, load the `showzy-mobile`
skill (`.claude/skills/showzy-mobile/SKILL.md`) and the matching leaf skill
(router, native-ui, design-system, animation, dev-client, or Vercel RN
rules). Skills are advisory: the constitution, ADRs, and
`apps/mobile/AGENTS.md` win. Do not follow vendored advice to use NativeWind,
`@expo/ui`, Bearer tokens, raw `fetch`, or to restructure the app. UI state
ownership: `.claude/rules/mobile-ui-state.md`.

## Magic Patterns → mobile port

Canonical rule: `docs/design/mapping/mp-to-mobile.md`. Decision: ADR-0024.
Canvas: https://www.magicpatterns.com/c/g4fsekajwwkeex3v612gvp. The V1 app is
read-only domain reference at `E:\showzy\apps\mobile`. Product screens need
the recorded UX gate (`docs/design/process.md`).

Before writing a screen:

1. Read the Magic Patterns files for that route.
2. List every visual piece and classify **shared** vs **feature**.
3. Shared (Button, Card, `SegmentedTabs`, `TabView`, input, sheet, badge,
   empty, header) → reuse or add in `src/components/ui/`. Do not fork a second
   Button or tab primitive. Pill chrome is `SegmentedTabs`; swipeable
   in-screen scenes are `TabView`. `BottomNav` is staff shell only.
4. Feature (OrderRow, ProductImagePicker, AssistantSheet) →
   `src/features/<module>/<surface>/` (folder roles follow
   `catalog/products`). Compose `src/components/form-kit`; copy only the
   feature-specific draft/plan/schema/copy/load. Do not add new
   product modules under `src/components/screens/<feature>/`.
5. Bind color/space/radius/type to `src/theme/`. No hardcoded hex.

Do not paste Tailwind, `div`, `react-router-dom`, `framer-motion`, or mock
data. Do not maintain a Magic Patterns design-system preset. Google and guest
login on the prototype must not ship (ADR-0006). New npm dependencies
(including NativeWind) need owner approval.
