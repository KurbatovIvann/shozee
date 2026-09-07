# Experience Foundation

This directory holds UX and design-system artifacts for Showzy V2.

- **Process:** [`process.md`](process.md) — stages, outputs, approval criteria,
  and the UX gate definition.
- **Decision:** [ADR-0024](../adr/0024-magic-patterns-canonical-ux.md) — the
  Magic Patterns canvas is the canonical V2 UX. ADR-0019 (V1 visual parity)
  is superseded.
- **Prototype:** [Magic Patterns canvas](https://www.magicpatterns.com/c/g4fsekajwwkeex3v612gvp).
- **Design system:** Unistyles in `apps/mobile/src/theme/` and shared
  primitives in `apps/mobile/src/components/ui/`.
- **Port rule (mobile):** [`mapping/mp-to-mobile.md`](mapping/mp-to-mobile.md) —
  inventory the canvas, classify shared vs feature, reuse or create;
  do not paste React/Tailwind.
- **Port rule (web):** [`mapping/mp-to-web.md`](mapping/mp-to-web.md) —
  MCP-read Screens + canvas files before `apps/web` JSX.
- **Web panel chrome (phase 10):** [`mapping/web-panel-chrome.md`](mapping/web-panel-chrome.md)
  — master–detail (nav | list | detail), responsive from the start
  (drawer on tablet, Sophie-style bottom tabs on phone, list XOR detail
  below `md`), detail as a centered compact card on `md+`. T1–T5 owner-passed
  (`internal evaluation only`); T7 company on canvas awaiting pass.
  Pattern reference only:
  [three-pane example](https://www.magicpatterns.com/c/kputdkqv5aa9tguis1yxu3).
  Do not fork it. Working canvas:
  [Shozee V2 — Web panel](https://www.magicpatterns.com/c/fdsqxjz1djvww5spay7zey).
- **V1 reference:** `E:\showzy\apps\mobile` is read-only domain and
  edge-case reference. Archived V1 inventories live in
  [`docs/archive/design/`](../archive/design/) and are not visual
  acceptance.
- **Domain mapping:** [`mapping/v1-to-v2-conflict-register.md`](mapping/v1-to-v2-conflict-register.md)
  and [`mapping/v1-ux-to-v2-capability-matrix.md`](mapping/v1-ux-to-v2-capability-matrix.md)
  record product dispositions and candidate actions. They do not set
  layout, color, or navigation.

## Approval records

The owner reset the visual canon on 2026-08-20 (ADR-0024). The
[Experience Foundation project](https://linear.app/showzy-v2/project/experience-foundation-863513f2aa0a)
and the relevant feature card hold approval evidence. This index does
not cache a project status or declare the UX gate globally open/closed.

Before implementing a mobile product screen, verify all
[UX gate criteria](process.md#ux-gate), including the owner's recorded
approval for the canvas-covered surface. Missing evidence is a stop;
existing JSX alone is not approval. Backend and Expo shell/auth/deep-link
infrastructure keep their documented exceptions. New auth visuals still
follow the canvas. Web follows its own [canvas read rule](mapping/mp-to-web.md).

Figma is not a source of tokens or components.

Archived greenfield DEFINE/SYSTEM docs and the ADR-0019 V1 inventories in
`docs/archive/design/` are not authority.

## Relationship to the engineering pipeline

The engineering pipeline (`docs/pipeline.md`) is not modified to include
design stages. The only integration point is the **UX gate**: it blocks
product screens, not backend work. See `process.md` §"Integration with the
engineering pipeline."
