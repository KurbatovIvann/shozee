# Phase 1 target flow — minimal filing for a simplified-system ФОП

**Status:** owner decision, 2026-09-05

Not a specification. This is the frame that keeps the research bounded:
what the product must be able to do first, and what each step demands from
which topic. The executable contract remains the Linear feature card plus
`*.contract.ts` (ADR-0023).

---

## The flow

1. **Income in.** The owner either connects a bank — Monobank, PrivatBank —
   so operations on the ФОП account arrive automatically, or enters them by
   hand into a form. Manual entry is not a degraded path: it is the route
   for every client who does not connect a bank, and it must produce the
   same ledger. → [SHO-451](https://linear.app/showzy-v2/issue/SHO-451)
2. **We compute.** From that ledger: declared income for the period, single
   tax due, military levy due, ЄСВ due. → rules from
   [SHO-444](https://linear.app/showzy-v2/issue/SHO-444), base from
   [SHO-451](https://linear.app/showzy-v2/issue/SHO-451)
3. **We fill the declaration**, prefilled from the computed figures. →
   [SHO-447](https://linear.app/showzy-v2/issue/SHO-447)
4. **The human signs.** The owner signs with their own key. We never sign on
   their behalf. → [SHO-445](https://linear.app/showzy-v2/issue/SHO-445)
5. **We submit** what the human signed, and process the authority's
   receipts inside our own system. → [SHO-447](https://linear.app/showzy-v2/issue/SHO-447)

**Confirmed 2026-09-05:** step 5 is ours. No filing provider — we build the
container, submit to ДПС, and handle the квитанції ourselves, over the
**cabinet REST API** rather than Єдине вікно. Reasoning and cost in
`vendors.md`.

Explicitly **out of scope for phase 1: full accounting**. This is a minimal
filing flow for a sole proprietor on the simplified system, nothing more.

> **S:** owner decision — 2026-09-05
> **V:** owner
> **C:** firm

### What step 4 settles

An earlier framing of T2 asked whether signing could be delegated to the
platform unattended. That question was never open: the human signs, we
transmit. Blueprint §4 and ADR-0012 already made human-in-the-loop
mandatory for signing.

T2's real question is narrower and more practical — **how** a person signs
a declaration from our client: which key media are usable (file key,
Дія.Підпис, cloud signature), where the signing happens, and what we hold
afterwards.

---

## Prior art: how Taxer presents this

Observed in the owner's own Taxer account, 2026-09-05. Personal
identifiers deliberately not recorded, per the secrets rule in `README.md`.

### The calendar is the product

The main surface is a year split into four quarters, each holding the same
four recurring tasks — declaration, single-tax payment, military-levy
payment, ЄСВ payment — each individually markable as done, with the current
period highlighted.

The user's mental model is a **recurring per-quarter checklist**, not a
ledger. The ledger is machinery underneath it. Worth carrying into
[SHO-450](https://linear.app/showzy-v2/issue/SHO-450) as a presentation
constraint.

### The declaration task

Carries the deadline, the governing form, the penalty for lateness, and a
"mark as done" action.

Form: наказ Мінфіну «Про затвердження форм податкових декларацій платника
єдиного податку» від 19.06.2015 **№ 578**, у редакції від 31.01.2025
**№ 57**.

> **S:** observed in Taxer — sources.md#taxer-observed, 2026-09-05
> **V:** observed (a third-party product's citation, not the наказ itself)
> **C:** medium-high — a precise, checkable citation; T4 verifies it against the наказ and confirms this is still the current redaction

Late filing: 340 UAH, and 1,020 UAH for a repeat within the year
(п. 120.1 ст. 120 ПКУ). Same provenance, same confidence.

The 9-month return deadline shown was 2026-11-09, which matches the 40-day
cadence recorded in `legal-frame.md` §1 — an independent corroboration of a
claim that was `C: medium`.

### The payment forms

Three separate payment documents — single tax, military levy, ЄСВ — each
generating an invoice payable at a bank branch, through Privat24, or by
card, with save / print / PDF / pay-by-QR actions.

The structurally important part: **each tax has a different recipient and a
different IBAN, and both vary with the payer's locality.**

| Payment | Recipient shape |
| --- | --- |
| Single tax | local hromada + regional treasury office |
| Military levy | oblast + regional treasury office |
| ЄСВ | oblast ДПС office |

So producing a correct payment document requires a **directory of payment
requisites keyed by locality and tax type**. That is a real data dependency,
and not one anybody would predict from the protocol side. Assigned to
[SHO-448](https://linear.app/showzy-v2/issue/SHO-448).

Also observed: the ЄСВ amount came prefilled as a fixed quarterly figure
while single tax and military levy sat at 0.00 pending declared income —
consistent with ЄСВ being a flat minimum and the other two being
income-derived. The quarterly figure shown is exactly three times the
monthly minimum recorded in `legal-frame.md` §1, which raises that claim
from `C: medium`.

---

## Scope decisions

### Payment documents are in scope

Phase 1 generates the payment documents as Taxer does — recipient, IBAN,
amount, QR — not merely the amounts owed. The flow has to be finishable
inside the product.

This pulls the **payment requisites directory into phase 1**: producing a
correct payment document requires resolving recipient and IBAN by locality
and tax type. Assigned to
[SHO-448](https://linear.app/showzy-v2/issue/SHO-448), which is on the
critical path as a result. Wrong requisites send a client's money to the
wrong account, so it is a correctness requirement, not a convenience.

> **S:** owner decision — 2026-09-05
> **V:** owner
> **C:** firm

### Signing in phase 1 is the file key only

The owner signs with a file-based key. The platform already supports QES
signing on web and on mobile, so step 4 rests on existing capability rather
than new work. Дія.Підпис, hardware tokens and cloud signature are later
additions, not phase 1 questions.

> **S:** owner decision — 2026-09-05
> **V:** owner
> **C:** firm

This closes most of [SHO-445](https://linear.app/showzy-v2/issue/SHO-445).
What remains there is narrow: what the tax side expects *around* the signed
declaration — the container and signature format — versus what our existing
ASiC-E packaging produces, and whether we may store the signed payload.

Worth noting for after phase 1: Monobank's providers API exposes **monoКЕП**
document signing via a deeplink into the bank's own app
(`bank-ingestion.md`). For a sole proprietor who already banks with
Monobank, that is a materially better experience than handling a key file on
a phone.
