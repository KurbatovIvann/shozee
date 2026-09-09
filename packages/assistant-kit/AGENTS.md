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

## Status

Contract only. `createAssistantKit` is `declare`d, not implemented. Do not add
an implementation in the same change as an API change to this surface.
