/**
 * The four `assistant-kit` routes at the HTTP level, after the switch
 * (SHO-563, ADR-0039).
 *
 * No database, no queue Redis and no live model: auth, both stores, the turn
 * store, the history port and the queue are injected, so this suite runs in a
 * couple of seconds and can be run on every save.
 *
 * **What these routes do now is accept.** A send stores the person's message
 * and an assistant placeholder in one accept, puts a job on the queue and
 * answers `202` with the window both messages are already in; the turn runs in
 * the worker. So the assertions here are about what was *stored and queued*,
 * never about a reply — an unfinished turn, a provider failure, a pause a tool
 * asked for and the log line for a turn that did not finish all belong to the
 * processor's suite, because that is where they can now happen.
 *
 * The two properties this file exists to hold down:
 *
 * - **Nothing reads the request signal.** A closed connection is not a cancel,
 *   so a request whose signal is already aborted is accepted exactly like any
 *   other.
 * - **Nothing is written before the lease is claimed.** A `busy` accept leaves
 *   the running turn's messages and its history untouched.
 */
import {
  createAssistantKit,
  type AssistantKit,
  type ModelMessage,
  type ToolOutcome,
  type ToolSet,
} from "@showzy/assistant-kit";
import { stubTextModel, testDeps } from "@showzy/assistant-kit/testing";
import {
  ASSISTANT_CHAT_WINDOW_MESSAGES,
  assistantInteractions,
  assistantTurnJobId,
  assistantTurnMessageId,
  memoryAssistantKitCommands,
  memoryAssistantTurnStore,
  type AssistantHistoryPort,
  type AssistantInteractionTypes,
  type AssistantTurnJob,
  type AssistantTurnQueue,
  type AssistantTurnStore,
  type ChoiceResolution,
  type ResolveAnswer,
} from "@showzy/assistant-runtime";
import { COMPANY_SELECTOR_HEADER } from "@showzy/contract";
import { ConflictError, CoreInvariantError } from "@showzy/core/errors";
import pino, { type Logger } from "pino";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  ASSISTANT_KIT_ABANDON_PATH,
  ASSISTANT_KIT_ANSWER_PATH,
  ASSISTANT_KIT_CHAT_PATH,
  ASSISTANT_KIT_MESSAGES_PATH,
  createAssistantKitApp,
} from "./assistant-kit.js";

function silentLogger(): Logger {
  return pino({ level: "silent" });
}

const USER = "user-1";
const COMPANY = "11111111-1111-4111-8111-1111111111aa";
const OTHER_COMPANY = "22222222-2222-4222-8222-2222222222bb";
const CONVERSATION = "33333333-3333-4333-8333-333333333333";
const COMMAND = "44444444-4444-4444-8444-444444444444";
const OTHER_COMMAND = "55555555-5555-4555-8555-555555555555";

type Kit = AssistantKit<AssistantInteractionTypes>;

function memoryHistory(): AssistantHistoryPort & {
  readonly saved: ModelMessage[][];
} {
  const byKey = new Map<string, ModelMessage[]>();
  const saved: ModelMessage[][] = [];
  return {
    saved,
    load: (scope) =>
      Promise.resolve(byKey.get(`${scope.bind}:${scope.conversationId}`) ?? []),
    save: (scope, messages) => {
      byKey.set(`${scope.bind}:${scope.conversationId}`, [...messages]);
      saved.push([...messages]);
      return Promise.resolve();
    },
  };
}

/** The jobs this process put on the queue, in order. */
function memoryQueue(options?: {
  readonly broken?: boolean;
}): AssistantTurnQueue & {
  readonly added: AssistantTurnJob[];
  readonly ids: string[];
} {
  const added: AssistantTurnJob[] = [];
  const ids: string[] = [];
  return {
    added,
    ids,
    add: (_name, data, opts) => {
      if (options?.broken === true) {
        return Promise.reject(new Error("queue is unreachable"));
      }
      added.push(data);
      ids.push(opts.jobId);
      return Promise.resolve(undefined);
    },
    getJob: (jobId) =>
      Promise.resolve(ids.includes(jobId) ? { id: jobId } : undefined),
  };
}

const OK_RESOLVE: ResolveAnswer = ({ value }) => {
  const resolution = value as ChoiceResolution;
  return Promise.resolve({
    kind: "ok",
    result: { entityId: resolution.entityId, number: "CO-1" },
    card: {
      cardId: "card-entity",
      type: "order-entity",
      payload: { entityId: resolution.entityId, number: "CO-1" },
    },
  });
};

const FAILING_RESOLVE: ResolveAnswer = () =>
  Promise.resolve({
    kind: "error",
    code: "CONFLICT",
    message: "no longer available",
  } satisfies ToolOutcome);

const pausingInput = z.object({ label: z.string() });

/** Resolves one ambiguity into the next: a second question, still synchronous. */
const SECOND_QUESTION: ResolveAnswer = () =>
  Promise.resolve({
    kind: "pause",
    interaction: "choice",
    prompt: {
      subject: "which product",
      options: [
        { optionId: "opt-c", label: "C" },
        { optionId: "opt-d", label: "D" },
      ],
      optionsTruncated: false,
    },
    secret: {
      byOption: { "opt-c": "entity-c", "opt-d": "entity-d" },
      toolName: "orders_create",
      input: { label: "which product" },
      target: { kind: "customer", query: "which product" },
    },
  } satisfies ToolOutcome);

const PAUSING_TOOLS: ToolSet = {
  orders_create: {
    description: "create one",
    inputSchema: pausingInput,
    execute: (input: z.output<typeof pausingInput>): ToolOutcome => ({
      kind: "pause",
      interaction: "choice",
      prompt: {
        subject: input.label,
        options: [
          { optionId: "opt-a", label: "A" },
          { optionId: "opt-b", label: "B" },
        ],
        optionsTruncated: false,
      },
      secret: {
        byOption: { "opt-a": "entity-a", "opt-b": "entity-b" },
        toolName: "orders_create",
        input,
        target: { kind: "customer", query: input.label },
      },
    }),
  },
};

interface Harness {
  readonly kit: Kit;
  readonly app: ReturnType<typeof createAssistantKitApp>;
  readonly history: ReturnType<typeof memoryHistory>;
  readonly queue: ReturnType<typeof memoryQueue>;
  readonly turns: AssistantTurnStore;
  readonly bind: string;
}

