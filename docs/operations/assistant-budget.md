# Staff assistant budget and turn limit

`POST /assistant/chat` spends Anthropic tokens. The staff action bucket
(120/min per user) only covers tool calls *inside* a turn. This guard
runs after session/company membership and before the intent gate and
`appendUserMessage`.

Runbook for SHO-505. Production keys live in Redis.

## Environment

| Variable | Default | `0` |
| --- | --- | --- |
| `AI_CHAT_TURNS_PER_MINUTE_PER_USER` | `20` | disables the per-user turn check |
| `AI_DAILY_BUDGET_USD_PER_COMPANY` | `5` | disables the per-company Kyiv-day USD check |
| `AI_DAILY_BUDGET_USD_GLOBAL` | `100` | disables the process-wide Kyiv-day USD check |
| `AI_UNKNOWN_MODEL_TURN_USD` | `0.10` | not a disable switch — must be finite and greater than 0 (admission reservation and unpriced-model fallback) |

Restart the API after changing env. Counters are not reset by a restart.

## Redis keys

Turn limit uses the existing token-bucket store:

```
ai-chat:{userId}
```

Daily USD (increment-with-cap reservation, then `INCRBYFLOAT` settle,
`EXPIRE` 48 hours):

```
ai-budget:{companyId}:{yyyy-mm-dd}
ai-budget:global:{yyyy-mm-dd}
```

The date is Europe/Kyiv, captured on the hold at admit time. Settle and
unused-hold release use that date, not the wall clock at finish — a turn
that reserves before Kyiv midnight and finishes after still writes the
**reserve** day's keys. `{companyId}` is the lowercase UUID. Before the
gate/model, the guard **reserves** `AI_UNKNOWN_MODEL_TURN_USD` on each
enabled counter with an atomic increment-with-cap (Redis Lua; memory
store serializes per key). After the turn, `INCRBYFLOAT` settles the
delta `(estimated − reserved)`. Unknown-model `null` estimates stay at
the reserved amount.

This is an admission threshold, not a hard cap on provider charges. An
admitted turn may settle **above** its reservation; that overshoot is
recorded in full. The next request is denied when the counter is at or
over the cap.

Chat confirmation resume (`x-confirmation-challenge-id` on
`POST /assistant/chat`) skips the turn bucket but still reserves and
settles estimated USD on both budget keys.

`POST /assistant/choice` does not call a model, costs `$0`, and does
not write Redis.

A budget 429 does not consume a turn slot. A 503 (`AI_NOT_CONFIGURED`)
does not consume a turn slot or reserve budget.

If a reserved turn never reaches settlement (gate failure,
`appendUserMessage` failure, or SSE abort), the unused hold is released
on the same Kyiv-date keys. Settlement and release are mutually
exclusive for one turn (no double subtract).

## Raise a company's budget for today

Spend is the counter; the limit is env. In-flight `tryAdd` holds sit on
the same key until settle or unused-hold release.

Always inspect first:

```
GET ai-budget:{companyId}:{yyyy-mm-dd}
```

Do not `DEL` or `SET 0` while chats that already reserved are still
running. Those turns will still settle `(estimated − reserved)` or
release `−reserved` against the key you just cleared, so the counter can
go negative or a later settle can look like a fresh charge. Wait until
in-flight turns finish, or subtract only the remaining spend you intend
to forgive after accounting for reserved USD still on the counter.

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
(at least 1). Denial logs: `reason` is `turn_limit` | `company_budget`
| `global_budget`, plus `company_id` and `request_id`. Never the user
message.
