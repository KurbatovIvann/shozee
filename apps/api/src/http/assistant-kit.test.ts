/**
 * The three `assistant-kit` routes at the HTTP level.
 *
 * No database and no live model: auth, both stores, the history port and the
 * provider are injected, so this suite runs in a couple of seconds and can be
 * run on every save.
 */
import {
  createAssistantKit,
  type AssistantKit,
  type ModelMessage,
  type ToolOutcome,
  type ToolSet,
} from "@showzy/assistant-kit";
import {
  stubBrokenModel,
  stubModel,
  stubTextModel,
  stubToolCallStep,
  testDeps,
} from "@showzy/assistant-kit/testing";
import { COMPANY_SELECTOR_HEADER } from "@showzy/contract";
import pino, { type Logger } from "pino";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  assistantInteractions,
  type AssistantInteractionTypes,
  type ChoiceResolution,
} from "./assistant-interactions.js";
import {
  ASSISTANT_KIT_ABANDON_PATH,
  ASSISTANT_KIT_ANSWER_PATH,
  ASSISTANT_KIT_CHAT_PATH,
  ASSISTANT_KIT_MESSAGES_PATH,
  createAssistantKitApp,
} from "./assistant-kit.js";
import type {
  AssistantHistoryPort,
  ResolveAnswer,
} from "./assistant-kit-http.js";

/** The guard logs refusals; nothing here asserts on them. */
function silentLogger(): Logger {
  return pino({ level: "silent" });
}

const USER = "user-1";
const COMPANY = "11111111-1111-4111-8111-1111111111aa";
const OTHER_COMPANY = "22222222-2222-4222-8222-2222222222bb";
const CONVERSATION = "33333333-3333-4333-8333-333333333333";
const COMMAND = "44444444-4444-4444-8444-444444444444";

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
}