function harness(options?: {
  readonly session?: { user: { id: string }; session: { id: string } } | null;
  readonly resolveAnswer?: ResolveAnswer;
  readonly logger?: Logger;
  readonly tools?: ToolSet;
  /** Held open to keep an answer's synchronous half in flight. */
  readonly toolsGate?: Promise<unknown>;
  /** No queue at all: the turn is still accepted, for the reconciler to enqueue. */
  readonly noQueue?: boolean;
  readonly brokenQueue?: boolean;
  /**
   * How the first accept fails.
   *
   * - `conflict` — a core refusal, so `acceptProvedRollback` proves nothing was
   *   stored.
   * - `internal` — raised before COMMIT, which nothing can prove. The case
   *   `/kit/chat` must still give its command back for.
   * - `internal-after-commit` — stored, then failed on the way out, so a retry
   *   finds the turn row.
   */
  readonly acceptThrows?: "conflict" | "internal" | "internal-after-commit";
  /** The history cannot be saved: pins that the job is added only after it is. */
  readonly brokenHistorySave?: boolean;
  /**
   * Makes every message write refuse, as a message another writer changed under
   * this one does (SHO-570). The accept sees the refusal; this suite's own reads
   * still go through the real kit.
   */
  readonly writeRefusal?: "conflict" | "unchanged";
}): Harness {
  // The window the routes really run with, so a page here is a page on a phone.
  const deps = testDeps(assistantInteractions, {
    windowMessages: ASSISTANT_CHAT_WINDOW_MESSAGES,
  });
  const kit = createAssistantKit(deps);
  const refusal = options?.writeRefusal;
  const served: Kit =
    refusal === undefined
      ? kit
      : {
          ...kit,
          messages: {
            ...kit.messages,
            write: () => Promise.resolve({ kind: refusal }),
          },
        };
  const realHistory = memoryHistory();
  const history =
    options?.brokenHistorySave === true
      ? {
          ...realHistory,
          save: () => Promise.reject(new Error("history is down")),
        }
      : realHistory;
  const queue = memoryQueue({ broken: options?.brokenQueue === true });
  // Written through the served kit, so a refused write is a failed accept.
  const accepting = memoryAssistantTurnStore(served.messages);
  const failAs = options?.acceptThrows;
  let acceptsToFail = failAs === undefined ? 0 : 1;
  const turns: AssistantTurnStore = {
    ...accepting,
    accept: async (input) => {
      if (acceptsToFail > 0) {
        acceptsToFail -= 1;
        if (failAs === "conflict") {
          throw new ConflictError("the accept was rolled back");
        }
        if (failAs === "internal-after-commit") {
          // It committed, and then failed on the way out. The row is there.
          await accepting.accept(input);
        }
        throw new CoreInvariantError("the accept was not acknowledged");
      }
      return accepting.accept(input);
    },
  };
  const app = createAssistantKitApp({
    logger: options?.logger ?? silentLogger(),
    commands: memoryAssistantKitCommands(),
    ...(options?.noQueue === true ? {} : { queue }),
    auth: {
      api: {
        getSession: () =>
          Promise.resolve(
            options?.session === undefined
              ? { user: { id: USER }, session: { id: "session-1" } }
              : options.session,
          ),
      },
    },
    // In-memory stores for every caller: this suite is about the handlers, and
    // the durable adapters have their own test against a real database.
    forCaller: () => ({ kit: served, history, turns }),
    staffCompany: () => Promise.resolve(COMPANY),
    model: stubTextModel("Готово."),
    tools: async () => {
      await options?.toolsGate;
      return options?.tools ?? {};
    },
    resolveAnswer: options?.resolveAnswer ?? OK_RESOLVE,
    prompt: () => ({ system: "you are a test" }),
  });
  return { kit, app, history, queue, turns, bind: `${USER}:${COMPANY}` };
}

async function openPause(kit: Kit, bind: string) {
  const opened = await kit.open({
    conversationId: CONVERSATION,
    bind,
    kind: "choice",
    prompt: {
      subject: "two matches",
      options: [
        { optionId: "opt-a", label: "A" },
        { optionId: "opt-b", label: "B" },
      ],
      optionsTruncated: false,
    },
    secret: {
      byOption: { "opt-a": "entity-a", "opt-b": "entity-b" },
      toolName: "orders_create",
      input: { customerQuery: "two matches", items: [] },
      target: { kind: "customer", query: "two matches" },
    },
    continuation: {
      messages: [
        { role: "user", content: "create one" },
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "toolu_create",
              toolName: "orders_create",
              input: { label: "two matches" },
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "toolu_create",
              toolName: "orders_create",
              output: { type: "json", value: { status: "paused" } },
            },
          ],
        },
      ],
      pausedToolCall: { id: "toolu_create" as never, name: "orders_create" },
    },
  });
  if (opened.kind !== "opened")
    throw new Error(`expected opened: ${opened.kind}`);
  return opened.pause;
}

function headersFor(company: string): Headers {
  const headers = new Headers({ "content-type": "application/json" });
  if (company.length > 0) {
    headers.set(COMPANY_SELECTOR_HEADER, company);
  }
  return headers;
}

async function post(
  app: Harness["app"],
  path: string,
  body: unknown,
  options?: { readonly company?: string; readonly signal?: AbortSignal },
): Promise<Response> {
  return await app.request(
    new Request(`http://local${path}`, {
      method: "POST",
      headers: headersFor(options?.company ?? COMPANY),
      body: JSON.stringify(body),
      ...(options?.signal !== undefined ? { signal: options.signal } : {}),
    }),
  );
}

async function get(
  app: Harness["app"],
  path: string,
  options?: { readonly company?: string },
): Promise<Response> {
  return await app.request(
    new Request(`http://local${path}`, {
      method: "GET",
      headers: headersFor(options?.company ?? COMPANY),
    }),
  );
}

function chatBody(text = "покажи замовлення", commandId = COMMAND) {
  return { commandId, conversationId: CONVERSATION, text };
}

function answerBody(
  interactionId: string,
  revision: number,
  optionId = "opt-b",
) {
  return {
    commandId: COMMAND,
    conversationId: CONVERSATION,
    interactionId,
    revision,
    answer: { optionId },
  };
}

/**
 * Every route answers with the conversation's latest window, so one type covers
 * them all. `parts` is loosely typed here on purpose: this suite reads the wire,
 * not the package's own union.
 */
type KitBody = {
  readonly status?: string;
  readonly reason?: string;
  readonly code?: string;
  readonly window?: {
    readonly messages: readonly {
      readonly role: string;
      readonly parts: readonly {
        readonly kind: string;
        readonly type?: string;
        readonly text?: string;
        readonly status?: string;
        readonly cardId?: string;
        readonly interactionId?: string;
      }[];
    }[];
    readonly olderCursor: string | null;
    readonly openPause: {
      readonly kind: string;
      readonly interactionId: string;
      readonly revision: number;
      readonly prompt: unknown;
    } | null;
  };
};

