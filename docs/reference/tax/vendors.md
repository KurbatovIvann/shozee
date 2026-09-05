# T6 — Direct integration versus an intermediary provider

**Status:** fiscalisation decided; reporting still open · [SHO-449](https://linear.app/showzy-v2/issue/SHO-449)

---

## Decision: fiscalisation goes through a provider

If and when we support fiscalisation, it will be an integration with a
provider such as Checkbox. **We will not implement the ДПС fiscal server
protocol ourselves.**

> **S:** owner decision — 2026-09-05
> **V:** owner (a decision, not a finding)
> **C:** firm for now; the owner's wording leaves it open to revisit, but
> nothing in the current evidence argues against it

### Why this holds up

Three things line up behind it, so it is not a decision made against the
research:

1. **The primary customer does not need it.** `legal-frame.md` §2a: our
   first case settles by IBAN and owes no fiscalisation at all. Building
   the protocol would serve nobody we have.
2. **The protocol is the expensive kind.** Offline mode with reserved
   fiscal number ranges, shift state that outlives a request, an error
   taxonomy where some failures leave the shift unusable, and version
   churn driven by наказ. That is a lot of surface to own for a feature
   that is not on the critical path.
3. **Signature handling comes with it.** Direct fiscalisation would drag
   the QES questions in T2 into a high-frequency path, rather than the
   low-frequency filing path where they actually belong.

### What this does not decide

Choosing a provider. That is a later exercise against the criteria in
[SHO-449](https://linear.app/showzy-v2/issue/SHO-449) — API quality,
pricing, white-label terms, where the receipt legally sits, and whether we
could migrate off without the client re-registering. It becomes live when
fiscalisation becomes live, most likely with Phase 11 acquiring.

### What still leaks into our model

A provider absorbs the protocol, not the concepts. Even fully behind
Checkbox or an equivalent, our data model has to hold:

- a **reference to a fiscal document** (its number and status) on whatever
  our side considers the payment or the order;
- the **payment channel**, since that is what decides whether a receipt is
  owed at all (`impact-now.md` candidate 1, already confirmed);
- enough of the **failure states** to show a user that fiscalisation was
  attempted and did not complete.

What we do *not* need to model, because the provider owns it: shift
lifecycle, fiscal number reservation, offline queueing. That is a real
narrowing of `impact-now.md` candidate 3 — worth recording, because it
removes long-lived state from our side of the boundary.

---

## Decision: we file the declaration ourselves

**Owner decision, 2026-09-05.** No provider for filing. We build the
declaration, the owner signs it, we submit it to ДПС, and we process the
authority's receipts inside our own system.

> **S:** owner decision — 2026-09-05
> **V:** owner
> **C:** firm

The owner also drew the boundary explicitly: **ПРРО is a separate topic
and is not needed at all when payment arrives only on the ФОП account** —
which is the first case we support. So the provider decision above stays
confined to fiscalisation, and fiscalisation stays out of phase 1.

### The channel follows from it

Filing ourselves means choosing between the two channels, and there the
argument that was withdrawn from the provider comparison applies exactly
as intended:

| | Cabinet REST API | Єдине вікно |
| --- | --- | --- |
| Documented for third-party systems | yes | it is an email/MIME channel |
| Receipts arrive | plain XML or PDF | encrypted to the payer |
| Client's private key after signing | **not needed** | needed to decrypt every receipt |
| Rendering | `/pdf` provided | own template per form |

**So: the cabinet REST API.** It is the only channel on which the owner's
key is used once per declaration and never again — which is what
`target-flow.md` step 4 assumed all along.

### What this decision costs us, stated plainly

Two things become ours to carry rather than someone else's:

1. **The наказ 499 container**, including the two unresolved unknowns —
   the `XXX_CRYPT` payload shape and the `CERTYPE` letter. These move from
   "interesting" to **on the critical path**.
2. **No sandbox.** There is no test endpoint for reporting, so the first
   real proof is a real declaration with a real deadline and a real
   penalty.

The mitigation for the second is available and reasonable: the **owner's
own quarterly declaration** is a genuine obligation that has to be filed
anyway, so filing it through our system is a legitimate acceptance test
rather than an experiment on someone else. The next deadline is
2026-11-09 for the nine-month period. That is the natural first target,
and it sets the schedule for resolving the container unknowns.

## Superseded: does the same logic apply to reporting?

The fiscalisation decision raises the obvious question for the surface
that *is* on the critical path. Filing the single-tax declaration can
plausibly go the same way — services in this market already file on a
client's behalf — or it can be ours, which is what "replacing Taxer"
normally implies.

This is not decided, and it changes how deep
[SHO-447](https://linear.app/showzy-v2/issue/SHO-447) needs to go:

| If filing is ours | If filing goes through a provider |
| --- | --- |
| T4 must cover document format, submission channel, and the квитанція state machine in full | T4 shrinks to the provider's API and its acknowledgement model |
| T2 (QES) is on the critical path — we must solve signing | the provider's signing arrangement becomes the question instead |
| we own form-version churn | the provider absorbs it |

Note that the second column does not remove the QES problem, it relocates
it: something still has to sign the declaration with the client's key, and
`kep-signing.md` question 3 — whether unattended delegated signing is
permissible at all — is the same question either way.

### The state of the evidence, as it stood

**Resolved 2026-09-05 in favour of filing ourselves — see the decision at
the top.** Kept because it records what the choice was weighed against, and
because the two arguments against still describe real costs we now carry.

Three arguments favour filing directly:

1. **A documented official channel exists.** The strongest argument for a
   provider would have been "there is no way in for a third party". There
   is one (`reporting-api.md`).
2. **Form-version churn is detectable in advance** — per-form change dates
   in the registry, developer-draft rows, and a dedicated versions
   directory.
3. **The container work reuses what we own.** The crypto is already
   compiled into our binaries (`kep-signing.md`).

**A fourth argument was mis-scoped and is withdrawn.** It ran: the cabinet
channel keeps the client's private key out of our system, while Єдине вікно
would need it repeatedly to decrypt receipts. True — but that compares two
ways of filing *ourselves*. If a provider operates the Єдине вікно channel,
that burden is theirs, not ours. It is an argument for choosing the cabinet
channel **within** the direct option, not an argument against a provider.

And two things point the other way:

- **There is no sandbox for reporting.** The ПРРО section names a
  developer test endpoint; nothing equivalent exists for filing. Every test
  is a real declaration with a real deadline and a real penalty, and the
  feedback loop is quarterly.
- **Real unknowns remain** — the `XXX_CRYPT` payload shape and `CERTYPE`.
  Narrow now, but unresolved, and a rejection may not say which one is
  wrong.

## 3. Vendor evaluation — fiscalisation only

Filing providers are no longer a candidate set; that question is closed.

What remains is the fiscalisation evaluation, and it stays deferred until
fiscalisation becomes live — with Phase 11 acquiring, or with a customer
segment that takes cash or card and wants to be compliant. Neither is
phase 1: the first supported case settles on the ФОП account, and owes no
fiscalisation.

Criteria when it does become live: API quality and documentation, pricing,
white-label terms, where the receipt legally sits, who holds the obligation
when the provider is down, and whether we could migrate off without the
client re-registering.
