# V1 → V2 mobile port recipe

> **Archived 2026-08-21.** Do not use as visual acceptance or as the
> operating port rule. Current rule:
> [`docs/design/mapping/mp-to-mobile.md`](../../../design/mapping/mp-to-mobile.md)
> (ADR-0024).

> **Historical.** Visual canon moved to [ADR-0024](../../../adr/0024-magic-patterns-canonical-ux.md)
> and [`mp-to-mobile.md`](../../../design/mapping/mp-to-mobile.md) on 2026-08-20.
> Keep this file for V1 domain/edge-case notes. Do not use it as visual
> acceptance.
>
> Status: Owner-approved working rule, 2026-08-19 (superseded).
> Authority: [ADR-0019](../../../adr/0019-v1-mobile-canonical-ux.md) (superseded).
> Product source: `E:\showzy\apps\mobile` (read-only). Never modify it.

This was the operating rule for `apps/mobile` under V1 parity. It is not
the current redesign brief. Use [`mp-to-mobile.md`](../../../design/mapping/mp-to-mobile.md) instead.

Figma is not a gate and is not a source of spacing, color, or components.
The contextual AI overlay is `vm-T29` and is out of scope until that task.

## Sources of truth

| Concern | Source |
| --- | --- |
| Visual language (color, type, space, radius, motion) | V1 `theme` + [`v1-mobile-token-baseline.md`](../inventory/v1-mobile-token-baseline.md), then the V2 Unistyles theme |
| Layout, gestures, sheets, empty/error, copy keys | V1 screen/component files + golden screenshots as a visual check |
| Keep / adapt / drop | [`v1-to-v2-conflict-register.md`](../../../design/mapping/v1-to-v2-conflict-register.md) |
| Which V2 action replaces a V1 call | [`v1-ux-to-v2-capability-matrix.md`](../../../design/mapping/v1-ux-to-v2-capability-matrix.md) |
| Craft vs product UX findings | [`v1-port-findings.md`](v1-port-findings.md) |
| Domain behavior | The owning V2 spec and `@showzy/contract` |

Do not treat a PNG as the source of padding, hex, or font size. Read the V1
style object. Do not treat V1 data-layer code as a template.

## Discretion: improve craft, not the product

**Improve theme hygiene and accessibility. Do not improve the product.**
If the class is unclear, it is C: keep V1 behavior and add a finding.

| Class | Agent action | Ask the owner? |
| --- | --- | --- |
| **A — craft** | Fix in the same PR | No |
| **B — scale slip** | Snap to the nearest existing token/primitive; note the finding | No, unless the snap would change the task |
| **C — product** | Keep V1; append a `proposed` finding | Yes, in a later PR after disposition |

**Class A (always):** a color, space, radius, or type value used outside the
theme → bind it to an existing semantic role, or add the role to the theme if
the inventory already named it; duplicate local styles that match a primitive
→ use the primitive; missing `accessibilityLabel`; hit target clearly under
44pt with no dense-layout reason; dead code; forbidden V1 data imports.

**Class B (snap, do not invent):** `13` vs the 4/8/12/16 scale; a one-off
`fontSize` not on the type scale; contrast failure caused by pairing `muted`
on `canvas` rather than by a brand decision.

**Class C (never silent):** tabs, IA, gestures, step order, copy; control
hierarchy; density of staff lists; new screens; tablet layout; AI overlay.

Accepted Class C items wait for their own PR. They do not ride along with a
button or list port.

## V1 paths

**Read for presentation and interaction**

- `src/theme/`
- `src/components/ui/`
- `src/components/glass/`, `src/components/shell/`
- Screen layout JSX, Unistyles, Reanimated, i18n keys
- Local ephemeral state: open sheet, draft text, viewer, theme preference

**Do not copy**

- `@supabase/supabase-js`, `.from`, `.rpc`, Storage
- V1 Nest `/api/v1` clients and `@showzy/database`
- `src/lib/actions/`, entity Zustand stores, permission facts from V1 session
- Order/payment/document snapshots owned by chat
- New npm dependencies (propose in the PR; owner approval required)

A V2 screen receives a contract-derived view model and callbacks. Domain
decisions stay in actions. Optimistic UI is allowed only where the spec says
so (desired-state social writes, for example).

## Screen acceptance

A ported surface is done when:

1. hierarchy, density, gestures, and motion match the V1 reference unless a
   finding is `accepted`;
2. every visual value comes from the V2 theme or a documented primitive;
3. light/dark/system and Ukrainian/English work;
4. loading/empty/error/offline are explicit;
5. no V1 data dependency remains;
6. new Class B/C discoveries are in `v1-port-findings.md`.