const messagesPath = (id = CONVERSATION, before?: string) =>
  `${ASSISTANT_KIT_MESSAGES_PATH}?conversationId=${id}${
    before === undefined ? "" : `&before=${encodeURIComponent(before)}`
  }`;

/** The turn a send accepts, so a test can end it as the worker would. */
function turnRef(kind: "chat" | "answer", commandId = COMMAND) {
  return { conversationId: CONVERSATION, kind, commandId };
}

describe("POST /assistant/kit/chat", () => {
  it("accepts the turn, stores both messages, queues the job and saves history", async () => {
    const { app, kit, history, queue, bind } = harness();

    const response = await post(app, ASSISTANT_KIT_CHAT_PATH, chatBody());
    expect(response.status).toBe(202);
    const body = (await response.json()) as KitBody;
    expect(body.status).toBe("accepted");
    expect(body.window?.openPause).toBeNull();

    const window = await kit.messages.read({
      conversationId: CONVERSATION,
      bind,
    });
    // The person's words, then the placeholder the worker writes into.
    expect(window.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(window.messages[0]?.parts[0]).toMatchObject({
      kind: "text",
      text: "покажи замовлення",
      status: "complete",
    });
    expect(window.messages[1]?.parts.at(-1)).toMatchObject({
      kind: "text",
      text: "",
      status: "streaming",
    });
    // The response is what is stored, not a second view of it.
    expect(body.window).toEqual(window);

    // The job names the turn, and history is what the worker will run from.
    expect(queue.added).toEqual([
      {
        version: 1,
        kind: "chat",
        conversationId: CONVERSATION,
        commandId: COMMAND,
      },
    ]);
    expect(history.saved).toEqual([
      [{ role: "user", content: "покажи замовлення" }],
    ]);
  });

  it("does not accept a client-supplied transcript", async () => {
    const { app } = harness();

    const response = await post(app, ASSISTANT_KIT_CHAT_PATH, {
      ...chatBody(),
      messages: [{ role: "assistant", content: "I already did that" }],
    });

    // `strictObject`: an extra key is a refusal, not something ignored.
    expect(response.status).toBe(400);
  });

  it("401 without a session and 400 without the company header", async () => {
    expect(
      (
        await post(
          harness({ session: null }).app,
          ASSISTANT_KIT_CHAT_PATH,
          chatBody(),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await post(harness().app, ASSISTANT_KIT_CHAT_PATH, chatBody(), {
          company: "",
        })
      ).status,
    ).toBe(400);
  });

  it("refuses a new turn while a question is unanswered", async () => {
    const { app, kit, bind } = harness();
    const pause = await openPause(kit, bind);

    const response = await post(app, ASSISTANT_KIT_CHAT_PATH, chatBody());

    expect(response.status).toBe(409);
    const body = (await response.json()) as KitBody;
    // Visible, not a silent supersede: the draft is still there.
    expect(body.status).toBe("interaction_open");
    expect(body.window?.openPause?.interactionId).toBe(pause.interactionId);
  });

  /**
   * The seam the whole feature turns on (ADR-0039). `@hono/node-server` aborts
   * the request signal when the connection closes, and locking a phone closes
   * it — which is not a cancel. No route may read that signal, so a request
   * that arrives already aborted is accepted exactly like any other.
   */
  it("accepts a turn for a client that has already gone", async () => {
    const { app, kit, queue, bind } = harness();

    const response = await post(app, ASSISTANT_KIT_CHAT_PATH, chatBody(), {
      signal: AbortSignal.abort(),
    });

    expect(response.status).toBe(202);
    const window = await kit.messages.read({
      conversationId: CONVERSATION,
      bind,
    });
    expect(window.messages).toHaveLength(2);
    expect(queue.added).toHaveLength(1);
  });

  /**
   * A repeated command is the retry of a send whose reply was lost. It accepts
   * nothing a second time and answers with the conversation as it now stands —
   * including whatever the first attempt's turn has since done (SHO-547).
   */
  it("answers a repeated command with the current window and accepts nothing twice", async () => {
    const { app, kit, history, queue, bind } = harness();

    const first = await post(app, ASSISTANT_KIT_CHAT_PATH, chatBody("створи"));
    const retry = await post(app, ASSISTANT_KIT_CHAT_PATH, chatBody("створи"));

    expect([first.status, retry.status]).toEqual([202, 202]);
    const window = await kit.messages.read({
      conversationId: CONVERSATION,
      bind,
    });
    expect(window.messages).toHaveLength(2);
    expect(queue.added).toHaveLength(1);
    expect(history.saved).toHaveLength(1);
    expect(((await retry.json()) as KitBody).window).toEqual(window);
  });

  /**
   * Both ids are lowercased before the receipt, the turn row or its message ids
   * exist. Otherwise a continuation, which reads the lowercased id back from
   * Postgres, derives a different idempotency key and the SHO-547 double-write
   * reopens.
   */
  it("lowercases both ids at parse, so a mixed-case command is the same command", async () => {
    const { app, kit, queue, bind } = harness();
    const upper = {
      commandId: COMMAND.toUpperCase(),
      conversationId: CONVERSATION.toUpperCase(),
      text: "створи",
    };

    const first = await post(app, ASSISTANT_KIT_CHAT_PATH, upper);
    const retry = await post(app, ASSISTANT_KIT_CHAT_PATH, chatBody("створи"));

    expect([first.status, retry.status]).toEqual([202, 202]);
    // One turn, stored under the lowercase conversation the kit reads.
    const window = await kit.messages.read({
      conversationId: CONVERSATION,
      bind,
    });
    expect(window.messages).toHaveLength(2);
    expect(queue.added).toHaveLength(1);
    expect(queue.ids).toEqual([
      assistantTurnJobId({
        kind: "chat",
        conversationId: CONVERSATION,
        commandId: COMMAND,
      }),
    ]);
    // The message ids are the ones the lowercase command derives.
    expect(window.messages[0]?.messageId).toBe(
      assistantTurnMessageId({ kind: "chat", commandId: COMMAND }, "user"),
    );
  });

  /**
   * One turn at a time per conversation, or two of them interleave their
   * messages (SHO-548). The turn row is the lease now, so it holds for as long
   * as the turn actually runs — not for the length of a request.
   */
  it("refuses a second send while the first turn is still queued", async () => {
    const { app, kit, history, bind } = harness();
    await post(app, ASSISTANT_KIT_CHAT_PATH, chatBody("створи"));
    const savedBefore = history.saved.length;

    const second = await post(app, ASSISTANT_KIT_CHAT_PATH, {
      ...chatBody("а тепер покажи"),
      commandId: OTHER_COMMAND,
    });

    expect(second.status).toBe(409);
    expect(((await second.json()) as KitBody).status).toBe("turn_open");
    // Nothing was written: not the second person's message, and not history.
    // A `busy` accept that had already saved history would have overwritten the
    // running turn's (ADR-0039, amended SHO-563).
    const window = await kit.messages.read({
      conversationId: CONVERSATION,
      bind,
    });
    expect(window.messages).toHaveLength(2);
    expect(
      window.messages.flatMap((message) =>
        message.parts.flatMap((part) =>
          part.kind === "text" ? [part.text] : [],
        ),
      ),
    ).toEqual(["створи", ""]);
    expect(history.saved).toHaveLength(savedBefore);
    expect(history.saved.at(-1)).toEqual([{ role: "user", content: "створи" }]);
  });

  /**
   * A refused send must leave the command spendable. A receipt kept for a send
   * that stored nothing would answer the retry with a window the person's
   * message is not in — a tap that does nothing for the receipt's lifetime.
   */
  it("gives the command back when the conversation was busy", async () => {
    const { app, kit, turns, bind } = harness();
    await post(app, ASSISTANT_KIT_CHAT_PATH, chatBody("створи"));

    const refused = await post(app, ASSISTANT_KIT_CHAT_PATH, {
      ...chatBody("а тепер покажи"),
      commandId: OTHER_COMMAND,
    });
    expect(refused.status).toBe(409);

    // The worker finishes the first turn, and the same command now works.
    await turns.finish(turnRef("chat"), "done");
    const retry = await post(app, ASSISTANT_KIT_CHAT_PATH, {
      ...chatBody("а тепер покажи"),
      commandId: OTHER_COMMAND,
    });

    expect(retry.status).toBe(202);
    const window = await kit.messages.read({
      conversationId: CONVERSATION,
      bind,
    });
    expect(
      window.messages.filter((message) => message.role === "user"),
    ).toHaveLength(2);
  });

  it("frees the conversation once the turn has ended", async () => {
    const { app, turns } = harness();

    await post(app, ASSISTANT_KIT_CHAT_PATH, chatBody("створи"));
    await turns.finish(turnRef("chat"), "interrupted");
    const next = await post(app, ASSISTANT_KIT_CHAT_PATH, {
      ...chatBody("ще раз"),
      commandId: OTHER_COMMAND,
    });

    expect(next.status).toBe(202);
  });

  /**
   * The turn is a Postgres row before the job exists, and the reconciler
   * enqueues a turn that never got one. Failing the request would tell the
   * person nothing happened while their message is stored and their turn is
   * about to run.
   */
  it("still accepts when the queue cannot be reached", async () => {
    const { app, kit, bind } = harness({ brokenQueue: true });

    const response = await post(app, ASSISTANT_KIT_CHAT_PATH, chatBody());

    expect(response.status).toBe(202);
    expect(
      (await kit.messages.read({ conversationId: CONVERSATION, bind }))
        .messages,
    ).toHaveLength(2);
  });

  it("still accepts in a composition with no queue at all", async () => {
    const { app } = harness({ noQueue: true });

    expect((await post(app, ASSISTANT_KIT_CHAT_PATH, chatBody())).status).toBe(
      202,
    );
  });

  /**
   * A write result is a union, not a formality. The accept is one transaction:
   * if the person's message cannot be stored, no turn row and no placeholder
   * are either, and the send fails rather than queueing a turn whose
   * conversation does not hold the question (SHO-570).
   */
  it("fails the send when the accept could not store the person's message", async () => {
    const { app, kit, history, queue, bind } = harness({
      writeRefusal: "conflict",
    });

    const response = await post(app, ASSISTANT_KIT_CHAT_PATH, chatBody());

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: { code: "INTERNAL" } });
    const window = await kit.messages.read({
      conversationId: CONVERSATION,
      bind,
    });
    expect(window.messages).toEqual([]);
    // Nothing was queued and no history was saved.
    expect(queue.added).toEqual([]);
    expect(history.saved).toEqual([]);
  });

  /**
   * A thrown accept stored nothing, so the command goes back. Kept, the retry
   * would be answered `202 accepted` with a window the person's own message is
   * not in — for the receipt's whole lifetime, and a regression against the
   * synchronous route, which wrote the message before the turn ran.
   */
  it("gives the command back when the accept throws, so the retry stores the message", async () => {
    const { app, kit, queue, bind } = harness({ acceptThrows: "conflict" });

    const failed = await post(app, ASSISTANT_KIT_CHAT_PATH, chatBody("створи"));
    expect(failed.status).toBe(500);

    const retry = await post(app, ASSISTANT_KIT_CHAT_PATH, chatBody("створи"));

    expect(retry.status).toBe(202);
    const window = await kit.messages.read({
      conversationId: CONVERSATION,
      bind,
    });
    expect(
      window.messages.flatMap((message) =>
        message.parts.flatMap((part) =>
          part.kind === "text" ? [part.text] : [],
        ),
      ),
    ).toEqual(["створи", ""]);
    expect(queue.added).toHaveLength(1);
  });

  /**
   * The case no predicate can vouch for: an `INTERNAL` raised before COMMIT.
   * This route gives its command back anyway, because its accept is its own
   * receipt — keeping it would strand the person's message behind a `202` for
   * the receipt's whole lifetime, and a pre-commit `INTERNAL` is at least as
   * likely as a post-commit one. `/kit/answer` deliberately does the opposite.
   */
  it("gives the command back even when the failure proves nothing", async () => {
    const { app, kit, queue, bind } = harness({ acceptThrows: "internal" });

    const failed = await post(app, ASSISTANT_KIT_CHAT_PATH, chatBody("створи"));
    expect(failed.status).toBe(500);

    const retry = await post(app, ASSISTANT_KIT_CHAT_PATH, chatBody("створи"));

    expect(retry.status).toBe(202);
    const window = await kit.messages.read({
      conversationId: CONVERSATION,
      bind,
    });
    expect(
      window.messages.flatMap((message) =>
        message.parts.flatMap((part) =>
          part.kind === "text" ? [part.text] : [],
        ),
      ),
    ).toEqual(["створи", ""]);
    expect(queue.added).toHaveLength(1);
  });

  /**
   * The other half of that: the first attempt did commit, so the retry reaches
   * the accept and is `replayed`. Nothing is written twice, and the job that
   * attempt never added goes on the queue now rather than an interval later.
   */
  it("re-enqueues a replayed turn without writing anything twice", async () => {
    const { app, kit, queue, bind } = harness({
      acceptThrows: "internal-after-commit",
    });

    const failed = await post(app, ASSISTANT_KIT_CHAT_PATH, chatBody("створи"));
    expect(failed.status).toBe(500);
    expect(queue.added).toEqual([]);

    const retry = await post(app, ASSISTANT_KIT_CHAT_PATH, chatBody("створи"));

    expect(retry.status).toBe(202);
    expect(queue.added).toHaveLength(1);
    const window = await kit.messages.read({
      conversationId: CONVERSATION,
      bind,
    });
    expect(window.messages).toHaveLength(2);
    expect(
      window.messages.filter((message) => message.role === "user"),
    ).toHaveLength(1);
  });

  it("queues the turn only after the person's message is in history", async () => {
    const { app, queue } = harness({ brokenHistorySave: true });

    const failed = await post(app, ASSISTANT_KIT_CHAT_PATH, chatBody("створи"));

    expect(failed.status).toBe(500);
    // Nothing to run from a history the message never reached.
    expect(queue.added).toEqual([]);
  });

  it("treats a different draft as a different command", async () => {
    const { app, kit, queue, turns, bind } = harness();

    await post(app, ASSISTANT_KIT_CHAT_PATH, chatBody("створи"));
    await turns.finish(turnRef("chat"), "done");
    const second = await post(app, ASSISTANT_KIT_CHAT_PATH, {
      ...chatBody("створи інше"),
      commandId: OTHER_COMMAND,
    });

    expect(second.status).toBe(202);
    expect(queue.added).toHaveLength(2);
    const window = await kit.messages.read({
      conversationId: CONVERSATION,
      bind,
    });
    expect(
      window.messages.filter((message) => message.role === "user"),
    ).toHaveLength(2);
  });

  it("410 for a conversation that belongs to someone else", async () => {
    const { app, kit, bind } = harness();
    await kit.messages.write(
      { conversationId: CONVERSATION, bind },
      {
        kind: "append",
        messageId: "66666666-6666-4666-8666-666666666666",
        role: "user",
        parts: [{ kind: "text", text: "mine", status: "complete" }],
      },
    );

    const response = await post(app, ASSISTANT_KIT_CHAT_PATH, chatBody(), {
      company: OTHER_COMPANY,
    });

    expect(response.status).toBe(410);
  });
});

