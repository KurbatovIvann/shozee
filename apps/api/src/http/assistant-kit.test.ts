/**
 * The four `assistant-kit` routes at the HTTP level.
 *
 * No database and no live model: auth, both stores, the history port and the
 * provider are injected, so this suite runs in a couple of seconds and can be
 * run on every save.
 */
import {
  createAssistantKit,
  type AssistantKit,
  type LanguageModel,
  type ModelMessage,
  type ToolOutcome,
  type ToolSet,
} from "@showzy/assistant-kit";
import {
  stubBrokenModel,
  stubModel,
  stubTextStep,
  stubTextModel,
  stubToolCallStep,
  testDeps,
} from "@showzy/assistant-kit/testing";
import {
  ASSISTANT_CHAT_WINDOW_MESSAGES,
  assistantInteractions,
  memoryAssistantKitCommands,
  type AssistantHistoryPort,
  type AssistantInteractionTypes,
  type ChoiceResolution,
  type ResolveAnswer,
} from "@showzy/assistant-runtime";
import { COMPANY_SELECTOR_HEADER } from "@showzy/contract";
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

/** The guard logs refusals; most tests here do not assert on them. */
function silentLogger(): Logger {
  return pino({ level: "silent" });
}

/** For the one thing whose only output *is* a log line. */
function capturingLogger(lines: string[]): Logger {
  return pino(
    { level: "warn" },
    {
      write: (line: string) => {
        lines.push(line);
      },
    },
  );
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

/**
 * A tool that pauses on the consumer's own `choice` kind.
 *
 * Written as a plain object rather than through the SDK's `tool()` helper, so
 * this file — and `apps/api` — needs no direct dependency on the model SDK. The
 * types the kit re-exports are enough.
 */
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
  readonly bind: string;
  /** The pause store behind the kit, for reaching in at a turn's lease. */
  readonly deps: ReturnType<typeof testDeps<AssistantInteractionTypes>>;
}

