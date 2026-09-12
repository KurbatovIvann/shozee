# Staff assistant budget and turn limit

`POST /assistant/kit/chat` and `POST /assistant/kit/answer` spend
Anthropic tokens. The staff action bucket (120/min per user) only covers
tool calls *inside* a turn. This guard wraps those two routes at the
mount point, after session and company membership and before the turn
runs; the other two kit routes call no model and are unguarded.

Runbook for SHO-505. Production keys live in Redis.

## Environment

| Variable | Default | `0` |
| --- | --- | --- |
| `AI_CHAT_TURNS_PER_MINUTE_PER_USER` | `20` | disables the per-user turn check |
| `AI_DAILY_BUDGET_USD_PER_COMPANY` | `5` | disables the per-company Kyiv-day USD check |
| `AI_DAILY_BUDGET_USD_GLOBAL` | `100` | disables the process-wide Kyiv-day USD check |
| `AI_UNKNOWN_MODEL_TURN_USD` | `0.10` | not a disable switch — must be finite, greater than 0 and at most 1 USD (admission reservation and unpriced-model fallback). The cap bounds a turn's stored hold, so a bad release cannot lift the daily cap by more than that (SHO-560) |

Restart the API after changing env. Counters are not reset by a restart.

## Redis keys

Turn limit uses the existing token-bucket store:

```
ai-chat:{userId}
```

Daily USD (increment-with-cap reservation, then a floored add to release,
kept 48 hours):

```
ai-budget:{companyId}:{yyyy-mm-dd}
ai-budget:global:{yyyy-mm-dd}
```

One record per turn says that turn's reservation has been taken. It is
what a release compare-and-deletes, and it is what stops a retry
reserving twice (SHO-572). Same 48-hour TTL:

```
ai-budget-hold:{companyId}:{yyyy-mm-dd}:{kind}:{conversationId}:{commandId}
```

`{kind}` is `chat` or `answer`; every id is lowercase. The key is the
turn's own identity — the same identity `assistant_turns` is keyed by —
so a retry of the same command finds the reservation the first attempt
took instead of taking another. The value is the two reserved amounts in
millionths of a dollar, `{company}:{global}`.

The date is Europe/Kyiv, captured on the hold at admit time. Release uses
that date, not the wall clock at finish — a turn that reserves before
Kyiv midnight and finishes after still writes the **reserve** day's keys.
`{companyId}` is the lowercase UUID. Before the gate/model, the guard
**reserves** `AI_UNKNOWN_MODEL_TURN_USD` on each enabled counter with an
atomic increment-with-cap (Redis Lua; memory store serializes per key),
and then records the hold. The counters move first on purpose: the other
order would let a concurrent retry find a record whose reservation is not
in the counters yet and run a turn nobody was charged for.

**The reservation is the charge.** Since a turn runs off the request
(ADR-0039) nothing settles it afterwards — the reservation travels onto
the `assistant_turns` row, and whoever ends that turn releases it if the
turn never reached the model. `add` is a Lua read-add-floor: it adds the
signed amount, stops at zero, and deletes the key when the result is zero
or below, so a counter is never negative (SHO-561). A release that would
have taken a non-zero counter below zero logs `staff assistant budget
counter floored at zero` with the key, the counter and the delta.

This is an admission threshold, not a record of provider charges. The
counter holds **admission reservations only**. What a turn actually cost
is never written here, so real spend above a reservation is recorded
nowhere in Redis — a company whose turns each cost more than
`AI_UNKNOWN_MODEL_TURN_USD` is admitted more often than its dollar limit
would suggest. The next request is denied when the counter is at or over
the cap.

Answering an open question (`POST /assistant/kit/answer`) skips the turn
bucket but still reserves on both budget keys. That bucket
caps how often someone starts new work; answering is finishing work
already admitted, and refusing it would strand a draft behind a limit the
person cannot wait out.

`POST /assistant/kit/abandon` and `GET /assistant/kit/messages` call no
model, cost `$0`, and do not write Redis.

Only a request that stored a turn is charged. A refusal (any non-2xx,
e.g. a `409` for a stale or unresolvable answer) and a replayed command
give the hold back. A retry that found an earlier attempt's reservation
gives nothing back: it took nothing, and that attempt's turn row may be
holding it.

If `claimHold` fails on the wire after Redis already stored the record, the
counters are subtracted back for this request while the record survives; a
retry then adopts that record and its finisher subtracts again (floored at
zero), which can lift the day's effective cap by one reservation. Known and
accepted for now — see SHO-572.