describe("GET /assistant/kit/messages", () => {
  /**
   * The invariant the whole path exists for. A live accept and a reload are not
   * two views that have to be kept in agreement — they are the same bytes, so
   * there is no derivation left to disagree.
   */
  it("returns exactly what the accept returned", async () => {
    const { app } = harness();
    const live = await post(app, ASSISTANT_KIT_CHAT_PATH, chatBody());
    const liveBody = (await live.json()) as KitBody;

    const response = await get(app, messagesPath());
    expect(response.status).toBe(200);
    const body = (await response.json()) as KitBody;

    expect(body.window).toEqual(liveBody.window);
    expect(JSON.stringify(body.window)).toBe(JSON.stringify(liveBody.window));
  });

  it("carries the open question so a reload can show the card", async () => {
    const { app, kit, bind } = harness();
    const pause = await openPause(kit, bind);

    const response = await get(app, messagesPath());
    const body = (await response.json()) as {
      window: {
        openPause: { interactionId: string; prompt: unknown } | null;
      };
    };

    expect(body.window.openPause?.interactionId).toBe(pause.interactionId);
    expect(JSON.stringify(body)).not.toContain("entity-a");
  });

  it("400 without a usable conversation id", async () => {
    const { app } = harness();

    expect((await get(app, ASSISTANT_KIT_MESSAGES_PATH)).status).toBe(400);
    expect((await get(app, messagesPath("not-a-uuid"))).status).toBe(400);
  });

  /**
   * SHO-555. A year of use is one conversation; an answer carries one window of
   * it, and the rest is a page away by the cursor that answer gave.
   */
  it("pages back from the cursor a read returned, to the first message", async () => {
    const { app, kit, bind } = harness();
    const total = ASSISTANT_CHAT_WINDOW_MESSAGES + 5;
    for (let n = 1; n <= total; n += 1) {
      await kit.messages.write(
        { conversationId: CONVERSATION, bind },
        {
          kind: "append",
          messageId: `66666666-6666-4666-8666-${n.toString(16).padStart(12, "0")}`,
          role: "user",
          parts: [
            { kind: "text", text: `запит ${String(n)}`, status: "complete" },
          ],
        },
      );
    }

    const latest = (await (await get(app, messagesPath())).json()) as KitBody;
    expect(latest.window?.messages).toHaveLength(
      ASSISTANT_CHAT_WINDOW_MESSAGES,
    );
    const cursor = latest.window?.olderCursor ?? null;
    expect(cursor).toEqual(expect.any(String));

    const older = (await (
      await get(app, messagesPath(CONVERSATION, cursor ?? ""))
    ).json()) as KitBody;
    expect(older.window?.olderCursor).toBeNull();

    const texts = [
      ...(older.window?.messages ?? []),
      ...(latest.window?.messages ?? []),
    ].map((message) => message.parts[0]?.text);
    expect(texts).toEqual(
      Array.from({ length: total }, (_, index) => `запит ${String(index + 1)}`),
    );
  });

  it("400 for a cursor it could not have issued", async () => {
    const { app } = harness();

    for (const before of ["", "abc", "0", "-1", "1.5"]) {
      expect(
        (await get(app, messagesPath(CONVERSATION, before))).status,
        before,
      ).toBe(400);
    }
  });

  it("401 without a session", async () => {
    const { app } = harness({ session: null });

    expect((await get(app, messagesPath())).status).toBe(401);
  });

  it("reads as empty for another tenant, exactly like a conversation that does not exist", async () => {
    const { app } = harness();
    await post(app, ASSISTANT_KIT_CHAT_PATH, chatBody());

    const foreign = await get(app, messagesPath(), { company: OTHER_COMPANY });
    const missing = await get(
      app,
      messagesPath("99999999-9999-4999-8999-999999999999"),
    );

    expect(foreign.status).toBe(200);
    const foreignBody = (await foreign.json()) as {
      window: { messages: unknown[] };
    };
    const missingBody = (await missing.json()) as {
      window: { messages: unknown[] };
    };
    expect(foreignBody.window.messages).toEqual([]);
    expect(foreignBody.window.messages).toEqual(missingBody.window.messages);
  });
});