function harness(options?: {
  readonly session?: { user: { id: string } } | null;
  readonly resolveAnswer?: ResolveAnswer;
  readonly broken?: boolean;
  readonly logger?: Logger;
  readonly pausing?: boolean;
  readonly tools?: ToolSet;
  readonly model?: LanguageModel;
  /** Held open to keep a turn in flight while a second request arrives. */
  readonly toolsGate?: Promise<unknown>;
}): Harness {
  // The window the routes really run with, so a page here is a page on a phone.
  const deps = testDeps(assistantInteractions, {
    windowMessages: ASSISTANT_CHAT_WINDOW_MESSAGES,
  });
  const kit = createAssistantKit(deps);
  const history = memoryHistory();
  const model =
    options?.model ??
    (options?.broken === true
      ? stubBrokenModel()
      : options?.pausing === true
        ? stubModel([
            stubToolCallStep("toolu_create", "orders_create", {
              label: "two matches",
            }),
          ])
        : stubTextModel("Готово."));
  const app = createAssistantKitApp({
    logger: options?.logger ?? silentLogger(),
    commands: memoryAssistantKitCommands(),
    auth: {
      api: {
        getSession: () =>
          Promise.resolve(
            options?.session === undefined
              ? { user: { id: USER } }
              : options.session,
          ),
      },
    },
    // In-memory stores for every caller: this suite is about the handlers, and
    // the durable adapters have their own test against a real database.
    forCaller: () => ({ kit, history }),
    staffCompany: () => Promise.resolve(COMPANY),
    model,
    tools: async () => {
      await options?.toolsGate;
      return options?.tools ?? {};
    },
    resolveAnswer: options?.resolveAnswer ?? OK_RESOLVE,
    prompt: () => ({ system: "you are a test" }),
  });
  return { kit, app, history, deps, bind: `${USER}:${COMPANY}` };
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

function chatBody(text = "покажи замовлення") {
  return { commandId: COMMAND, conversationId: CONVERSATION, text };
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

describe("POST /assistant/kit/chat", () => {
  it("runs a turn, stores the question and the answer, and saves history", async () => {
    const { app, kit, history, bind } = harness();

    const response = await post(app, ASSISTANT_KIT_CHAT_PATH, chatBody());
    expect(response.status).toBe(200);
    const body = (await response.json()) as KitBody;
    expect(body.status).toBe("ok");
    expect(body.window?.openPause).toBeNull();

    const window = await kit.messages.read({
      conversationId: CONVERSATION,
      bind,
    });
    expect(window.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
    // The response is what is stored, not a second view of it.
    expect(body.window).toEqual(window);
    expect(history.saved).toHaveLength(1);
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

  it("pauses when a tool asks a question, and stores it", async () => {
    const { app, kit, bind } = harness({
      pausing: true,
      tools: PAUSING_TOOLS,
    });

    const response = await post(
      app,
      ASSISTANT_KIT_CHAT_PATH,
      chatBody("створи"),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as KitBody;
    const open = body.window?.openPause;

    expect(open?.kind).toBe("choice");
    // The prompt comes from the tool's input, which the model chose — not from
    // the text the person typed.
    expect((open?.prompt as { subject: string } | undefined)?.subject).toBe(
      "two matches",
    );
    // The private side never left the server.
    expect(JSON.stringify(body)).not.toContain("entity-a");
    expect(
      (await kit.peek({ conversationId: CONVERSATION, bind }))?.status,
    ).toBe("open");
  });

  it("keeps the question in the messages when generation fails", async () => {
    const { app, kit, bind } = harness({ broken: true });

    const response = await post(app, ASSISTANT_KIT_CHAT_PATH, chatBody());
    expect(response.status).toBe(200);

    const window = await kit.messages.read({
      conversationId: CONVERSATION,
      bind,
    });
    const texts = window.messages.flatMap((message) => message.parts);
    expect(texts[0]).toMatchObject({ kind: "text", status: "complete" });
    expect(texts.at(-1)).toMatchObject({ status: "error" });
  });

  /**
   * A turn that broke is invisible everywhere else. The person's request may
   * have been aborted, so no response reaches them; and a provider error after
   * the first step is swallowed by the SDK rather than thrown, so the server
   * sees an ordinary result. The log line is the only trace, which makes it the
   * thing to test.
   */
  it("names a turn that did not finish in the log", async () => {
    const lines: string[] = [];
    const { app } = harness({ broken: true, logger: capturingLogger(lines) });

    await post(app, ASSISTANT_KIT_CHAT_PATH, chatBody());

    const line = lines.find((entry) =>
      entry.includes("assistant turn did not finish"),
    );
    expect(line, lines.join(" | ")).toBeDefined();
    expect(JSON.parse(line ?? "{}")).toMatchObject({
      cards_written: 0,
      history_kept: false,
    });
  });

  it("says nothing about a turn that finished", async () => {
    const lines: string[] = [];
    const { app } = harness({ logger: capturingLogger(lines) });

    await post(app, ASSISTANT_KIT_CHAT_PATH, chatBody());

    expect(
      lines.filter((entry) => entry.includes("assistant turn did not finish")),
    ).toEqual([]);
  });

  it("does nothing for a client that has already gone", async () => {
    const { app, kit, bind } = harness();

    const response = await post(app, ASSISTANT_KIT_CHAT_PATH, chatBody(), {
      signal: AbortSignal.abort(),
    });

    expect(response.status).toBe(499);
    const window = await kit.messages.read({
      conversationId: CONVERSATION,
      bind,
    });
    expect(window.messages).toEqual([]);
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
   * The invariant the whole path exists for. A live turn and a reload are not
   * two views that have to be kept in agreement — they are the same bytes, so
   * there is no derivation left to disagree.
   */
  it("returns exactly what the live turn returned", async () => {
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
  it("writes the result card, then the explanation, and closes the question", async () => {
    const { kit, app, bind } = harness();
    const pause = await openPause(kit, bind);

    const response = await post(
      app,
      ASSISTANT_KIT_ANSWER_PATH,
      answerBody(pause.interactionId, pause.revision),
    );
    expect(response.status).toBe(200);

    const body = (await response.json()) as KitBody;
    expect(body.status).toBe("ok");
    expect(body.window?.openPause).toBeNull();
    const written = body.window?.messages.at(-1)?.parts ?? [];
    // The card comes first: it is the part earned before generation.
    expect(written[0]?.kind).toBe("card");
    expect(written[0]?.type).toBe("order-entity");
    expect(written.at(-1)?.text).toContain("Готово");

    expect(await kit.peek({ conversationId: CONVERSATION, bind })).toBeNull();
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
    const { kit, app, bind } = harness();
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
    const retry = await post(
      app,
      ASSISTANT_KIT_ANSWER_PATH,
      answerBody(pause.interactionId, pause.revision),
    );
    expect(retry.status).toBe(200);
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
    const { kit, app, bind } = harness({ resolveAnswer: FAILING_RESOLVE });
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
  });

  it("keeps a committed write when the explanation fails", async () => {
    const { kit, app, bind } = harness({ broken: true });
    const pause = await openPause(kit, bind);

    const response = await post(
      app,
      ASSISTANT_KIT_ANSWER_PATH,
      answerBody(pause.interactionId, pause.revision),
    );
    expect(response.status).toBe(200);

    const window = await kit.messages.read({
      conversationId: CONVERSATION,
      bind,
    });
    const parts = window.messages.flatMap((message) => message.parts);
    expect(parts.filter((part) => part.kind === "card")).toHaveLength(1);
    // No invented success sentence — the failure is stated as a failure.
    expect(parts.filter((part) => part.kind === "text").at(-1)?.status).toBe(
      "error",
    );
  });

  it("performs no write for a client that has already gone", async () => {
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

    expect(response.status).toBe(499);
    expect(called).toBe(0);
    expect(
      (await kit.peek({ conversationId: CONVERSATION, bind }))?.status,
    ).toBe("open");
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
      200,
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
    void bind;
  });

  it("keeps the record that the question was asked", async () => {
    const { kit, app, bind } = harness({ pausing: true, tools: PAUSING_TOOLS });
    const paused = await post(app, ASSISTANT_KIT_CHAT_PATH, chatBody());
    const asked = (await paused.json()) as KitBody;
    const interactionId = asked.window?.openPause?.interactionId ?? "";

    await post(app, ASSISTANT_KIT_ABANDON_PATH, {
      conversationId: CONVERSATION,
      interactionId,
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
  it("chat pauses, choice resolves it, and a reload shows both turns", async () => {
    const { app, kit, bind } = harness({
      pausing: true,
      tools: PAUSING_TOOLS,
    });

    const first = await post(app, ASSISTANT_KIT_CHAT_PATH, chatBody("створи"));
    const firstBody = (await first.json()) as KitBody;
    const open = firstBody.window?.openPause;
    if (open === null || open === undefined)
      throw new Error("expected a pause");

    const second = await post(
      app,
      ASSISTANT_KIT_ANSWER_PATH,
      answerBody(open.interactionId, open.revision),
    );
    expect(second.status).toBe(200);

    const reload = await get(app, messagesPath());
    const body = (await reload.json()) as KitBody;

    expect(body.window?.openPause).toBeNull();
    const kinds = (body.window?.messages ?? []).flatMap((message) =>
      message.parts.map((part) => part.kind),
    );
    // The question, the interaction that was asked, and the record that came out.
    expect(kinds).toContain("interaction");
    expect(kinds.filter((kind) => kind === "card")).toHaveLength(1);
    expect(await kit.peek({ conversationId: CONVERSATION, bind })).toBeNull();
  });
});

/**
 * SHO-547. A reply can be lost after the domain write committed — a dropped
 * connection, a backgrounded app, a timeout. The person then retries, because
 * the draft was put back in the field and nothing on screen says the order
 * exists.
 *
 * Both halves of the retry were unsafe in opposite ways. Sending again minted a
 * fresh `commandId`, so the idempotency key changed and the write ran twice.
 * Answering again hit a claim that is exactly-once by design and got `gone`,
 * which carried no window: the action *had* happened, and the card the person
 * was looking at could never be answered.
 *
 * One receipt fixes both, and it stores no response body — every route already
 * answers with the conversation as it stands, so a replay is "here is where the
 * conversation actually is", which is truer than a recording of what the first
 * attempt said.
 */
describe("a retry of a command whose reply was lost", () => {
  const writingTools = (count: { value: number }): ToolSet => ({
    orders_create: {
      description: "create one",
      inputSchema: z.object({ label: z.string() }),
      execute: (): ToolOutcome => {
        count.value += 1;
        return {
          kind: "ok",
          result: { id: "order-1" },
          card: {
            cardId: "order-entity:order-1",
            type: "order-entity",
            payload: { kind: "order-entity", orderId: "order-1" },
          },
        };
      },
    },
  });

  function cardsIn(body: KitBody): string[] {
    return (body.window?.messages ?? [])
      .flatMap((message) => message.parts)
      .filter((part) => part.kind === "card")
      .map((part) => part.cardId ?? "");
  }

  it("writes once and answers the retry with the conversation", async () => {
    const count = { value: 0 };
    const { app, history } = harness({
      tools: writingTools(count),
      model: stubModel([
        stubToolCallStep("toolu_create", "orders_create", { label: "торт" }),
        stubTextStep("Готово."),
      ]),
    });

    const first = await post(app, ASSISTANT_KIT_CHAT_PATH, chatBody("створи"));
    const retry = await post(app, ASSISTANT_KIT_CHAT_PATH, chatBody("створи"));

    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(count.value).toBe(1);
    // No second turn: the model was not called and nothing was stored again.
    expect(history.saved).toHaveLength(1);

    const firstBody = (await first.json()) as KitBody;
    const retryBody = (await retry.json()) as KitBody;
    expect(retryBody.window).toEqual(firstBody.window);
    expect(cardsIn(retryBody)).toEqual(["order-entity:order-1"]);
  });

  /**
   * Two guards, and this is the outer one. The turn lease refuses a second
   * request before the receipt is ever consulted, which is why the answer here
   * is `turn_open` rather than a replay — the receipt's own behaviour under
   * simultaneous takes is proven against Redis in the store suite.
   */
  it("does not run a retry that arrives while the first is still in flight", async () => {
    let open = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const count = { value: 0 };
    const { app } = harness({
      tools: writingTools(count),
      toolsGate: gate,
      model: stubModel([
        stubToolCallStep("toolu_create", "orders_create", { label: "торт" }),
        stubTextStep("Готово."),
      ]),
    });

    const first = post(app, ASSISTANT_KIT_CHAT_PATH, chatBody("створи"));
    // The receipt is taken before the tools are built, so this lands while the
    // first turn is stopped at the gate.
    const retry = await post(app, ASSISTANT_KIT_CHAT_PATH, chatBody("створи"));
    expect(retry.status).toBe(409);
    expect(((await retry.json()) as KitBody).status).toBe("turn_open");

    open();
    expect((await first).status).toBe(200);
    expect(count.value).toBe(1);
  });

  it("answers a retried answer with the result, not a dead card", async () => {
    let resolved = 0;
    const counting: ResolveAnswer = (args) => {
      resolved += 1;
      return OK_RESOLVE(args);
    };
    const { app, kit, bind } = harness({ resolveAnswer: counting });
    const pause = await openPause(kit, bind);
    const body = answerBody(pause.interactionId, pause.revision);

    const first = await post(app, ASSISTANT_KIT_ANSWER_PATH, body);
    const retry = await post(app, ASSISTANT_KIT_ANSWER_PATH, body);

    expect(first.status).toBe(200);
    // The claim is exactly-once, so without the receipt this is a 410 with no
    // window and a card that can never be answered again.
    expect(retry.status).toBe(200);
    expect(resolved).toBe(1);
    expect(cardsIn((await retry.json()) as KitBody)).toEqual(["card-entity"]);
  });

  it("treats a different draft as a different command", async () => {
    const count = { value: 0 };
    const { app } = harness({
      tools: writingTools(count),
      model: stubModel([
        stubToolCallStep("toolu_create", "orders_create", { label: "торт" }),
        stubTextStep("Готово."),
        stubToolCallStep("toolu_create", "orders_create", { label: "інше" }),
        stubTextStep("Готово."),
      ]),
    });

    await post(app, ASSISTANT_KIT_CHAT_PATH, chatBody("створи"));
    const second = await post(app, ASSISTANT_KIT_CHAT_PATH, {
      ...chatBody("створи інше"),
      commandId: OTHER_COMMAND,
    });

    expect(second.status).toBe(200);
    expect(count.value).toBe(2);
  });
});

/**
 * SHO-548. Two turns on one conversation interleave their messages, and the
 * second turn's model answers a conversation that no longer exists as it read
 * it. Two devices, two tabs, a laptop left open — and when this was a document
 * replaced whole, the later write silently discarded the earlier one.
 *
 * A lease existed before, as `conversationLock` in `app.ts`, and went out in
 * phase 2 with the routes that used it. Same class as the history window: a
 * guarantee that travelled out with code being removed for other reasons.
 */
describe("two turns on one conversation", () => {
  const slowTools = (count: { value: number }): ToolSet => ({
    orders_create: {
      description: "create one",
      inputSchema: z.object({ label: z.string() }),
      execute: (): ToolOutcome => {
        count.value += 1;
        return {
          kind: "ok",
          result: { id: "order-1" },
          card: {
            cardId: "order-entity:order-1",
            type: "order-entity",
            payload: { kind: "order-entity", orderId: "order-1" },
          },
        };
      },
    },
  });

  const writingModel = () =>
    stubModel([
      stubToolCallStep("toolu_create", "orders_create", { label: "торт" }),
      stubTextStep("Готово."),
    ]);

  it("refuses the second and loses nothing from the first", async () => {
    let open = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const count = { value: 0 };
    const { app, kit, bind } = harness({
      tools: slowTools(count),
      toolsGate: gate,
      model: writingModel(),
    });

    const first = post(app, ASSISTANT_KIT_CHAT_PATH, chatBody("створи"));
    const second = await post(app, ASSISTANT_KIT_CHAT_PATH, {
      ...chatBody("а тепер покажи"),
      commandId: OTHER_COMMAND,
    });

    expect(second.status).toBe(409);
    expect(((await second.json()) as KitBody).status).toBe("turn_open");

    open();
    expect((await first).status).toBe(200);
    expect(count.value).toBe(1);

    // The first turn's whole message is there: what was asked, what was done,
    // and the reply. Under last-write-wins the second request's own write of
    // the person's words would have taken the place of all of it.
    const parts = (
      await kit.messages.read({ conversationId: CONVERSATION, bind })
    ).messages.flatMap((message) => message.parts);
    expect(parts.filter((part) => part.kind === "card")).toHaveLength(1);
    expect(
      parts.filter((part) => part.kind === "text").map((part) => part.text),
    ).toEqual(["створи", "Готово."]);
  });

  it("frees the conversation for the next turn", async () => {
    const count = { value: 0 };
    const { app } = harness({
      tools: slowTools(count),
      model: stubModel([
        stubToolCallStep("toolu_create", "orders_create", { label: "торт" }),
        stubTextStep("Готово."),
        stubTextStep("І ще."),
      ]),
    });

    await post(app, ASSISTANT_KIT_CHAT_PATH, chatBody("створи"));
    const next = await post(app, ASSISTANT_KIT_CHAT_PATH, {
      ...chatBody("а тепер покажи"),
      commandId: OTHER_COMMAND,
    });

    expect(next.status).toBe(200);
  });

  /**
   * The `finally`, which is the part most likely to rot. A turn that threw and
   * kept the lease would lock the conversation for the lease's whole length,
   * and the person would see "busy" with nothing running.
   */
  it("frees the conversation after a turn that failed", async () => {
    const { app } = harness({ broken: true });

    await post(app, ASSISTANT_KIT_CHAT_PATH, chatBody("створи"));
    const next = await post(app, ASSISTANT_KIT_CHAT_PATH, {
      ...chatBody("ще раз"),
      commandId: OTHER_COMMAND,
    });

    expect(next.status).toBe(200);
  });

  /**
   * The race the pause check cannot see. Answering claims the pause first, so
   * by the time a second request looks there is no open question to refuse it
   * with — and the answer is still running, still writing its messages. This is
   * the interleaving, and the lease is the only thing that catches it.
   */
  /**
   * The lease can lapse under a turn that is genuinely slow, and then a second
   * turn may already be running alongside it — the thing this prevents,
   * happening anyway. It cannot be prevented from here, so it is reported:
   * the line is the signal that `TURN_LEASE_MS` is too short for what this
   * deployment's turns cost.
   */
  it("says so when a turn outlived its lease", async () => {
    let open = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const lines: string[] = [];
    const { app, deps } = harness({
      toolsGate: gate,
      logger: capturingLogger(lines),
    });

    const turn = post(app, ASSISTANT_KIT_CHAT_PATH, chatBody("створи"));
    for (let tick = 0; tick < 50; tick += 1) {
      if (deps.pauses.entries.delete(`turn:${CONVERSATION}`)) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    open();
    await turn;

    expect(
      lines.filter((line) => line.includes("outlived its lease")),
    ).toHaveLength(1);
  });

  it("refuses a new turn while an answer is still resolving", async () => {
    let open = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const { app, kit, bind } = harness({ toolsGate: gate });
    const pause = await openPause(kit, bind);

    const answering = post(
      app,
      ASSISTANT_KIT_ANSWER_PATH,
      answerBody(pause.interactionId, pause.revision),
    );
    // Let it reach the gate. By then the pause is claimed, so nothing else
    // stands in the way of a second request — which is the whole point.
    for (let tick = 0; tick < 50; tick += 1) {
      if ((await kit.peek({ conversationId: CONVERSATION, bind })) === null) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(await kit.peek({ conversationId: CONVERSATION, bind })).toBeNull();

    const chat = await post(app, ASSISTANT_KIT_CHAT_PATH, chatBody("а тепер"));
    expect(chat.status).toBe(409);
    expect(((await chat.json()) as KitBody).status).toBe("turn_open");

    open();
    expect((await answering).status).toBe(200);
  });
});
