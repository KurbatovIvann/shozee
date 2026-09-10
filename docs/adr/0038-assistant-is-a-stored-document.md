# ADR-0038: The assistant is a stored document and a claimable pause

- **Status**: Accepted
- **Date**: 2026-09-10
- **Deciders**: Ivan Kurbatov (human) (+ proposing agent)

## Context

ADR-0037 rebuilt the staff assistant as one tool loop. It shipped, and it
behaved worse on a phone than what it replaced. Six of the eight commits
after it launched were fixes to the same defect class: a question the
assistant had already answered coming back, a tap that may or may not
have been claimed, one order appearing twice or not at all, a reload
showing a different set of cards than the live turn had shown.

None of those were bugs in the loop. They came from two structural
decisions underneath it.

**Resume was a reconstruction.** The pending record stored no provider
messages, so continuing after a human tap meant rebuilding the model
conversation from database rows — `get-model-history.ts`, 547 lines of
guessing tool-call ids, merging results and re-deriving stage identity.
Every guess was a place to be wrong, and the wrongness surfaced as the
model losing track of what it had just done.

**The client owned a copy of the protocol.** The server could not say
which question was still answerable, so the phone kept sets of ignored,
dismissed and resolved challenge ids, plus an attempted `(challenge,
option)` pair so a second tap could not post while the first might
already be claimed. It also reached the same card three different ways —
from parts it had appended itself, from a resume envelope, and from a
re-derivation over raw tool parts — and when two of those disagreed, the
disagreement was the bug.

## Decision

The assistant is a **stored chat document** plus a **claimable pause**,
and the protocol that connects them lives in `@showzy/assistant-kit`, a
package that knows nothing about this product.

- A turn stores the parts it settled. A reload returns those bytes. There
  is no second derivation, so there is nothing to disagree.
- A pause stores the **exact provider messages** of the turn plus the
  tool call that stopped it. Resuming replays them and replaces one tool
  result. Nothing is reconstructed.
- One open question per conversation, claimed exactly once by
  compare-and-set. The server answers `gone`, `stale`, `unresolvable` or
  `invalid_answer`; the client holds no exactly-once state of its own.
- Every route returns the whole document, including refusals, so "your
  tap did nothing" and "here is the question that is open now" are two
  independent answers rather than one entangled one.
- What kinds of question exist is the caller's registry, not the
  package's. The kit has no `choice` and no `confirmation` in it.

## Alternatives considered

- **A third refactor of the ADR-0037 host.** Rejected on evidence: the
  defect class was the reconstruction and the client-side state machine,
  and neither is reachable by changing the loop.
- **LangGraph + an agent server, or Mastra + Inngest.** Rejected: both
  answer durability and orchestration, which were not the problem, at the
  cost of a second runtime and vendor lock-in.
- **Effect-TS.** Rejected: a second effect system for one module's
  problem, and the problem was a missing protocol, not missing
  combinators.
- **Keeping both paths.** Rejected after the client moved: two assistants
  on one database is how the previous one accumulated its
  reconstruction-shaped fixes in the first place.

## Consequences

- ADR-0034 (`model_trace` is prompt state) and ADR-0035 (one pending
  interaction, confirmation resumes without a model call) describe
  machinery that no longer exists. ADR-0037's loop survives in shape —
  one `streamText`, tools chosen by the model — but its host, its resume
  and its speech pipeline do not.
- `assistant_messages` and `assistant_tool_runs` lose their writer. They
  were history-reconstruction storage, not the audit trail: what the
  assistant did is in `audit_log` under `channel = 'ai'`, and stays there.
- The conversation is durable in `assistant_chat_state`; only the pause
  is in Redis, where a deadline in minutes and one atomic claim belong.
- Roughly 45,000 lines come out across the client and the server, most of
  it tests of a state machine that no longer exists.
- What is lost, and named rather than discovered later: an
  `orders-aggregate` card's period line, which came from the counts
  tool's input rather than from the stored card.
- The kit is written to be extractable. It takes no dependency on this
  product, and an isolation test fails if one appears.

## Addendum — confirmations (SHO-553, 2026-09-10)

ADR-0035's rule outlives the machinery it was written for: **the assistant
never skips core's challenge.** A `requiresConfirmation` action refused inside
a turn becomes a `confirmation` pause holding the attempt core bound the
challenge to — action, input, idempotency key — and a person's answer presents
that same attempt again with the challenge. Core decides; the pause only
remembers what to ask it. The previous host's named exception, a host-side
approval for a unique `orders.create`, went with that host and is not carried
over.

## Addendum — the transcript is a log (SHO-555, 2026-09-10)

The decision says a turn stores the parts it settled and a reload returns those
bytes. It was encoded as a shape — one `jsonb` document per conversation,
replaced whole — and the shape was incidental to the rule. A message is never
touched once the request that wrote it ends, so a conversation is an
append-only log with one live message at its end. Storing a log as a value had
consequences of its own:

- every write read, validated and rewrote the whole history, and every answer
  carried it, so a turn cost more with every day of use;
- one stored message the running build could not parse made the whole
  document read as empty, and the next write stored itself over the history —
  deploying a new part kind and rolling back was enough;
- two racing turns lost a whole write instead of failing.

What changes:

- **Stored as settled, returned as stored — per message.**
  `assistant_chat_messages` holds one row per message; `seq` orders the log and
  `message` stays opaque to the module.
- **Only the latest message can change.** The kit's port appends, and replaces
  the message it has just read as the latest; nothing can address an older one.
  A repeated message id is refused, so a turn whose lease lapsed fails instead
  of writing out of order.
- **Every route answers with a window**, not the whole conversation: the latest
  messages, the open question, and an opaque `olderCursor`;
  `GET /assistant/kit/messages?before=` returns the page before it. The
  guarantee against a second derivation is now that a response equals a reload
  of the latest window byte for byte, and that everything before a window is
  immutable, so a copy a client holds cannot go stale.
- **An unreadable message costs that message.** It is skipped and reported,
  never overwritten.
- **Ownership stays two independent answers:** the module's author rule on every
  read and write, and the kit's `bind`, now stored on each message and no longer
  sent to clients.
- `assistant_chat_state` keeps only the provider history, which genuinely is a
  value: a windowed working set, replaced whole.

Not changed: the pause, the claim, the turn lease, `appendParts`, and the rule
that an answer carries the conversation's current state rather than the
fragment one request produced.
