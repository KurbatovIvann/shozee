# @showzy/assistant — Agent Instructions

Staff conversation persistence. This package exports **actions and
events only**. Clients never touch these tables; `apps/api` HTTP mounts
call `executeAction`.

## Pending interaction (ADR-0035)

HITL pause/resume is **not** an assistant-module action. Confirmation
and choice records live in Redis (`apps/api` pending-interaction store).
`recordAssistantTurn` outcomes stay `success | error |
confirmation_required | choice_required` — no new enum value. A
confirmed resume persists a second turn (`success`, plus `model_trace`)
through the existing action. Challenge ids and canonical input never
arrive as action input; they are host-store fields. See
`docs/adr/0035-one-pending-interaction-protocol.md`.
