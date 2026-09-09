/**
 * The route level: auth, tenant, and what happens when the action refuses,
 * the provider fails, or the client has already left.
 *
 * No database and no live model. Auth, both stores and the provider are
 * injected, so this suite runs in a couple of seconds and can be run on every
 * save.
 */
import {
  createAssistantKit,
  type AssistantKit,
  type ToolOutcome,
} from "@showzy/assistant-kit";
import {
  stubBrokenModel,
  stubTextModel,
  testDeps,
} from "@showzy/assistant-kit/testing";
import { COMPANY_SELECTOR_HEADER } from "@showzy/contract";
import { describe, expect, it } from "vitest";

import {
  assistantInteractions,
  type AssistantInteractionTypes,
  type ChoiceResolution,
} from "./assistant-interactions.js";
import {
  ASSISTANT_KIT_CHOICE_PATH,
  createAssistantKitChoiceApp,
  type ResolveAnswer,
} from "./assistant-kit-choice.js";

const USER = "user-1";
const COMPANY = "11111111-1111-4111-8111-1111111111aa";
const OTHER_COMPANY = "22222222-2222-4222-8222-2222222222bb";
const CONVERSATION = "33333333-3333-4333-8333-333333333333";
const COMMAND = "44444444-4444-4444-8444-444444444444";

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

type Kit = AssistantKit<AssistantInteractionTypes>;

interface Harness {
  readonly kit: Kit;
  readonly app: ReturnType<typeof createAssistantKitChoiceApp>;
  readonly bind: string;
}

function harness(options?: {
  readonly session?: { user: { id: string } } | null;
  readonly resolveAnswer?: ResolveAnswer;
  readonly broken?: boolean;
}): Harness {
  const kit = createAssistantKit(testDeps(assistantInteractions));
  const app = createAssistantKitChoiceApp({
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
    model: options?.broken === true ? stubBrokenModel() : stubTextModel("Готово."),
    tools: {},
    resolveAnswer: options?.resolveAnswer ?? OK_RESOLVE,
  });
  return { kit, app, bind: `${USER}:${COMPANY}` };
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
      canonicalInput: { label: "two matches" },
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
  if (opened.kind !== "opened") throw new Error(`expected opened: ${opened.kind}`);
  return opened.pause;
}

