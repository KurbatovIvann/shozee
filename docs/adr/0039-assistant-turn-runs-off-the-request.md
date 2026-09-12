# ADR-0039: The assistant turn runs off the request

- **Status**: Accepted
- **Date**: 2026-09-11
- **Deciders**: Ivan Kurbatov (human) (+ proposing agent)

## Context

A turn lives exactly as long as the HTTP request that started it (ADR-0038).
`@hono/node-server` aborts the request signal when the connection closes, and
`/assistant/kit/chat` and `/assistant/kit/answer` pass that signal to the
model. On a phone this is the wrong lifetime. Locking the screen, moving the
app to the background or closing it closes the connection, and none of those
means "cancel my job".

What survives an abort today is sound: the person's message, every write a
tool committed with its card, and the model's memory of finished steps
(SHO-546). What is lost is everything that follows:

- the remaining steps and the reply;
- the tokens — the route still answers 200 into a closed socket, so the turn
  is charged;
- the truth on screen. The phone sees a network failure, puts the draft back
  in the composer and never re-reads, so it says "not sent" while the server
  holds the message and possibly a created order.

The facts the decision has to respect:

- **Redis is rebuildable, and it holds secrets.** `db.md` §6 treats Redis as
  rebuildable; any non-rebuildable use needs its own persistence policy. The
  worker's job host runs only work that is safe to miss, and durable one-shot
  jobs wait for that policy (`apps/worker/AGENTS.md`). The same Redis holds
  better-auth secondary storage, which keeps phone OTP codes in plaintext
  (`apps/api/src/auth/options.ts`): persisting that instance would put them on
  disk and in backups (`security-operations.md` §2).
- **BullMQ is the execution host.** ADR-0007 chose BullMQ on Redis for
  execution jobs and rejected a Postgres queue.
- **The outbox runs system actions.** A subscription is a system-principal
  action run inside the delivery transaction, with five fast retries
  (`core.md` §6). A turn runs as a staff member, lasts up to minutes, spans many
  transactions and calls a costly, non-deterministic model.
- **Core does not need the request to act as a person.** It resolves a staff
  principal from the user id and company selector against `company_members` on
  every action. Revoked membership still refuses.
- **The worker cannot reach the runtime.** The runtime lives in `apps/api`,
  and the worker may import only its approved `@showzy/api/subscriptions`
  subpath, never its runtime internals.
- **The system has no realtime transport.** `security-operations.md` expects
  SSE and Socket.IO subscriptions to be authorized like HTTP actions.

## Decision

**A turn is accepted by the API, executed by the worker, and delivered to the
client as events. Postgres is the truth about the conversation; Redis carries
the queue and the events.**

- **Accept.** In one Postgres transaction the API claims the conversation's
  active turn, stores the person's message under an id derived from the
  command, and stores an assistant placeholder whose text is `streaming`. It
  then enqueues a job whose id is derived from the same command, and answers
  `202` with the window. Repeating a command returns the conversation as it
  now stands and runs nothing twice. The turn lease and the command receipt
  live on these Postgres rows, not in Redis. *(Amended 2026-09-12, SHO-563: a
  deviation found in implementation, not a design change — the accept is the
  receipt for its own idempotency, but the routes keep a Redis `SET NX` guard
  in front of it, because `/kit/answer` claims the pause before it accepts and
  a claim is exactly-once, so the accept's own `replayed` outcome cannot guard
  a retry that never reaches it.)*
  - The turn row carries what the worker and the reconciler need and the
    request would otherwise take with it: the accept's kind (`chat` |
    `answer`) and the turn's `commandId`, the placeholder's message id, the
    company, the author, the request id the turn's actions are audited under,
    and the budget hold (company and global reservation, Kyiv date). The kind
    is stored, never inferred from other columns: the reconciler derives the
    `jobId` from it, and a guess that disagreed with the accept would name a
    second job for one turn. *(Amended 2026-09-11, SHO-561: an earlier wording
    also listed the session id and an answer's earned seed as what the worker
    needs. It needs neither: the actor is `user_id`, and an answer runs from
    history. The session id stays on an active row; the worker does not read
    it.)*
  - **An answer keeps its synchronous half.** The pause is claimed and the
    resolved action runs in the request, exactly as today, so `stale`,
    `unresolvable`, `action_failed` and a second question are still
    immediate, and a committed write is stored before generation is attempted
    (SHO-546). The action's card is stored in Postgres, on the placeholder, as
    the part already earned. Before it accepts, the answer route saves the
    messages `kit.resume` resumed as the conversation's history, so the worker
    runs an answer turn exactly as it runs a chat turn: from history. There is
    no answer seed on the turn row. Order: claim the pause, run the action,
    accept, then save the history; an accept refused because another turn
    holds the conversation releases the claim. *(Amended 2026-09-12, SHO-563:
    an earlier wording put the save before the accept. The owner's T3c decision
    requires the reverse — history written before the accept has claimed the
    lease can overwrite a still-running turn's history, and a `busy` accept must
    mean nothing was written.)* An answer's accept stores no
    person's message, only the placeholder. *(Amended 2026-09-11, SHO-561: an
    earlier wording had the worker read the action's result from the
    placeholder, which would have given an answer turn a second way to start.
    The placeholder still carries the earned card.)*