describe("POST /assistant/kit/answer", () => {
  /**
   * An answer keeps its synchronous half: the claim and the resolved action run
   * in the request, and the card the action earned is stored by the accept —
   * before any generation is attempted. Only the explanation runs off the
   * request.
   */
  it("runs the action, stores its card on the placeholder, and accepts the reply", async () => {
    const { kit, app, history, queue, bind } = harness();
    const pause = await openPause(kit, bind);

    const response = await post(
      app,
      ASSISTANT_KIT_ANSWER_PATH,
      answerBody(pause.interactionId, pause.revision),
    );
    expect(response.status).toBe(202);

    const body = (await response.json()) as KitBody;
    expect(body.status).toBe("accepted");
    expect(body.window?.openPause).toBeNull();
    const written = body.window?.messages.at(-1)?.parts ?? [];
    // The card comes first: it is the part already earned. The text after it is
    // the placeholder the worker writes the explanation into.
    expect(written[0]?.kind).toBe("card");
    expect(written[0]?.type).toBe("order-entity");
    expect(written.at(-1)).toMatchObject({ kind: "text", status: "streaming" });

    expect(await kit.peek({ conversationId: CONVERSATION, bind })).toBeNull();
    expect(queue.added).toEqual([
      {
        version: 1,
        kind: "answer",
        conversationId: CONVERSATION,
        commandId: COMMAND,
      },
    ]);
    // The worker runs an answer turn from history, like a chat turn: the
    // resumed continuation, with the paused call's output replaced.
    expect(history.saved).toHaveLength(1);
    expect(history.saved[0]?.at(-1)).toMatchObject({ role: "tool" });
  });

  it("resolves the option on the server; the client only sent an id", async () => {
    let seen: unknown;
    const capture: ResolveAnswer = (args) => {
      seen = args.value;
      return OK_RESOLVE(args);
    };
    const { kit, app, bind } = harness({ resolveAnswer: capture });
    const pause = await openPause(kit, bind);

    await post(
      app,
      ASSISTANT_KIT_ANSWER_PATH,
      answerBody(pause.interactionId, pause.revision),
    );

    expect(seen).toEqual({
      entityId: "entity-b",
      toolName: "orders_create",
      input: { customerQuery: "two matches", items: [] },
      target: { kind: "customer", query: "two matches" },
    });
  });

  it("400 on an answer the kind's schema rejects, and the card survives", async () => {
    const { kit, app, bind } = harness();
    const pause = await openPause(kit, bind);

    const response = await post(app, ASSISTANT_KIT_ANSWER_PATH, {
      commandId: COMMAND,
      conversationId: CONVERSATION,
      interactionId: pause.interactionId,
      revision: pause.revision,
      answer: { approved: true },
    });

    expect(response.status).toBe(400);
    expect(
      (await kit.peek({ conversationId: CONVERSATION, bind }))?.status,
    ).toBe("open");
  });

  it("409 for an option this question never offered, without spending the claim", async () => {
    const { kit, app, queue, bind } = harness();
    const pause = await openPause(kit, bind);

    const response = await post(
      app,
      ASSISTANT_KIT_ANSWER_PATH,
      answerBody(pause.interactionId, pause.revision, "opt-nope"),
    );

    expect(response.status).toBe(409);
    expect(((await response.json()) as { status: string }).status).toBe(
      "unresolvable",
    );
    // The refusal stored nothing and gave the command back, so answering again
    // under the same command really runs and really queues a turn — rather
    // than being replayed as work that never happened.
    const retry = await post(
      app,
      ASSISTANT_KIT_ANSWER_PATH,
      answerBody(pause.interactionId, pause.revision),
    );
    expect(retry.status).toBe(202);
    expect(((await retry.json()) as KitBody).status).toBe("accepted");
    expect(queue.added).toHaveLength(1);
  });

  it("410 for a session in another tenant, and the owner's card stays open", async () => {
    const { kit, app, bind } = harness();
    const pause = await openPause(kit, bind);

    const response = await post(
      app,
      ASSISTANT_KIT_ANSWER_PATH,
      answerBody(pause.interactionId, pause.revision),
      { company: OTHER_COMPANY },
    );

    expect(response.status).toBe(410);
    const owner = await kit.peek({ conversationId: CONVERSATION, bind });
    expect(owner?.status).toBe("open");
  });

  it("409 action_failed leaves the card answerable and writes nothing", async () => {
    const { kit, app, queue, bind } = harness({
      resolveAnswer: FAILING_RESOLVE,
    });
    const pause = await openPause(kit, bind);

    const response = await post(
      app,
      ASSISTANT_KIT_ANSWER_PATH,
      answerBody(pause.interactionId, pause.revision),
    );

    expect(response.status).toBe(409);
    const body = (await response.json()) as { status: string; code: string };
    expect(body.status).toBe("action_failed");
    expect(body.code).toBe("CONFLICT");
    expect(
      (await kit.peek({ conversationId: CONVERSATION, bind }))?.status,
    ).toBe("open");
    const window = await kit.messages.read({
      conversationId: CONVERSATION,
      bind,
    });
    expect(window.messages).toEqual([]);
    // No turn was accepted, so nothing is waiting to run.
    expect(queue.added).toEqual([]);
  });

  /**
   * A second ambiguity is a new question, not a turn: nothing runs off the
   * request, so the answer is still an immediate `200`.
   */
  it("asks the second question synchronously and accepts no turn", async () => {
    const { kit, app, queue, bind } = harness({
      resolveAnswer: SECOND_QUESTION,
    });
    const pause = await openPause(kit, bind);

    const response = await post(
      app,
      ASSISTANT_KIT_ANSWER_PATH,
      answerBody(pause.interactionId, pause.revision),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as KitBody;
    expect(body.status).toBe("ok");
    expect(
      (body.window?.openPause?.prompt as { subject?: string } | undefined)
        ?.subject,
    ).toBe("which product");
    // The transcript holds the second question too.
    const kinds = (body.window?.messages ?? []).flatMap((message) =>
      message.parts.map((part) => part.kind),
    );
    expect(kinds).toContain("interaction");
    expect(queue.added).toEqual([]);
  });

  /**
   * The card is stored before anything can fail, which is the whole reason the
   * action's half stays in the request (SHO-546). The reply does not exist yet
   * and the card does not wait for it.
   */
  it("stores the committed write's card before any reply exists", async () => {
    const { kit, app, bind } = harness();
    const pause = await openPause(kit, bind);

    await post(
      app,
      ASSISTANT_KIT_ANSWER_PATH,
      answerBody(pause.interactionId, pause.revision),
    );

    const window = await kit.messages.read({
      conversationId: CONVERSATION,
      bind,
    });
    const parts = window.messages.flatMap((message) => message.parts);
    expect(parts.filter((part) => part.kind === "card")).toHaveLength(1);
    // Nothing claims the turn finished: the text is still being written.
    expect(parts.filter((part) => part.kind === "text").at(-1)).toMatchObject({
      status: "streaming",
    });
  });

  it("runs the action for a client that has already gone", async () => {
    let called = 0;
    const counting: ResolveAnswer = (args) => {
      called += 1;
      return OK_RESOLVE(args);
    };
    const { kit, app, bind } = harness({ resolveAnswer: counting });
    const pause = await openPause(kit, bind);

    const response = await post(
      app,
      ASSISTANT_KIT_ANSWER_PATH,
      answerBody(pause.interactionId, pause.revision),
      { signal: AbortSignal.abort() },
    );

    expect(response.status).toBe(202);
    expect(called).toBe(1);
    expect(await kit.peek({ conversationId: CONVERSATION, bind })).toBeNull();
  });

  /**
   * A send can take the conversation between the claim and the accept. Nothing
   * was written then — not even the card the action earned — so the claim and
   * the command both go back, and the person can answer again. The retry runs
   * the same action under the same idempotency key, so the write is replayed
   * rather than repeated (SHO-547) and its card is stored by the accept that
   * succeeds.
   */
  it("a turn_open accept leaves the pause answerable, and the retry stores the card", async () => {
    let open = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    let resolved = 0;
    const counting: ResolveAnswer = (args) => {
      resolved += 1;
      return OK_RESOLVE(args);
    };
    const { kit, app, turns, bind } = harness({
      toolsGate: gate,
      resolveAnswer: counting,
    });
    const pause = await openPause(kit, bind);

    // The answer reaches the gate holding a claim but no turn.
    const answering = post(
      app,
      ASSISTANT_KIT_ANSWER_PATH,
      answerBody(pause.interactionId, pause.revision),
    );
    for (let tick = 0; tick < 50; tick += 1) {
      if ((await kit.peek({ conversationId: CONVERSATION, bind })) === null) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    // A send takes the conversation while the answer is still resolving.
    await post(app, ASSISTANT_KIT_CHAT_PATH, {
      ...chatBody("а тепер покажи"),
      commandId: OTHER_COMMAND,
    });
    open();

    const refused = await answering;
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as KitBody).status).toBe("turn_open");
    // The question is answerable again.
    expect(
      (await kit.peek({ conversationId: CONVERSATION, bind }))?.status,
    ).toBe("open");

    // The send's turn ends; the same answer, under the same command, now takes.
    await turns.finish(turnRef("chat", OTHER_COMMAND), "done");
    const retry = await post(
      app,
      ASSISTANT_KIT_ANSWER_PATH,
      answerBody(pause.interactionId, pause.revision),
    );

    expect(retry.status).toBe(202);
    expect(resolved).toBe(2);
    const parts = (
      await kit.messages.read({ conversationId: CONVERSATION, bind })
    ).messages.flatMap((message) => message.parts);
    expect(
      parts.filter((part) => part.kind === "card").map((part) => part.cardId),
    ).toEqual(["card-entity"]);
  });

  /**
   * Restored from the synchronous suite ("answers a retried answer with the
   * result, not a dead card"). This is the behaviour the Redis receipt in front
   * of the claim exists for: the claim is exactly-once, so without it the retry
   * would be told `gone` and the card could never be answered (SHO-547).
   */
  it("answers a retried answer with the conversation, running the action once", async () => {
    let resolved = 0;
    const counting: ResolveAnswer = (args) => {
      resolved += 1;
      return OK_RESOLVE(args);
    };
    const { kit, app, queue, bind } = harness({ resolveAnswer: counting });
    const pause = await openPause(kit, bind);
    const body = answerBody(pause.interactionId, pause.revision);

    const first = await post(app, ASSISTANT_KIT_ANSWER_PATH, body);
    const retry = await post(app, ASSISTANT_KIT_ANSWER_PATH, body);

    expect(first.status).toBe(202);
    // A turn really was accepted, so the retry replays durable work: answered
    // `ok` with the conversation, never a second `accepted`, which would claim
    // a turn had just been queued.
    expect(retry.status).toBe(200);
    expect(((await retry.json()) as KitBody).status).toBe("ok");
    expect(resolved).toBe(1);
    expect(queue.added).toHaveLength(1);
    const parts = (
      await kit.messages.read({ conversationId: CONVERSATION, bind })
    ).messages.flatMap((message) => message.parts);
    expect(
      parts.filter((part) => part.kind === "card").map((part) => part.cardId),
    ).toEqual(["card-entity"]);
  });

  /**
   * The resumed history is saved before the job exists. A worker that started
   * in between would load a transcript still ending in the unanswered paused
   * call and answer without knowing the action had been performed — re-issuing
   * its tool call, and charged for it. The same order `/kit/chat` keeps.
   */
  it("queues the turn only after the resumed history is saved", async () => {
    const { kit, app, queue, bind } = harness({ brokenHistorySave: true });
    const pause = await openPause(kit, bind);

    const response = await post(
      app,
      ASSISTANT_KIT_ANSWER_PATH,
      answerBody(pause.interactionId, pause.revision),
    );

    expect(response.status).toBe(500);
    expect(queue.added).toEqual([]);
    // The action committed all the same, so its card is stored: the accept is
    // what carries it, and it ran before this failure.
    const parts = (
      await kit.messages.read({ conversationId: CONVERSATION, bind })
    ).messages.flatMap((message) => message.parts);
    expect(parts.filter((part) => part.kind === "card")).toHaveLength(1);
  });

  it("does not run a duplicate answer that arrives while the first is resolving", async () => {
    let open = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    let resolved = 0;
    const counting: ResolveAnswer = (args) => {
      resolved += 1;
      return OK_RESOLVE(args);
    };
    const { kit, app, bind } = harness({
      toolsGate: gate,
      resolveAnswer: counting,
    });
    const pause = await openPause(kit, bind);
    const body = answerBody(pause.interactionId, pause.revision);

    const first = post(app, ASSISTANT_KIT_ANSWER_PATH, body);
    // The receipt is taken before the claim, so this lands while the first is
    // still stopped at the gate and does nothing.
    const duplicate = await post(app, ASSISTANT_KIT_ANSWER_PATH, body);
    expect(duplicate.status).toBe(200);

    open();
    expect((await first).status).toBe(202);
    expect(resolved).toBe(1);
  });

  /**
   * The throw path of the same defect the `turn_open` case closes: the claim is
   * spent and the action has committed, so a receipt kept here would leave the
   * earned card stored nowhere and the pause unanswerable for ever.
   */
  it("gives the claim and the command back when the accept throws, and the retry stores the card", async () => {
    let resolved = 0;
    const counting: ResolveAnswer = (args) => {
      resolved += 1;
      return OK_RESOLVE(args);
    };
    const { kit, app, queue, bind } = harness({
      acceptThrows: "conflict",
      resolveAnswer: counting,
    });
    const pause = await openPause(kit, bind);
    const body = answerBody(pause.interactionId, pause.revision);

    const failed = await post(app, ASSISTANT_KIT_ANSWER_PATH, body);
    expect(failed.status).toBe(500);
    // Answerable again, rather than a card that can never be answered.
    expect(
      (await kit.peek({ conversationId: CONVERSATION, bind }))?.status,
    ).toBe("open");

    const retry = await post(app, ASSISTANT_KIT_ANSWER_PATH, body);

    expect(retry.status).toBe(202);
    // The action ran again under the same idempotency key — a replay, not a
    // repeat — and its card is stored by the accept that succeeded.
    expect(resolved).toBe(2);
    expect(queue.added).toHaveLength(1);
    const parts = (
      await kit.messages.read({ conversationId: CONVERSATION, bind })
    ).messages.flatMap((message) => message.parts);
    expect(
      parts.filter((part) => part.kind === "card").map((part) => part.cardId),
    ).toEqual(["card-entity"]);
  });
});