A budget 429 does not consume a turn slot. A 503 (`AI_NOT_CONFIGURED`)
does not consume a turn slot or reserve budget.

A turn that never reached the model has its hold released on the same
Kyiv-date keys, by the worker or the reconciler, from the turn row.
**At most one release per turn**, guaranteed by the hold record rather
than by convention: the record is compare-and-deleted, and only the
caller that removed it subtracts. The request and the row's finisher can
both try, and the counter still moves once (SHO-572). A release that
finds no record subtracts nothing.

## Raise a company's budget for today

Spend is the counter; the limit is env. In-flight reservations sit on the
same key until the turn that owns them is released.

Always inspect first:

```
GET ai-budget:{companyId}:{yyyy-mm-dd}
```

Do not `DEL` or `SET 0` while chats that already reserved are still
running. Those turns will still release `−reserved` against the key you
just cleared. Releases stop at zero, so the counter never goes negative,
but today's spend then reads lower than what was really spent. The
floored releases show up as `staff assistant budget counter floored at
zero` warnings. Wait until in-flight turns finish, or subtract only the
remaining spend you intend to forgive after accounting for reserved USD
still on the counter.

Then, to let one company continue today without raising every tenant:

```
# treat remaining budget as the full daily limit again (only when idle)
DEL ai-budget:{companyId}:{yyyy-mm-dd}

# or set spent to a lower number (limit − remaining)
SET ai-budget:{companyId}:{yyyy-mm-dd} 0
EXPIRE ai-budget:{companyId}:{yyyy-mm-dd} 172800
```

Same for `ai-budget:global:{yyyy-mm-dd}` when the global ceiling is the
blocker. Do not put user text in Redis.

### Hold records are not the money lever

Clearing a counter does **not** clear hold records, and it does not need
to: a record only decides whether a release subtracts. The counter is the
spend. Two things to know before touching one:

- A record outlives a cleared counter. That is harmless for the money —
  the release it later authorises floors at zero as above.
- Clear a record only for a turn that has already **ended**. For a turn
  still queued or running, deleting its record means its later release
  finds nothing and subtracts nothing, so that reservation stays on the
  counter until the day's key expires. That fails closed — the cap is
  reached early, never lifted — but it is the opposite of what clearing
  looks like it does.

```
# every hold recorded for one company today
SCAN 0 MATCH ai-budget-hold:{companyId}:{yyyy-mm-dd}:* COUNT 1000

# the turn is named in the key: {kind}:{conversationId}:{commandId}
# confirm that turn has ended before clearing
DEL ai-budget-hold:{companyId}:{yyyy-mm-dd}:{kind}:{conversationId}:{commandId}
```

Every record expires on its own after 48 hours, so clearing one by hand
is rarely necessary.

Продовжити (`POST /assistant/kit/continue`, SHO-574) reserves under `kind:
"answer"` — the `assistant_turns` row it starts is a db `answer` turn, so its
hold key is `answer:{conversationId}:{commandId}`, never a `continue` key.

## 429 body

Same wire shape as action-level `RATE_LIMITED` (`toWireError`). No new
error code.

```json
{
  "code": "RATE_LIMITED",
  "status": 429,
  "message": "Too many requests. Retry later.",
  "data": { "retryAfterSec": 42 }
}
```

Turn-limit `retryAfterSec` is the token-bucket refill hint. Budget
`retryAfterSec` is whole seconds until the next Europe/Kyiv midnight
(at least 1).

## Denial logs

Every refusal logs `staff assistant budget denied` with `company_id` and
`request_id`. Never the user message. `reason` is one of:

| `reason` | What happened |
| --- | --- |
| `turn_limit` | The bucket answered: this person has started too many turns this minute |
| `company_budget` | The company's Kyiv-day counter is at or over its cap |
| `global_budget` | The process-wide Kyiv-day counter is at or over its cap |
| `rate_limit_store` | The turn bucket's store could not be read |
| `budget_store` | A budget counter or hold record could not be read or written |

**A `_store` reason means nothing was decided**, not that a limit was
reached. The person sees the same `429` either way, so this field is the
only thing that separates "out of budget until Kyiv midnight" from "Redis
is down" — alert on the two `_store` reasons separately from the three
limit reasons. A `_store` denial also carries `err` with the underlying
store failure; a limit denial carries no `err`.