- **Execute.** A BullMQ `assistant` queue on the worker runs the turn as the
  staff member who asked. The API is the producer and the worker the consumer,
  so the queue contract — name, prefix, job payload schema, the `jobId`
  derivation — lives in the shared runtime package, not in either app. The
  job is a pointer: its payload is the turn's kind, conversation id and
  command id, lowercased so the accept and the reconciler derive one `jobId`.
  Postgres is the source of everything else. The worker loads the turn row
  through a global system read of the job's identity; the actor is the row's
  `user_id`, which the accept took from its verified context, and the company
  comes from the same row. Only that read produces the caller a turn runs as,
  never a job payload. Authority is membership, which core checks again on
  every action the turn runs, so a member removed mid-turn is refused at the
  next action. There is no session read: a turn accepted before its author
  signed out may still finish, as any command accepted before sign-out does.
  *(Amended 2026-09-11, SHO-560: an earlier wording let the session give the
  user, which would have made an input identifier an identity grant.)*
  *(Amended 2026-09-11, SHO-561: the SHO-560 wording kept the session as a
  liveness check — the worker refused a job unless the `session` row existed,
  was unexpired and belonged to `user_id`. The owner removed it: identity is
  `user_id`, authority is the membership core enforces, and signing out is not
  a cancel. `session_id` stays on an active row and is not read.)*
  The reconciler rebuilds a lost job from that row alone. A server-side timeout
  is the only thing that ends a turn early; a closed connection never does.
  Each card is written to the live message as its tool completes, and each
  finished step is saved to history. Budget is reserved on accept; the worker
  releases the hold when the turn never reached the model and otherwise
  leaves the reservation as the charge, which is what settlement does today.
  Whoever ends a turn — the worker finishing it or the reconciler interrupting
  it — zeroes the row's hold in the same statement and is handed the hold it
  zeroed, so a hold is settled or released at most once, and a release never
  takes a counter below zero. *(Amended 2026-09-11, SHO-561: added; the
  earlier wording did not say who releases a hold when both could.)*
- **Fail visibly, never twice.** A turn runs once (`attempts: 1`), and a job
  whose worker disappears fails instead of re-running (`maxStalledCount: 0`).
  The turn becomes `interrupted`: what it did stays, the message's text part
  gets the status `interrupted`, and **Продовжити** starts a new turn from
  the saved history.
  - **Продовжити runs under the original command.** History is saved per
    finished step, so a turn that died inside a tool keeps the card of the
    write but not the model's memory of it. A continuation with its own
    command would give the same action a new idempotency key and could write
    twice — the seam SHO-547 closed. The continuation is its own command for
    the receipt, but its tools derive their idempotency keys from the
    interrupted turn's `commandId`, so a repeated call of the same action
    replays the first.
  - A reconciler on the maintenance scheduler re-enqueues an accepted turn
    that never got a job and interrupts a running turn past its deadline, and
    nothing else: a queued turn, or a running turn inside its deadline, is
    never interrupted. The interrupt hands the reconciler the turn's hold. It
    cannot tell whether a stale running turn reached the model, so it leaves
    the reservation as the charge, which fails safe. A finisher that commits
    and then dies before it settles or releases leaves a hold that no row
    names any more: it stays reserved until its Kyiv-day key expires. That
    also fails safe — the day's cap is reached early, never lifted — and is
    accepted. Jobs are removed on completion and on failure, so a re-enqueue
    under the same `jobId` is never a no-op against a stale record.
    *(Amended 2026-09-11, SHO-561: an earlier wording had the reconciler also
    release orphaned budget holds. Ending a turn now zeroes its row's hold in
    the same statement, so no row names a hold once its turn has ended, and
    there is nothing left for a reconciler to find.)*
    *(Amended 2026-09-12, SHO-570: the reconciler also interrupts a **queued**
    turn that the queue no longer holds a job for and that has not started
    within the abandon threshold — 15 minutes. Both conditions are needed, and
    the second alone would be wrong: one worker runs 4 turns at once, each up
    to 180 s, so it drains about 1.33 turns a minute at worst, and a backlog of
    roughly twenty turns ages a perfectly healthy queued turn past fifteen
    minutes. What tells the two apart is the job — a backlogged turn has one
    waiting however deep the queue, while a turn refused at start completes its
    job, which is then removed. The threshold lives in the guarded UPDATE and
    the job check lives in the reconciler, which can therefore only narrow what
    is ended, never widen it.
    A queued turn whose author lost membership, or whose job is refused at
    every attempt, can never start, and the earlier wording left it holding its
    author's conversation and its reservation for ever. The predicate is
    computed by Postgres in the same guarded UPDATE as running-past-deadline,
    so there is one definition of what may be ended; `startTurn` is a
    compare-and-set on `queued`, so exactly one of a start and this interrupt
    wins. Such a turn never reached the model, so its hold **is** released —
    the interrupt says which state it ended the turn from — while a running
    turn's reservation still stands as the charge. Re-enqueue of a queued turn
    with no job backs off per turn, and the threshold is its hard bound.)*
    *(Amended 2026-09-12, SHO-563: re-checked where real queue depth first
    appears — the routes now enqueue. The threshold is unchanged, and it is
    deliberately **not** depth-aware: it can only end a turn the queue holds no
    job for, so a backlog never reaches it however deep it is and however slowly
    it drains. Drain rate would bound this only if age alone could end a turn,
    and the job check is exactly what stops that. Raising concurrency or the
    threshold would change nothing for a backlogged turn; it would only delay
    ending a turn that can never start.)*
  - After a worker crash the interruption becomes visible only when the
    reconciler passes the deadline — up to the turn timeout plus one
    reconciler interval. Accepted, and stated so nobody reads it as a hang.
  - Deploys drain in-flight turns; the stop grace period is at least the turn
    timeout. *(Amended 2026-09-12, SHO-570: shutdown waits for this worker's
    turns and no longer than the turn timeout plus room for a stopped turn's
    last writes. Past that bound the process says so and goes, and the turn's
    row is the reconciler's to interrupt — the recovery a crashed worker
    already gets. The platform's stop grace period must be at least that
    bound; there is no production environment yet, so it is recorded in
    `apps/worker/AGENTS.md` and the runbook, not configured.)*
