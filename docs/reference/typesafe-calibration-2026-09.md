# TypeSafe calibration stand, September 2026

What the judgment planner does on every action it has a spec for, measured
with the production code, and what moved the numbers. Harness:
`apps/api/src/typesafe-probe/calibration/`. Hand-run only, owner-authorised;
never in CI.

## What it is

- **Corpus**: 391 single messages written by an agent that saw neither the
  specs nor any prompt. 28 per spec'd tool (direct, colloquial, inflected,
  trap, unsupported), 30 talk, 53 jobs with no spec (8 of them two jobs in one
  message). Each case is `tune` or `holdout` (about 60/40).
- **Run**: the production `buildStaffPlanQuestions` against `jev-1.13.0`,
  three times; the raw answers are saved, one file a run.
- **Analysis, offline**: `decideStaffPlan` — the production decision, a pure
  function of the saved answers — is replayed under any thresholds. Every
  write counts as takeable, so creates are measured too. A call is `correct`,
  `wrong` or `delegated`; counts are observations (one case in one run).
- **Report**: by group and trait, why requests were delegated, reliability of
  the job answer and of the argument confidence, per-spec thresholds chosen on
  the tuning split and checked on the held-out one with a 95% upper bound,
  cases that changed between runs, the wrong calls.

```
cd apps/api
node --experimental-transform-types --import ../../packages/db/scripts/ts-resolve-register.mjs \
  --env-file=../../.env src/typesafe-probe/calibration/run.ts --runs 3 --dir <dir>
... run.ts --report --dir <dir>      # re-render from saved runs, no live call
```

One series is 1173 requests, about 5 minutes and $0.20–0.26.

## Four series, 2026-09-19

| Series | Change | Correct | Wrong | Delegated |
| --- | --- | --- | --- | --- |
| 1 | production as it was | 285 | 91 | 797 |
| 2 | an `extras:<tool>` question on every spec; `required` name on creates | 278 | 20 | 875 |
| 3 | job wording: customers vs groups and counterparties, products vs price lists | 323 | 18 | 832 |
| 4 | customer job's `yes` wording restored | 327 | 17 | 829 |
| 4, replayed | unconsumed-words guard and `act` 0.75 on `orders_create` (resolve probe); no new run | 330 | 17 | 826 |
| 5 | the order job's `yes` names the terse form ("Олені 2 капучино"); `act` back to the default | 325 | 18 | 830 |

- **Thresholds were not the problem.** In series 1 the wrong calls were
  confident: 45 of 91 dropped something the message stated (a second status, a
  customer filter, an email, a note, a unit, a currency), because only
  `orders_create` had a question about what the call cannot carry. Two of
  those classes were live in `take` mode: "Скільки замовлень зробила Ірина
  Шевченко цього місяця?" answered with the month's total. After series 2 the
  `unsupported` trait is 0 wrong of 132, and no sweep of thresholds came close
  to that.
- **Overlapping job wording was the coverage problem.** "Покажи групи
  клієнтів" also fired the customers job (0.82), "Покажи прайс-листи" the
  products job (0.60) → `several_jobs`. Saying what each job is *not*: groups
  6 → 21–27 correct of 84, price lists 5 → 36, wrong routes to a job without a
  spec 3 → 0. Rewording a `yes` cost the customers job ten correct calls and
  was reverted: change the `no`, not the `yes`.
- **The job answer is calibrated**: 0.95–1.00 is right 98% of the time,
  0.85–0.95 94%, 0.70–0.85 90%, 0.50–0.70 59%. The lowest argument confidence
  is not informative below 0.7 and flat above it (94–96%).
- **All 17 remaining wrong observations are name forms, none is a wrong job or
  a dropped detail**: an inflected or plural product in an order line ("5
  троянд червоних", "2 стільці", "2 lattes"), an instrumental in a search
  ("з півоніями"), a hyphenated surname, a quoted product name cut at the
  closing quote. Whether each is a failure depends on the module's matcher,
  which the stand does not run; resolving references to real records before
  the write closes the class.
- **New names**: of the correct create calls, 12 of 112 carry the name as
  typed in another case form (customers 9 of 39, products 3 of 25); every one
  is lower-cased, because span candidates are. Creates stay untakeable until
  names are put in the stored form.
- **Per-spec thresholds**: chosen on the tuning split they raise held-out
  correct calls 131 → 145 with no new wrong job. They are **not applied**:
  with 9–21 held-out calls a tool, the 95% upper bound of the wrong share is
  15–65%, so the split cannot show "one in a hundred". The direction is
  consistent, though: reads and the two name-only creates tolerate `act` 0.7
  and a low `argument`; `orders_create` wants `argument` 0.9.
- **Stability**: 7–12 of 391 cases change between runs, almost always
  delegated ↔ correct; one case went wrong ↔ delegated in series 1.
- **Cost of the extras questions**: 3.9k → 5.2k input tokens a request; no
  change in latency (p50 0.30 s, p95 0.42 s).

## What to do with it

- Any change to a spec's wording, a guard or a threshold: run a series, compare
  with the last one, tune on `tune`, read the result on `holdout`.
- A new spec needs its 28 cases first, written blind.
- To state "at most one wrong call in a hundred" for a tool, it needs about
  300 taken held-out observations; grow that tool's corpus, or use live shadow
  disagreements as cases.

## Series 5, after the first live trial of ADR-0047

Live, "Каті 2 макаронси" was `no_job`: the order job answered 0.63. Replayed,
verbless orders sat at 0.59–0.74 — the question asked about "creating an
order" and the message never says so. Naming the terse form in the `yes`
moved them to 0.81–0.89 and left "Скільки коштує торт?" at 0.06. On the
resolve probe the planner now takes 23 of 36 orders at the **default**
thresholds (7 before), none wrong, so the `act` 0.75 override shipped earlier
the same day was removed: wording did what the threshold was compensating
for. The stand's totals moved within run-to-run noise (orders 31 → 33
correct). The earlier lesson stands with a condition: leave a `yes` alone when
the job already scores high on its own messages; change it when it does not.
