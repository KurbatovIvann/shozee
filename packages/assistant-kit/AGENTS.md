# assistant-kit — Agent Instructions

## The rule that governs every other one

**This package is not connected to any application. Not by an import, a type,
a name, a comment or an example.**

It does not know what an order, a customer, a product, a tenant or a company
is — and it does not know what kinds of question exist either. Those come from
the caller's registry.

Runtime dependencies: the model SDK and `zod`. Never a workspace package.

Read it as a stranger would: **if this sat in someone else's `node_modules`,
would it still make sense?** If the answer is no, the design is wrong — not the
naming.

One test enforces this, and it checks the isolation, not a list of forbidden
words. A blocklist of one product's nouns would itself be that product's
knowledge living here. Everything else is held by the shape: because the set of
kinds comes from the registry, there is no vocabulary here to leak.

## What it owns

A tool call pauses, a person answers, the model conversation resumes verbatim,
and one stored document is what both a live turn and a reload render.

An extension to the AI SDK, not a replacement: the caller keeps its single
`streamText`. This package owns only the gap between the loop stopping and the
next request arriving.

Does **not**: call a model, mount HTTP, own storage, render UI, hold a tool
registry, run a queue or scheduler.

## Mechanism, not vocabulary

`defineInteraction` and `createInteractions` are the seam. A kind carries its
own ttl, the schema of the payload a client may see, the schema of an answer it
accepts, and a pure function from answer plus private data to a resolved value.

The set of kinds is the set of registry keys, so the union is **derived**: a
mistyped kind is a type error and completions work, exactly as an enum would
give — but the enum belongs to the consumer.

Consequences worth keeping straight:

- ttl belongs to a kind, not to a deployment.
- An answer is validated by its own kind's schema, never by one wide union.
- `resolve` runs **before** the claim is consumed, so an answer that cannot
  mean anything leaves the pause answerable.
- A kind that is no longer registered makes an open pause `unknown_kind`; a
  caller treats that as gone. A pause can outlive the deploy that removed it.

## The two invariants everything else follows from

**1. Ambiguity is discovered by a read, never by attempting the write.** A tool
returns a pause as an ordinary output. Nothing here inspects an exception. A
tool that calls its write to learn whether it is ambiguous puts the pause
inside a half-done write, and a two-phase resume is the price.

**2. The pause stores the continuation, not a description of itself.** The exact
provider messages and the provider's own tool-call id are stored, so resume
replays them. Nothing is re-derived, so there is no id to mint and no boundary
sanitiser. `ProviderToolCallId` makes an unsendable id unstorable.

## Ownership

Every read and write of a pause is scoped by `{ conversationId, bind }`. `bind`
is an opaque owner token the caller supplies — identity and tenant, typically.
It is never interpreted, only matched exactly.

A mismatch is reported as `gone`, deliberately identical to "no such pause".
Distinguishing the two would let one owner probe another's conversation.

Slot occupancy ignores `bind`: one open pause per conversation, full stop.

## Secrets

`prompt` is public — it reaches the client and the model. `secret` never leaves
the server: `PublicPause` has no field able to hold it. Putting something
private in `prompt` is the caller's mistake to avoid; this package cannot tell
the difference.

## When the answer does not take

`claim` consumes a (interactionId, revision) exactly once — right for a write,
wrong when the action it authorised refused. `release` puts a claimed pause
back to open at the same revision.

The caller asserts the absence of effect; this package cannot know it. Never
call it after a write that may have committed — an idempotency key is what
makes a retry safe, not this.

## Testing

`./testing` supplies in-memory ports and deterministic providers. The registry
is a **parameter** of `testDeps`, not a default: a fixture here would quietly
become a shipped vocabulary.

The stream chunk shapes were **measured** against the pinned SDK, not assumed:
a malformed `finish` part is swallowed, the finish reason reads `other`, and
tools never execute — a suite that looks green while proving nothing. Keep that
knowledge in `testing.ts` rather than in each consumer.

`fixture.ts` holds the abstract kinds this package's own suites exercise
(`pick`, `confirm`). It is not exported from the root, and it is not a
suggestion.

## Status

Implemented; `SCENARIOS.md` green at the store, loop and route levels. The
first route consumer lives outside this package and is not reachable from a
production app yet.