- **Persist the queue, on its own Redis.** Durable queues live on a dedicated
  queue Redis that runs with AOF (`appendonly yes`, `appendfsync everysec`) on
  a persistent volume and with `maxmemory-policy noeviction`. It is this
  system's first non-rebuildable Redis use, so the policy lands in `db.md` §6.
  Up to a second of queue loss is covered by the reconciler, because the
  accepted turn is already in Postgres. There is no production environment
  yet: the compose file is the development form of this policy, and the
  production form is a requirement recorded now and checked when the
  infrastructure is built.
  - **Separate from the shared Redis.** The shared Redis holds better-auth
    secondary storage, which keeps phone OTP codes in plaintext, alongside
    rate limits, confirmation challenges and pauses. Persisting it would put
    those codes on disk and in backups, and its eviction would drop jobs. The
    shared Redis stays non-persistent; the worker's safe-to-miss jobs may stay
    on it.
  - **No personal data on the queue's disk.** The payload is the turn's
    identity only, so no person, session, company or client IP is written to
    the append-only file. Removing a job only appends a delete to that file,
    so retention cannot be the reason a field is safe there.
- **Deliver as events.** `GET /assistant/kit/events` streams server-sent
  events under the same session, company and author rule as the other routes.
  - Every connection begins with a `snapshot` of the latest window, then
    `turn.started`, `message.updated` and `turn.finished` as the worker
    publishes them to a per-conversation Redis channel.
  - **Every message carries a revision.** The message log bumps it on each
    update and every window and event returns it, so a client that holds two
    copies of one message — the `202` window and a `message.updated` that
    overtook it — keeps the higher one. Without it, the placeholder from the
    accept could overwrite a card that had already arrived.
  - `message.updated` carries the latest message whole; `turn.finished`
    carries the status and the latest window, because the window's
    `openPause` is the authority on which question is answerable and no
    message can say that alone. *(Amended 2026-09-12, SHO-570: a
    `turn.finished` published by the reconciler carries **no** window. That
    pass acts for no person, and a conversation is read as the person whose
    conversation it is; a client told that a turn ended reads the conversation
    itself. The window is therefore optional on that event, and a reader must
    handle its absence.)*
  - Because a connection always starts from a snapshot, a lost pub/sub message
    costs nothing.
  - `text.delta` is reserved for streaming tokens later.
  - Clients re-read on reconnect and on returning to the foreground; nothing
    polls on a timer.
- **Notify the absent.** A turn that finishes with nobody subscribed sends a
  push notification.
- **One runtime, two processes.** The server half of the assistant — runtime
  composition, tools, resolution, confirmation, history window, stores, budget
  guard — moves into a server-only package that both `apps/api` and
  `apps/worker` import. HTTP handlers stay in the API.
- **The client never cancels a turn.** `AssistantKitCall.signal` and the
  client's `499 → aborted` mapping go away. A stop button, if one comes, is an
  explicit route.