function harness(options?: {
  readonly session?: { user: { id: string } } | null;
  readonly resolveAnswer?: ResolveAnswer;
  readonly broken?: boolean;
  readonly pausing?: boolean;
  readonly tools?: ToolSet;
}): Harness {
  const kit = createAssistantKit(testDeps(assistantInteractions));
  const history = memoryHistory();
  const model =
    options?.broken === true
      ? stubBrokenModel()
      : options?.pausing === true
        ? stubModel([
            stubToolCallStep("toolu_create", "orders_create", {
              label: "two matches",
            }),
          ])
        : stubTextModel("Готово.");
  const app = createAssistantKitApp({
    logger: silentLogger(),
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
    kit,
    model,
    tools: () => Promise.resolve(options?.tools ?? {}),
    history,
    resolveAnswer: options?.resolveAnswer ?? OK_RESOLVE,
    prompt: () => ({ system: "you are a test" }),
  });
  return { kit, app, history, bind: `${USER}:${COMPANY}` };
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
 * Every route answers with the whole stored document, so one type covers them
 * all. `parts` is loosely typed here on purpose: this suite reads the wire, not
 * the package's own union.
 */
type KitBody = {
  readonly status?: string;
  readonly reason?: string;
  readonly code?: string;
  readonly document?: {
    readonly messages: readonly {
      readonly role: string;
      readonly parts: readonly {
        readonly kind: string;
        readonly type?: string;
        readonly text?: string;
        readonly interactionId?: string;
      }[];
    }[];
    readonly openPause: {
      readonly kind: string;
      readonly interactionId: string;
      readonly revision: number;
      readonly prompt: unknown;
    } | null;
  };
};

const messagesPath = (id = CONVERSATION) =>
  `${ASSISTANT_KIT_MESSAGES_PATH}?conversationId=${id}`;

describe("POST /assistant/kit/chat", () => {
  it("runs a turn, stores the question and the answer, and saves history", async () => {
    const { app, kit, history, bind } = harness();

    const response = await post(app, ASSISTANT_KIT_CHAT_PATH, chatBody());
    expect(response.status).toBe(200);
    const body = (await response.json()) as KitBody;
    expect(body.status).toBe("ok");
    expect(body.document?.openPause).toBeNull();

    const document = await kit.document.read({
      conversationId: CONVERSATION,
      bind,
    });
    expect(document.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
    // The response is the stored document, not a second view of it.
    expect(body.document).toEqual(document);
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
    expect(body.document?.openPause?.interactionId).toBe(pause.interactionId);
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
    const open = body.document?.openPause;

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

  it("keeps the question in the document when generation fails", async () => {
    const { app, kit, bind } = harness({ broken: true });

    const response = await post(app, ASSISTANT_KIT_CHAT_PATH, chatBody());
    expect(response.status).toBe(200);

    const document = await kit.document.read({
      conversationId: CONVERSATION,
      bind,
    });
    const texts = document.messages.flatMap((message) => message.parts);
    expect(texts[0]).toMatchObject({ kind: "text", status: "complete" });
    expect(texts.at(-1)).toMatchObject({ status: "error" });
  });

  it("does nothing for a client that has already gone", async () => {
    const { app, kit, bind } = harness();

    const response = await post(app, ASSISTANT_KIT_CHAT_PATH, chatBody(), {
      signal: AbortSignal.abort(),
    });

    expect(response.status).toBe(499);
    const document = await kit.document.read({
      conversationId: CONVERSATION,
      bind,
    });
    expect(document.messages).toEqual([]);
  });

  it("410 for a conversation that belongs to someone else", async () => {
    const { app, kit, bind } = harness();
    await kit.document.write(
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

    expect(body.document).toEqual(liveBody.document);
    expect(JSON.stringify(body.document)).toBe(
      JSON.stringify(liveBody.document),
    );
  });

  it("carries the open question so a reload can show the card", async () => {
    const { app, kit, bind } = harness();
    const pause = await openPause(kit, bind);

    const response = await get(app, messagesPath());
    const body = (await response.json()) as {
      document: {
        openPause: { interactionId: string; prompt: unknown } | null;
      };
    };

    expect(body.document.openPause?.interactionId).toBe(pause.interactionId);
    expect(JSON.stringify(body)).not.toContain("entity-a");
  });

  it("400 without a usable conversation id", async () => {
    const { app } = harness();

    expect((await get(app, ASSISTANT_KIT_MESSAGES_PATH)).status).toBe(400);
    expect((await get(app, messagesPath("not-a-uuid"))).status).toBe(400);
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
      document: { messages: unknown[] };
    };
    const missingBody = (await missing.json()) as {
      document: { messages: unknown[] };
    };
    expect(foreignBody.document.messages).toEqual([]);
    expect(foreignBody.document.messages).toEqual(
      missingBody.document.messages,
    );
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
    expect(body.document?.openPause).toBeNull();
    const written = body.document?.messages.at(-1)?.parts ?? [];
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
    const document = await kit.document.read({
      conversationId: CONVERSATION,
      bind,
    });
    expect(document.messages).toEqual([]);
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

    const document = await kit.document.read({
      conversationId: CONVERSATION,
      bind,
    });
    const parts = document.messages.flatMap((message) => message.parts);
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

  it("keeps the record that the question was asked", async () => {
    const { kit, app, bind } = harness({ pausing: true, tools: PAUSING_TOOLS });
    const paused = await post(app, ASSISTANT_KIT_CHAT_PATH, chatBody());
    const asked = (await paused.json()) as KitBody;
    const interactionId = asked.document?.openPause?.interactionId ?? "";

    await post(app, ASSISTANT_KIT_ABANDON_PATH, {
      conversationId: CONVERSATION,
      interactionId,
    });

    const document = await kit.document.read({
      conversationId: CONVERSATION,
      bind,
    });
    const parts = document.messages.flatMap((message) => message.parts);
    expect(parts.filter((part) => part.kind === "interaction")).toHaveLength(1);
    expect(document.openPause).toBeNull();
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
    const open = firstBody.document?.openPause;
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

    expect(body.document?.openPause).toBeNull();
    const kinds = (body.document?.messages ?? []).flatMap((message) =>
      message.parts.map((part) => part.kind),
    );
    // The question, the interaction that was asked, and the record that came out.
    expect(kinds).toContain("interaction");
    expect(kinds.filter((kind) => kind === "card")).toHaveLength(1);
    expect(await kit.peek({ conversationId: CONVERSATION, bind })).toBeNull();
  });
});
