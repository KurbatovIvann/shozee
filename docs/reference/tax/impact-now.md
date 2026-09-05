# T7 — Impact now: what this research changes about today's model

**Status:** assembled 2026-09-05 from T1, T2, T4, T5, T6, T8 · [SHO-450](https://linear.app/showzy-v2/issue/SHO-450)

The payoff of the workstream. Phases 11 and 12 are post-launch, but
`docs/scope.md:151` makes financial data a **phase 0 requirement**, and the
model that has to survive those phases is being written now.

**Read this before touching money, orders or customers, and before
building `payments` or `banking`.** Neither module exists yet — no
`packages/modules/payments`, no `banking`, nothing in
`packages/db/src/schema`. That is the cheapest possible moment for these
constraints to arrive.

Nothing here is a design. Each item says what is true, what it costs to
discover late, and which card it came from. Where a decision is needed, it
is named as a decision.

---

## The short version

| # | Constraint | Lands on | Cost if discovered late |
| --- | --- | --- | --- |
| 1 | Payment channel must be a stored, classified field | `payments` (unbuilt) | **Unrecoverable** — cannot be reconstructed |
| 2 | Income classification must be stored with provenance | `banking` (unbuilt) | **Unrecoverable** — a filing you cannot defend |
| 3 | A filed period's figures must stay reconstructible | `banking`, `documents` | **Unrecoverable** — corrections become impossible |
| 4 | Foreign-currency receipts need a rate and a date | `banking` (unbuilt) | High — needs the rate as of the operation |
| 5 | Fiscal document reference, narrow | `payments` / `orders` | Medium — schema migration |
| 6 | Counterparty tax identifiers | `customers` (**exists**) | Medium — backfill from users |
| 7 | Async acceptance is a state machine, not a call | worker, outbox | Medium — reshapes an action |
| 8 | The cabinet `Authorization` is a credential | wherever it is stored | **Security**, not migration |

Items 1–4 share a property: the data simply is not there later. Items 5–7
are ordinary migrations. Item 8 is not a data-model problem at all.

---

## 1. Payment channel is a first-class classified field

**Confirmed.** The РРО/ПРРО obligation turns on *how* money arrives, not
whether it arrived:

| Channel | Fiscal receipt owed |
| --- | --- |
| Cash | yes |
| Card at point of sale, acquiring, QR | yes |
| Transfer from a non-bank financial institution | yes |
| IBAN → IBAN | no |
| Services settled solely via banking remote services | no |

So a boolean `paid`, or a status that collapses these, destroys the one
distinction the tax side cares about — and it is not recoverable after the
fact, because nothing in the order records which rail the money took.

`docs/scope.md:151` already anticipated this: "amounts, currency,
payment↔order↔document links designed carefully from day one".

**Decision needed:** whether the channel is derived from the payment
provider or captured explicitly. Related open question in `legal-frame.md`:
does IBAN→IBAN survive a payment link or QR that ultimately credits an
IBAN, or does the initiation channel decide? That is exactly the flow our
product would generate.

*From T1 §2 · [SHO-444](https://linear.app/showzy-v2/issue/SHO-444)*

## 2. Income classification must carry its provenance

**Confirmed.** Monobank and PrivatBank both say who paid, how much and
what they wrote. **Neither says whether it is taxable income.** Credits
that are not income include the owner's transfers between their own
accounts, loan proceeds, refunds received, and money returned after a
cancelled order — all structurally identical to revenue.

So classification is a judgement, and it is the basis of a filed return.
It has to be stored **as data**: the decision, who made it (a rule or a
person), and when. A derived-on-read classification cannot be defended
months later, and cannot explain why a past filing said what it said.

**Decision needed, and it is a product question:** does the owner review
every unclassified credit before filing, or do we file on defaults and let
them correct? The failure modes differ — nagging versus a wrong return.

*From T8 · [SHO-451](https://linear.app/showzy-v2/issue/SHO-451)*

## 3. A filed period must stay reconstructible

**Confirmed, and this is the least obvious one.**

Two facts from наказ 729 combine into a hard requirement:

- A correction is **a new document with a new filename**, not an edit.
  `C_DOC_STAN` marks 1 reporting / 2 new reporting / 3 correcting;
  `C_DOC_TYPE` increments while `C_DOC_CNT` stays pinned to the document
  being fixed.
- The declaration is **cumulative year-to-date**: a quarterly return
  restates the year and settles the difference against what was previously
  declared.

Therefore the ledger must be able to answer "what did period N look like
**when we filed it**", not only "what does period N look like now". An
owner who reclassifies a transaction from March in November has changed a
figure that was already declared — and filing a correction requires both
numbers.

A ledger that only holds current truth makes corrections impossible to
compute. This is the constraint most likely to be missed, because
everything works fine until the first correction.

*From T4 · [SHO-447](https://linear.app/showzy-v2/issue/SHO-447)*

## 4. Foreign-currency receipts need a rate and a date

**Confirmed as a gap, not yet as a rule.** Both bank APIs return non-UAH
operations. Entering one into a UAH ledger requires a rate on a defined
date, and that rule is a tax rule we have not researched — handed back to
[SHO-444](https://linear.app/showzy-v2/issue/SHO-444).

What is already clear: whatever the rule turns out to be, it needs the rate
**as of the operation**, which means capturing it at ingestion. Recomputing
later from a current rate would be wrong, and the historical rate may not
be conveniently available.

This is the same shape as the money-snapshot invariant the codebase already
holds — capture at the moment, never recompute.

*From T8, open question back to T1*

## 5. Fiscal identity — much narrower than first thought

**Narrowed by owner decision.** Fiscalisation, if it ever happens, goes
through a provider such as Checkbox; we will not implement the ДПС fiscal
protocol.

A provider absorbs the protocol but not the concepts. Still ours to model:

- a **reference to a fiscal document** — number and status;
- the **payment channel** (constraint 1), which decides whether one is owed;
- enough **failure states** to tell a user fiscalisation was attempted and
  did not complete.

No longer ours: shift lifecycle, fiscal number reservation, offline
queueing. That removes long-lived, request-outliving state from our side of
the boundary — the earlier framing assumed we might own a fiscal shift as a
domain object. We do not.

Net effect: this shrinks from "design a fiscal document lifecycle" to
"leave room for an external reference and its failure states". Cheap, and
safe to get right later.

*From T6 · [SHO-449](https://linear.app/showzy-v2/issue/SHO-449)*

## 6. Counterparty tax identifiers — and a better source than asking

`packages/modules/customers` exists and owns counterparties, so this is the
one constraint landing on built code. Business counterparties need their
tax identifiers (ЄДРПОУ / РНОКПП), and individuals behave differently from
businesses.

**But for our own tenant, do not ask — read.** `GET /ws/public_api/payer_card`
returns the payer's card in 16 blocks including **єдиний податок
registration** (group and rate), **VAT registration**, **ЄСВ**, and
**bank accounts**.

Self-declaration during onboarding is exactly where a wrong tax
calculation would begin. And `/payer_card/14` lets us confirm that a
connected bank account is genuinely the client's registered ФОП account
rather than trusting the connection alone.

*From T4, T5, T8*

## 7. Acceptance is a state machine, not a return value

**Confirmed against a real filing.** Three rungs, not two:

1. a plain-text delivery notice — reached the ДПС mailbox;
2. **квитанція №1** — «ДОКУМЕНТ ЗБЕРЕЖЕНО НА ЦЕНТРАЛЬНОМУ РІВНІ»,
   `HNUMREG` still empty;
3. **квитанція №2** — «Прийнято пакет.», and it carries the
   **registration number**.

Receipt №1 does not mean accepted. A flow that treats the first
acknowledgement as success reports a filing as done while it is still
unchecked. The API's `finalKvt` flag is what distinguishes them.

Observed gap between receipts: about 81 seconds. One sample — enough to set
the order of magnitude for a poll loop, not enough to fix an interval.

**What to store as proof of filing:** the registration number from receipt
№2. That is the authority's own identifier for the accepted return.

This maps onto the existing outbox almost unchanged: one durable submission
step, then a poll loop with a defined terminal condition.

*From T4 · [SHO-447](https://linear.app/showzy-v2/issue/SHO-447)*

## 8. The cabinet `Authorization` value is a credential

**Not a data-model constraint — a security one, and the sharpest finding
of the workstream.**

The header is the taxpayer's identifier signed with their own key. The
signed payload carries no timestamp and no nonce, so for a given key and
certificate **it is the same bytes every time** — replayable by
construction, limited only by a server-side expiry we cannot see.

Holding it is holding a **long-lived bearer credential for that taxpayer's
entire cabinet**: registration card, bank accounts, settlement state, every
filed document.

The design correctly keeps the owner's *key* away from us. This derived
value would reach us, and deserves comparable seriousness — encrypted at
rest, never logged, tenant-scoped with the rigour of the tenant-isolation
invariant, a deliberate retention window, and a revocation story (the
client re-issuing their certificate is what invalidates it).

`docs/specs/security-operations.md` already governs secret handling, so the
question is probably which existing category this falls into rather than a
new one.

*From T4 · [SHO-447](https://linear.app/showzy-v2/issue/SHO-447)*

---

## Two decisions that are not schema

### Orders and the ledger will not reconcile

The product will hold order records — including cash and card orders — and
a bank-derived income ledger. They will diverge, by design: the declared
base is what lands on the ФОП account (`legal-frame.md` §2a).

What the ledger is built from, what an export contains, and how the two
surfaces sit beside each other are deliberate product decisions. They
should be made on purpose rather than falling out of implementation.

`docs/scope.md:151` already decided the first part — "accounting is built
on real bank transactions, not on orders" — and the owner's account
confirms it was right.

### The channel decides what secrets enter the perimeter

Filing through the cabinet REST API keeps the client's **private key**
needed exactly once per declaration, to sign, and never again. Filing
through Єдине вікно would require it repeatedly, because receipts there
arrive encrypted to the payer and must be decrypted locally.

That is a security property, not a convenience one, and it belongs in the
[SHO-449](https://linear.app/showzy-v2/issue/SHO-449) decision.

---

## What we are deliberately not doing now

- No `packages/modules/tax`, no tax `*.contract.ts`, no API design. This
  workstream produces reference and constraints (SHO-443).
- No fiscal shift modelling — a provider owns it.
- No per-item VAT breakdown. A simplified-system ФОП owes a percentage of
  receipts, not per-line VAT. **Leave room, build nothing** — the pending
  draft would make VAT mandatory for groups 1–3 from 2027 at a 1,000,000 UAH
  threshold, and that changes the answer. Status still unverified
  (`legal-frame.md` §3, open question 1).
- No payment-requisites directory until the cheaper source is tested: the
  private-part API appears to return the payer's own budget IBANs already
  resolved (`registers.md`).

## Open items that could add constraints

1. **Was the VAT draft adopted?** If yes, per-item tax data becomes real
   and constraint 5's "leave room" becomes "build it".
2. **Does IBAN→IBAN survive a payment link or QR?** Decides whether
   constraint 1 can be derived or must be captured.
3. **The foreign-currency conversion rule** — constraint 4 cannot be
   finished without it.
4. **The `Authorization` TTL** — sets how often an owner must
   re-authorise, and therefore how the flow feels.

None of these blocks recording the constraints above. All four would sharpen
them.
