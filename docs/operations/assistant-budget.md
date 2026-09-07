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
| `AI_UNKNOWN_MODEL_TURN_USD` | `0.10` | not a disable switch — unpriced models add this amount |

Restart the API after changing env. Counters are not reset by a restart.

## Redis keys

Turn limit uses the existing token-bucket store:

```
ai-chat:{userId}
```

Daily USD (INCRBYFLOAT, `EXPIRE` 48 hours):

```
ai-budget:{companyId}:{yyyy-mm-dd}
ai-budget:global:{yyyy-mm-dd}
```

The date is Europe/Kyiv. Confirmation and choice resumes skip the turn
bucket (second half of a turn already consumed) and still add estimated
USD to both budget keys.

## Raise a company's budget for today

Spend is the counter; the limit is env. To let one company continue
today without raising every tenant:

```
# inspect
GET ai-budget:{companyId}:{yyyy-mm-dd}

# treat remaining budget as the full daily limit again
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
