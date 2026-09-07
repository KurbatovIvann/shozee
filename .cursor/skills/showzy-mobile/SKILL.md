---
name: showzy-mobile
description: >
  Routes Showzy Expo/React Native work to the installed Expo and Vercel
  skills and applies Showzy overrides. Use whenever editing apps/mobile,
  Expo Router routes, Unistyles theme/tokens, auth OTP/sign-in/verify
  screens, TextInput, keyboard, safe area, Reanimated, FlashList, or the
  Expo dev client. Load this skill before writing mobile code.
---

# Showzy mobile skill router

Load this skill **before writing or changing** anything under `apps/mobile`.
Then load the matching leaf skill below and follow it.

## Constitution wins

On any conflict, in this order: `.cursor/rules/`, accepted ADRs,
`apps/mobile/AGENTS.md`, `docs/pipeline.md`, then these skills.

Do not add npm dependencies. Do not introduce NativeWind, Tailwind,
`@expo/ui`, `@gorhom/bottom-sheet`, Ionicons, or a second theme.

Staff copy (how to add a namespace, shared vs leftover, typed
extensions) lives in `packages/copy/AGENTS.md`. Point there; do not
duplicate the how-to. Feature screens keep importing `src/i18n/<ns>`;
device bind stays in the app.

## Installed leaves (read the matching `SKILL.md`)

| Task | Skill path |
| --- | --- |
| Vague Expo/mobile request | `.cursor/skills/expo-overview/SKILL.md` |
| Routes, groups, Stack, redirects, headers | `.cursor/skills/expo-router/SKILL.md` |
| Keyboard, safe area, HIG, native controls, screen chrome | `.cursor/skills/expo-native-ui/SKILL.md` |
| Unistyles tokens, `src/theme/`, `src/components/ui/` | `.cursor/skills/expo-design-system/SKILL.md` |
| Reanimated, gestures, press feedback, haptics, sheets | `.cursor/skills/expo-animation/SKILL.md` |
| Custom dev client, native rebuilds | `.cursor/skills/expo-dev-client/SKILL.md` |
| `Text`/`Pressable`/lists/FlashList/scroll | `.cursor/skills/vercel-react-native-skills/SKILL.md` then the matching `rules/*.md` |

Copies also live under `.agents/skills/` (skills CLI). Prefer `.cursor/skills/`.

## Do not load (not installed, contradict Showzy)

`expo-ui`, `expo-tailwind-setup`, `expo-data-fetching`, `expo-project-structure`,
`expo-dom`, `expo-web-to-native`, Callstack `react-native-best-practices`.

Ignore vendored advice that says to consult `@expo/ui` first, set up NativeWind,
use Bearer tokens / raw `fetch` / SWR / Expo Router loaders, persist the Query
cache, or restructure `apps/mobile`. Session transport is Cookie via
`@better-auth/expo` under `src/auth/` only. Domain reads/writes go through
`@showzy/contract`.

## Design system

Unistyles 3.2.2 at `apps/mobile/src/theme/` is the only theme. Extend it in
its own idiom. Port screens per `docs/design/mapping/mp-to-mobile.md`.
In-screen tabs: `SegmentedTabs` + `TabView` only (decision table in that
doc). Do not add `react-native-tab-view` or a feature-local tab bar.

Corners and shadows (checked against RN 0.86 View style props):

- `borderCurve: "continuous"` is **not** deprecated. It is still the iOS 13+
  squircle (`circular` | `continuous`). Android ignores it. Spread
  `theme.squircle` next to non-capsule `borderRadius`. Skip `radii.full`.
- Legacy `shadowColor` / `elevation` **are** superseded on the New
  Architecture. Use `theme.shadows.*` (`boxShadow` strings).