Starting values (policy, changed with a proving test):

| Setting | Value |
| --- | --- |
| Turn timeout | 180 s |
| Queue concurrency per worker | 4 |
| Job lock | 60 s, renewed |
| Reconciler interval | 60 s |
| Queued-turn abandon threshold | 15 min (SHO-570) |
| Re-enqueue backoff | 60 s, doubling per attempt, capped at 8 min (SHO-570) |
| Worker drain bound | turn timeout + 30 s (SHO-570) |
| SSE heartbeat | 15 s |
| Job retention | removed on completion and on failure |

## Alternatives considered

- **Keep one long request, but stop passing the abort signal.** Rejected: the
  turn then finishes, but a deploy or an API restart still kills it, and the
  phone still has no way to learn the outcome except re-reading.
- **Keep the abort and fix only the screen.** Rejected: unfinished work stays
  unfinished, and a repeat after an abort inside a tool can write twice.
- **Run the turn in the API process after responding.** Rejected: it does not
  survive a deploy, and it puts minute-long work on the request-serving
  process.
- **A Postgres queue** (pg-boss, graphile-worker, or a claim loop over a turns
  table). Rejected by ADR-0007, and the BullMQ host already exists. Postgres
  keeps the part that must not be lost, the accepted turn, without also
  becoming the queue.
- **The domain-event outbox.** Rejected: wrong principal, wrong transaction
  model, and retry semantics built for fast idempotent effects (`core.md` §6).
- **A durable-execution engine** (Temporal, Inngest, Restate, DBOS). Rejected
  for now: it adds a second runtime or service (see ADR-0038's alternatives).
  Its advantage — resuming a crashed turn from its last step — is worth that
  cost only when turns become multi-minute workflows such as reports. Revisit
  then.
- **Automatically re-running a stalled turn.** Rejected: the model is not
  deterministic, and a re-run after a committed write may choose differently.
  Visible interruption plus **Продовжити** from saved history gives the same
  recovery without guessing.
- **Polling the window.** Rejected: periodic requests from a phone for state
  the server can push.
- **WebSocket / Socket.IO.** Rejected for this: events flow one way, and
  commands are already idempotent POSTs. SSE keeps HTTP semantics, cookies and
  proxies as they are. Two-way realtime (customer chat) may justify a socket
  later, and the event contract can move onto it.

## Consequences

- **Amendments and specs.** ADR-0038 is amended: the turn lease and command
  receipts move from Redis to Postgres, and cards are written as each tool
  completes rather than at the end of the turn. `db.md` §6 gains a second
  Redis instance: the queue Redis persists and never evicts, and the shared
  Redis stays non-persistent so OTP codes never reach disk.
  `apps/worker/AGENTS.md` allows durable assistant jobs on the queue Redis
  only.
- **The worker becomes an AI process.** It needs the provider configuration it
  already receives through `ServerConfig`, the new runtime package, and a stop
  grace period of at least the drain bound named in the 2026-09-12 amendment
  above (the turn timeout plus room for a stopped turn's last writes). The rule
  that the API composition
  root alone mounts the AI loop (ADR-0032's import boundary) widens to both
  server processes; domain modules still may not import `@showzy/ai`. The
  worker's processors are thin by rule; the assistant processor is the named
  exception, because a turn is the work.
- **The API becomes a producer.** It gains BullMQ as a dependency, for the
  `Queue` only; it never processes jobs. Both processes gain a connection to
  the queue Redis, configured separately from `REDIS_URL` (SHO-561, SHO-563).
- **The message wire grows two fields:** a `revision` on every message
  (SHO-562) and the text status `interrupted` (SHO-561, SHO-563); the strict
  wire test pins them. *(Amended 2026-09-11, SHO-562: an earlier wording
  called both additive, so that an older client keeps parsing. They are not:
  the client schema is strict. A client build that predates `revision` drops
  every message, because every message carries it as an unknown key, and so
  shows an empty thread. A build that predates `interrupted` drops each
  message whose text part carries that unknown status. That is accepted while
  no production client exists (root `AGENTS.md`, "No production yet"). Once
  one exists, a wire change must be one an older build tolerates.)*
- **Realtime and push are new.** SSE is the system's first realtime transport,
  and it is authorized exactly like the HTTP routes. Push adds a device-token
  store, which is personal data.
- **Every accepted turn runs to the end and is charged,** whether or not
  anyone is watching.
- **The client simplifies.** It stops tracking request lifetimes: the window
  says whether a turn is active, a draft returns only on a synchronous refusal,
  and a network failure on accept is retried under the same command.
- **Streaming tokens becomes additive** — a new event type, not a new
  transport.
- **Delivered in slices SHO-557 T1–T7.** Only the switch (T5) changes behaviour.
