# @showzy/assistant-kit — Agent Instructions

Server-only protocol leaf. It owns one thing: **a tool call pauses, a human
answers, the model conversation resumes verbatim, and one stored document is
what both live and reload render.**

An extension to AI SDK 7, not a replacement. The caller keeps its single
`streamText`. This package owns only the gap between `stopWhen` firing and the
next request arriving.

## Hard scope

Does **not**: call a model, mount HTTP, own storage, render UI, hold a tool
registry, run a queue or scheduler, or name a domain concept.

`src/no-domain.test.ts` fails the build on a domain word anywhere in `src`. A
hit is not a naming problem — it means a decision belonging to a tool or to
the domain has moved into the protocol. That is exactly how the previous
runtime reached 961 lines in one file: a generic pause absorbed a hardcoded
action name, a domain input schema, and an enum of entity kinds.

## The two invariants everything else follows from

**1. Ambiguity is discovered by a read, never by attempting the write.** A tool
returns `needs_choice` as an ordinary output. The kit never inspects an
exception. A tool that calls its write to learn whether it is ambiguous puts
the pause inside a half-done write, and that is what forces a two-phase
resume with staged execution ids.

**2. The pause stores the continuation, not a description of itself.** The exact
provider messages and the provider's own tool-call id are stored, so resume
replays them. Nothing is re-derived from persisted rows, so there is no id to
mint and no boundary sanitizer. `ProviderToolCallId` makes an unsendable id
unstorable.

## Ownership

Every read and write of a pause is scoped by `{ conversationId, bind }`.
`bind` is an opaque owner token the caller supplies — in `apps/api` it is
`userId:companySelector`. The kit never interprets it and only requires an
exact match.

A mismatch is reported as `gone`, deliberately identical to "no such pause".
Distinguishing the two would let one tenant probe another's conversation.

Slot occupancy ignores `bind`: one open pause per conversation, full stop. Two
owners cannot both hold a pause on the same conversation id.

## When the answer does not take

`claim` consumes a (interactionId, revision) exactly once — right for a write,
wrong when the action it authorised refused. `release` puts a claimed pause
back to open at the same revision, so a validation failure does not make the
card vanish.

The caller asserts the absence of effect; the kit cannot know it. Never call it
after a write that may have committed — the domain's idempotency key is what
makes a retry safe, not this.

## Secrets

`resolvedInput` and `optionMap` live on `PauseRecord` (a TypeScript type,
server-only). `PublicPause` is a separate zod schema with no field able to
hold either, and no `entityId` on an option. Leaking one is a type error, not
a review catch. `optionId → entityId` is resolved by `entityIdFor` on the
server; the client sends only `optionId`.

## Contracts shared with clients

Wire types the phone or the panel must read do **not** get a new package —
they belong in `@showzy/validation`, a zod-only leaf already imported by
`@showzy/ai`, `apps/mobile` and `apps/web`. Duplicating a schema so a client
can avoid importing a server package is the pattern that produced
`resume-envelope.ts`.

## Ports

`PauseStore` (CAS), `DocumentStore`, `Clock`, `Ids`. All interfaces, all
supplied by the consumer's composition root. A test uses a `Map` and needs no
Redis, no database and no model — which is why the whole protocol is
verifiable in milliseconds. See `SCENARIOS.md`.

## Testing

`./testing` supplies in-memory ports and deterministic providers
(`stubModel`, `stubTextModel`, `stubBrokenModel`, and the step builders). The
chunk shapes there were **measured** against the pinned `ai` version, not
assumed: a malformed V4 `finish` part is swallowed, `finishReason` reads
`other`, and tools never execute — a suite that looks green while proving
nothing. Keep that knowledge in `testing.ts` rather than in each consumer.

## Status

Implemented, with `SCENARIOS.md` green at levels K and L. The first route
consumer is `apps/api/src/http/assistant-kit-choice.ts`, mounted on its own
path and not reachable from `createApp` — the live assistant is untouched.
