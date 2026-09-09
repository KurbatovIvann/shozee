/**
 * The pin between the two halves of the chat protocol.
 *
 * `@showzy/assistant-kit` declares the document a server writes;
 * `@showzy/validation/assistant-chat` declares the document a client reads.
 * Neither may import the other — a client app cannot depend on the kit, and the
 * kit carries no knowledge of this product. `apps/api` is the only place that
 * sees both, so the agreement is proven here.
 *
 * The strong case is the first test: a document produced by a real turn, parsed
 * by the client's schema. A field the kit adds and the client does not know
 * fails on `strictObject` before it can reach a screen.
 */
import { createAssistantKit, runHostTurn } from "@showzy/assistant-kit";
import { chatDocumentSchema } from "@showzy/assistant-kit";
import {
  stubModel,
  stubTextModel,
  stubToolCallStep,
  testDeps,
} from "@showzy/assistant-kit/testing";
import {
  assistantChatDocumentSchema,
  assistantInteractionFromPause,
} from "@showzy/validation/assistant-chat";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { assistantInteractions } from "./assistant-interactions.js";

const CONVERSATION = "33333333-3333-4333-8333-333333333333";
const BIND = "user-1:11111111-1111-4111-8111-1111111111aa";

const pausingInput = z.object({ label: z.string() });

/** Plain object rather than the SDK's `tool()`: no direct `ai` dependency. */
const PAUSING_TOOLS = {
  orders_create: {
    description: "create one",
    inputSchema: pausingInput,
    execute: (input: z.output<typeof pausingInput>) => ({
      kind: "pause" as const,
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
        target: { kind: "customer" as const, query: input.label },
      },
    }),
  },
};

function kit() {
  return createAssistantKit(testDeps(assistantInteractions));
}

async function turn(options: {
  readonly pausing: boolean;
}): Promise<ReturnType<typeof kit>> {
  const instance = kit();
  await runHostTurn({
    system: "you are a test",
    kit: instance,
    conversationId: CONVERSATION,
    bind: BIND,
    messageId: "55555555-5555-4555-8555-555555555555",
    model: options.pausing
      ? stubModel([
          stubToolCallStep("toolu_create", "orders_create", {
            label: "two matches",
          }),
        ])
      : stubTextModel("Готово."),
    tools: options.pausing ? PAUSING_TOOLS : {},
    messages: [{ role: "user", content: "create one" }],
  });
  return instance;
}

describe("the document a server writes and the document a client reads", () => {
  it("agrees on a settled turn", async () => {
    const instance = await turn({ pausing: false });

    const document = await instance.document.read({
      conversationId: CONVERSATION,
      bind: BIND,
    });

    expect(chatDocumentSchema.safeParse(document).success).toBe(true);
    const client = assistantChatDocumentSchema.safeParse(document);
    expect(client.success).toBe(true);
    expect(client.success && client.data.openPause).toBeNull();
  });

  it("agrees on a paused turn, and the client can read the question", async () => {
    const instance = await turn({ pausing: true });

    const document = await instance.document.read({
      conversationId: CONVERSATION,
      bind: BIND,
    });

    const client = assistantChatDocumentSchema.safeParse(document);
    expect(client.success).toBe(true);
    if (!client.success) {
      return;
    }
    const open = client.data.openPause;
    expect(open).not.toBeNull();
    if (open === null) {
      return;
    }
    // The prompt survives the round trip as something renderable, and the
    // server's `secret` has no field on the wire able to carry it.
    const interaction = assistantInteractionFromPause(open);
    expect(interaction).toEqual({
      kind: "choice",
      interactionId: open.interactionId,
      revision: 1,
      subject: "two matches",
      options: [
        { optionId: "opt-a", label: "A" },
        { optionId: "opt-b", label: "B" },
      ],
      optionsTruncated: false,
    });
    expect(JSON.stringify(document)).not.toContain("byOption");
  });

  it("refuses a field one side would add without the other", () => {
    const document = {
      conversationId: CONVERSATION,
      bind: BIND,
      messages: [],
      openPause: null,
      // A field a future kit might start writing.
      lastReadAt: "2026-09-09T00:00:00.000Z",
    };

    expect(chatDocumentSchema.safeParse(document).success).toBe(false);
    expect(assistantChatDocumentSchema.safeParse(document).success).toBe(false);
  });
});