describe("POST /assistant/kit/abandon", () => {
  it("frees the conversation so the next job is not blocked", async () => {
    const { kit, app, bind } = harness();
    const pause = await openPause(kit, bind);

    const dropped = await post(app, ASSISTANT_KIT_ABANDON_PATH, {
      conversationId: CONVERSATION,
      interactionId: pause.interactionId,
    });

    expect(dropped.status).toBe(200);
    expect(await kit.peek({ conversationId: CONVERSATION, bind })).toBeNull();
    // The point of the route: a new turn is accepted again.
    expect((await post(app, ASSISTANT_KIT_CHAT_PATH, chatBody())).status).toBe(
      202,
    );
  });

  /**
   * The answer carries the window, like every other one. Without it the card
   * kept rendering on the client that had just cancelled it — and the type now
   * makes returning nothing impossible rather than merely discouraged.
   */
  it("answers with the conversation, so the card can stop rendering", async () => {
    const { kit, app, bind } = harness();
    const pause = await openPause(kit, bind);

    const response = await post(app, ASSISTANT_KIT_ABANDON_PATH, {
      conversationId: CONVERSATION,
      interactionId: pause.interactionId,
    });

    const body = (await response.json()) as KitBody;
    expect(body.status).toBe("abandoned");
    expect(body.window).toBeDefined();
    expect(body.window?.openPause).toBeNull();
  });

  it("keeps the record that the question was asked", async () => {
    const { kit, app, bind } = harness({ tools: PAUSING_TOOLS });
    const pause = await openPause(kit, bind);
    // The transcript carries the question, as a turn that asked it would leave.
    await kit.messages.write(
      { conversationId: CONVERSATION, bind },
      {
        kind: "append",
        messageId: "77777777-7777-4777-8777-777777777777",
        role: "assistant",
        parts: [
          {
            kind: "interaction",
            interactionId: pause.interactionId,
            revision: pause.revision,
            pause,
          },
        ],
      },
    );

    await post(app, ASSISTANT_KIT_ABANDON_PATH, {
      conversationId: CONVERSATION,
      interactionId: pause.interactionId,
    });

    const window = await kit.messages.read({
      conversationId: CONVERSATION,
      bind,
    });
    const parts = window.messages.flatMap((message) => message.parts);
    expect(parts.filter((part) => part.kind === "interaction")).toHaveLength(1);
    expect(window.openPause).toBeNull();
  });

  it("answers the same way twice, so a second tap is not an error", async () => {
    const { kit, app, bind } = harness();
    const pause = await openPause(kit, bind);
    const body = {
      conversationId: CONVERSATION,
      interactionId: pause.interactionId,
    };

    const first = await post(app, ASSISTANT_KIT_ABANDON_PATH, body);
    const second = await post(app, ASSISTANT_KIT_ABANDON_PATH, body);

    expect([first.status, second.status]).toEqual([200, 200]);
  });

  it("cannot drop another tenant's question", async () => {
    const { kit, app, bind } = harness();
    const pause = await openPause(kit, bind);

    const response = await post(
      app,
      ASSISTANT_KIT_ABANDON_PATH,
      { conversationId: CONVERSATION, interactionId: pause.interactionId },
      { company: OTHER_COMPANY },
    );

    expect(response.status).toBe(200);
    // Same answer either way, and the owner's question is untouched.
    expect(
      await kit.peek({ conversationId: CONVERSATION, bind }),
    ).not.toBeNull();
  });

  it("400 without a usable body", async () => {
    const { app } = harness();

    const response = await post(app, ASSISTANT_KIT_ABANDON_PATH, {
      conversationId: CONVERSATION,
    });

    expect(response.status).toBe(400);
  });
});

describe("the full round trip through HTTP", () => {
  it("a question is answered, the card is stored, and a reload shows both turns", async () => {
    const { app, kit, turns, bind } = harness();
    const pause = await openPause(kit, bind);

    const answered = await post(
      app,
      ASSISTANT_KIT_ANSWER_PATH,
      answerBody(pause.interactionId, pause.revision),
    );
    expect(answered.status).toBe(202);

    // The worker ends that turn; the next send is accepted.
    await turns.finish(turnRef("answer"), "done");
    const next = await post(app, ASSISTANT_KIT_CHAT_PATH, {
      ...chatBody("дякую"),
      commandId: OTHER_COMMAND,
    });
    expect(next.status).toBe(202);

    const reload = await get(app, messagesPath());
    const body = (await reload.json()) as KitBody;

    expect(body.window?.openPause).toBeNull();
    const kinds = (body.window?.messages ?? []).flatMap((message) =>
      message.parts.map((part) => part.kind),
    );
    expect(kinds.filter((kind) => kind === "card")).toHaveLength(1);
    expect(await kit.peek({ conversationId: CONVERSATION, bind })).toBeNull();
  });
});