async function post(
  app: Harness["app"],
  body: unknown,
  options?: { readonly company?: string; readonly signal?: AbortSignal },
): Promise<Response> {
  const headers = new Headers({ "content-type": "application/json" });
  const company = options?.company ?? COMPANY;
  if (company.length > 0) {
    headers.set(COMPANY_SELECTOR_HEADER, company);
  }
  return await app.request(
    new Request(`http://local${ASSISTANT_KIT_CHOICE_PATH}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      ...(options?.signal !== undefined ? { signal: options.signal } : {}),
    }),
  );
}

function answer(interactionId: string, revision: number, optionId = "opt-b") {
  return {
    commandId: COMMAND,
    conversationId: CONVERSATION,
    interactionId,
    revision,
    answer: { optionId },
  };
}

describe("POST /assistant/kit/choice — happy path", () => {
  it("writes the result card, then the explanation, and closes the pause", async () => {
    const { kit, app, bind } = harness();
    const pause = await openPause(kit, bind);

    const response = await post(app, answer(pause.interactionId, pause.revision));
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      status: string;
      parts: Array<{ kind: string; type?: string; text?: string }>;
      pause: unknown;
    };
    expect(body.status).toBe("ok");
    expect(body.pause).toBeNull();

    // The card comes first: it is the part earned before generation.
    expect(body.parts[0]?.kind).toBe("card");
    expect(body.parts[0]?.type).toBe("order-entity");
    expect(body.parts.at(-1)?.text).toContain("Готово");

    const document = await kit.document.read({
      conversationId: CONVERSATION,
      bind,
    });
    const cards = document.messages
      .flatMap((message) => message.parts)
      .filter((part) => part.kind === "card");
    expect(cards).toHaveLength(1);
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

    await post(app, answer(pause.interactionId, pause.revision));

    expect(seen).toEqual({
      entityId: "entity-b",
      canonicalInput: { label: "two matches" },
    });
  });
});

describe("POST /assistant/kit/choice — the HTTP contract", () => {
  it("401 without a session", async () => {
    const { kit, app, bind } = harness({ session: null });
    const pause = await openPause(kit, bind);

    const response = await post(app, answer(pause.interactionId, pause.revision));
    expect(response.status).toBe(401);
  });

  it("400 without the company header", async () => {
    const { kit, app, bind } = harness();
    const pause = await openPause(kit, bind);

    const response = await post(app, answer(pause.interactionId, pause.revision), {
      company: "",
    });
    expect(response.status).toBe(400);
  });

  it("400 on a body that is not an interaction response", async () => {
    const { app } = harness();

    const response = await post(app, { conversationId: CONVERSATION });
    expect(response.status).toBe(400);
  });

  it("400 on an answer the kind's schema rejects, and the card survives", async () => {
    const { kit, app, bind } = harness();
    const pause = await openPause(kit, bind);

    const response = await post(app, {
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

  it("409 with the current pause when the revision is stale", async () => {
    const { kit, app, bind } = harness();
    const pause = await openPause(kit, bind);
    await kit.revise({
      conversationId: CONVERSATION,
      bind,
      interactionId: pause.interactionId,
      next: {
        kind: "choice",
        prompt: {
          subject: "changed",
          options: [{ optionId: "opt-c", label: "C" }],
          optionsTruncated: false,
        },
        secret: {
          byOption: { "opt-c": "entity-c" },
          canonicalInput: { label: "changed" },
        },
        continuation: {
          messages: [{ role: "user", content: "again" }],
          pausedToolCall: { id: "toolu_create" as never, name: "orders_create" },
        },
      },
    });

    const response = await post(app, answer(pause.interactionId, 1));
    expect(response.status).toBe(409);
    expect(((await response.json()) as { status: string }).status).toBe("stale");
  });

  it("409 for an option this pause never offered, without spending the claim", async () => {
    const { kit, app, bind } = harness();
    const pause = await openPause(kit, bind);

    const response = await post(
      app,
      answer(pause.interactionId, pause.revision, "opt-does-not-exist"),
    );

    expect(response.status).toBe(409);
    expect(((await response.json()) as { status: string }).status).toBe(
      "unresolvable",
    );
    // Still answerable: the real option works straight afterwards.
    const retry = await post(app, answer(pause.interactionId, pause.revision));
    expect(retry.status).toBe(200);
  });
});

describe("another tenant cannot answer this pause", () => {
  it("410 for a session in a different company, and the owner's card stays open", async () => {
    const { kit, app, bind } = harness();
    const pause = await openPause(kit, bind);

    const response = await post(app, answer(pause.interactionId, pause.revision), {
      company: OTHER_COMPANY,
    });

    // The same answer as a pause that never existed: nothing to enumerate.
    expect(response.status).toBe(410);
    const owner = await kit.peek({ conversationId: CONVERSATION, bind });
    expect(owner?.interactionId).toBe(pause.interactionId);
    expect(owner?.status).toBe("open");
  });

  it("writes nothing into the other tenant's document", async () => {
    const { kit, app, bind } = harness();
    const pause = await openPause(kit, bind);

    await post(app, answer(pause.interactionId, pause.revision), {
      company: OTHER_COMPANY,
    });

    const foreign = await kit.document.read({
      conversationId: CONVERSATION,
      bind: `${USER}:${OTHER_COMPANY}`,
    });
    expect(foreign.messages).toEqual([]);
    expect(foreign.openPause).toBeNull();
  });
});

describe("a refused action leaves the card answerable", () => {
  it("409 action_failed, the pause is still open, and a retry can claim it", async () => {
    const { kit, app, bind } = harness({ resolveAnswer: FAILING_RESOLVE });
    const pause = await openPause(kit, bind);

    const response = await post(app, answer(pause.interactionId, pause.revision));
    expect(response.status).toBe(409);
    const body = (await response.json()) as { status: string; code: string };
    expect(body.status).toBe("action_failed");
    expect(body.code).toBe("CONFLICT");

    const still = await kit.peek({ conversationId: CONVERSATION, bind });
    expect(still?.status).toBe("open");
    expect(still?.revision).toBe(pause.revision);

    // Nothing was committed, so nothing was shown.
    const document = await kit.document.read({
      conversationId: CONVERSATION,
      bind,
    });
    expect(document.messages).toEqual([]);

    const retry = await kit.claim({
      conversationId: CONVERSATION,
      bind,
      interactionId: pause.interactionId,
      revision: pause.revision,
      answer: { optionId: "opt-b" },
    });
    expect(retry.kind).toBe("claimed");
  });
});

describe("a committed write survives a failed explanation", () => {
  it("keeps the result card and marks the text as error", async () => {
    const { kit, app, bind } = harness({ broken: true });
    const pause = await openPause(kit, bind);

    const response = await post(app, answer(pause.interactionId, pause.revision));
    expect(response.status).toBe(200);

    const document = await kit.document.read({
      conversationId: CONVERSATION,
      bind,
    });
    const parts = document.messages.flatMap((message) => message.parts);
    const cards = parts.filter((part) => part.kind === "card");
    const texts = parts.filter((part) => part.kind === "text");

    expect(cards).toHaveLength(1);
    expect(cards[0]?.type).toBe("order-entity");
    // No invented success sentence — the failure is stated as a failure.
    expect(texts.at(-1)?.status).toBe("error");
    expect(texts.at(-1)?.text).toBe("");
  });
});

describe("a request that is already gone performs no write", () => {
  it("499, no write, and the card is answerable again", async () => {
    let called = 0;
    const counting: ResolveAnswer = (args) => {
      called += 1;
      return OK_RESOLVE(args);
    };
    const { kit, app, bind } = harness({ resolveAnswer: counting });
    const pause = await openPause(kit, bind);

    const response = await post(
      app,
      answer(pause.interactionId, pause.revision),
      { signal: AbortSignal.abort() },
    );

    expect(response.status).toBe(499);
    expect(called).toBe(0);
    expect(
      (await kit.peek({ conversationId: CONVERSATION, bind }))?.status,
    ).toBe("open");
  });
});
