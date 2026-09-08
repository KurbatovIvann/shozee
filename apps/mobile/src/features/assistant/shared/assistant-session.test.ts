import { describe, expect, it, vi } from "vitest";

import {
  ensureAssistantConversation,
  isCurrentAssistantChoiceSelect,
  resetAssistantTenantSession,
  resumeOwnAssistantConversation,
  sendEnsuredAssistantMessage,
} from "./assistant-session";
import type {
  AssistantConversationDetail,
  AssistantListConversationsInput,
} from "./assistant-hydrate";

const conversationA = "11111111-1111-4111-8111-111111111111";
const conversationB = "55555555-5555-4555-8555-555555555555";

describe("resetAssistantTenantSession", () => {
  it("clears conversation id, messages, confirmation, and choice on company change", () => {
    const conversationIdRef = { current: conversationA };
    let messages: readonly { id: string }[] = [{ id: "stale" }];
    let confirmationReset = false;
    let choiceReset = false;
    resetAssistantTenantSession({
      conversationIdRef,
      setMessages: (next) => {
        messages = next;
      },
      resetConfirmation: () => {
        confirmationReset = true;
      },
      resetChoice: () => {
        choiceReset = true;
      },
    });
    expect(conversationIdRef.current).toBeNull();
    expect(messages).toEqual([]);
    expect(confirmationReset).toBe(true);
    expect(choiceReset).toBe(true);
  });
});

describe("isCurrentAssistantChoiceSelect", () => {
  const challengeId = "33333333-3333-4333-8333-333333333333";

  it("is current when epoch and resolving lock still match", () => {
    expect(
      isCurrentAssistantChoiceSelect({
        companyEpochRef: { current: 2 },
        epoch: 2,
        resolvingRef: { current: challengeId },
        challengeId,
      }),
    ).toBe(true);
  });

  it("is stale after company epoch increment", () => {
    const companyEpochRef = { current: 0 };
    const resolvingRef = { current: challengeId };
    const epoch = companyEpochRef.current;
    companyEpochRef.current += 1;
    expect(
      isCurrentAssistantChoiceSelect({
        companyEpochRef,
        epoch,
        resolvingRef,
        challengeId,
      }),
    ).toBe(false);
  });

  it("is stale after reset clears the resolving lock", () => {
    const resolvingRef = { current: challengeId as string | null };
    resolvingRef.current = null;
    expect(
      isCurrentAssistantChoiceSelect({
        companyEpochRef: { current: 0 },
        epoch: 0,
        resolvingRef,
        challengeId,
      }),
    ).toBe(false);
  });
});

describe("ensureAssistantConversation", () => {
  it("creates with empty input and does not send companyId", async () => {
    const conversationIdRef = { current: null as string | null };
    const companyEpochRef = { current: 0 };
    const inputs: unknown[] = [];
    const id = await ensureAssistantConversation({
      conversationIdRef,
      companyEpochRef,
      epoch: 0,
      create: () => {
        const input = {};
        inputs.push(input);
        return Promise.resolve({ id: conversationB });
      },
    });
    expect(id).toBe(conversationB);
    expect(conversationIdRef.current).toBe(conversationB);
    expect(inputs).toEqual([{}]);
    expect(JSON.stringify(inputs[0])).not.toContain("companyId");
  });

  it("reuses the existing conversation id without creating", async () => {
    const conversationIdRef = { current: conversationA };
    const companyEpochRef = { current: 0 };
    let created = 0;
    const id = await ensureAssistantConversation({
      conversationIdRef,
      companyEpochRef,
      epoch: 0,
      create: () => {
        created += 1;
        return Promise.resolve({ id: conversationB });
      },
    });
    expect(id).toBe(conversationA);
    expect(created).toBe(0);
  });

  it("creates a new conversation after a company-switch reset", async () => {
    const conversationIdRef = { current: conversationA };
    const companyEpochRef = { current: 0 };
    resetAssistantTenantSession({
      conversationIdRef,
      setMessages: () => undefined,
      resetConfirmation: () => undefined,
      resetChoice: () => undefined,
    });
    const inputs: unknown[] = [];
    const id = await ensureAssistantConversation({
      conversationIdRef,
      companyEpochRef,
      epoch: 0,
      create: () => {
        inputs.push({});
        return Promise.resolve({ id: conversationB });
      },
    });
    expect(id).toBe(conversationB);
    expect(conversationIdRef.current).toBe(conversationB);
    expect(inputs).toEqual([{}]);
    expect(JSON.stringify(inputs[0])).not.toContain("companyId");
  });
});

describe("sendEnsuredAssistantMessage", () => {
  it("drops a stale in-flight create after company switch and does not send", async () => {
    const conversationIdRef = { current: null as string | null };
    const companyEpochRef = { current: 0 };
    let resolveCreate: ((value: { readonly id: string }) => void) | undefined;
    let resolveStarted: (() => void) | undefined;
    const createStarted = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const sendMessage = vi.fn(() => Promise.resolve());

    const sendPromise = sendEnsuredAssistantMessage({
      conversationIdRef,
      companyEpochRef,
      create: () => {
        resolveStarted?.();
        return new Promise<{ readonly id: string }>((resolve) => {
          resolveCreate = resolve;
        });
      },
      sendMessage,
      text: "hello from A",
    });

    await createStarted;
    companyEpochRef.current += 1;
    resetAssistantTenantSession({
      conversationIdRef,
      setMessages: () => undefined,
      resetConfirmation: () => undefined,
      resetChoice: () => undefined,
    });
    expect(resolveCreate).toBeDefined();
    resolveCreate?.({ id: conversationA });

    await expect(sendPromise).resolves.toBe("dropped");
    expect(conversationIdRef.current).toBeNull();
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

const sessionUser = "user-own";
const colleagueUser = "user-colleague";
const conversationColleague = "22222222-2222-4222-8222-222222222222";
const orderId = "0f0e2d5c-4a1b-4c3d-9e8f-102938475601";
const messageUserId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const messageAssistantId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function ownDetail(
  conversationId: string,
  body = "Ось картка.",
): AssistantConversationDetail {
  return {
    id: conversationId,
    userId: sessionUser,
    messages: [
      {
        id: messageUserId,
        role: "user",
        body: "Покажи замовлення",
        createdAt: "2026-09-03T10:00:00.000Z",
      },
      {
        id: messageAssistantId,
        role: "assistant",
        body,
        createdAt: "2026-09-03T10:00:01.000Z",
      },
    ],
    toolRuns: [
      {
        id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        actionName: "orders.get",
        toolCallId: "call-get",
        resultIds: [orderId],
        outcome: "success",
        createdAt: "2026-09-03T10:00:01.000Z",
      },
    ],
  };
}

describe("resumeOwnAssistantConversation", () => {
  it("resumes the own-user thread and hydrates messages", async () => {
    const listInputs: AssistantListConversationsInput[] = [];
    const getInputs: Array<{ conversationId: string }> = [];
    const getOrder = vi.fn((id: string) =>
      Promise.resolve({
        orderId: id,
        orderNumber: "1049",
        status: "confirmed",
        totalGrossMinor: "1000",
        currency: "UAH",
      }),
    );
    const result = await resumeOwnAssistantConversation({
      companyEpochRef: { current: 0 },
      epoch: 0,
      sessionUserId: sessionUser,
      listConversations: (input) => {
        listInputs.push(input);
        return Promise.resolve({
          items: [
            { id: conversationColleague, userId: colleagueUser },
            { id: conversationA, userId: sessionUser },
          ],
          nextCursor: null,
        });
      },
      getConversation: (input) => {
        getInputs.push(input);
        return Promise.resolve(ownDetail(input.conversationId));
      },
      getOrder,
    });
    expect(result.kind).toBe("resumed");
    if (result.kind !== "resumed") {
      return;
    }
    expect(result.conversationId).toBe(conversationA);
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]?.parts).toEqual([
      { type: "text", text: "Покажи замовлення" },
    ]);
    expect(result.messages[1]?.parts[0]).toEqual({
      type: "text",
      text: "Ось картка.",
    });
    expect(result.messages[1]?.parts[1]).toEqual({
      type: "dynamic-tool",
      toolName: "orders.get",
      toolCallId: "call-get",
      state: "output-available",
      input: {},
      output: {
        orderId,
        orderNumber: "1049",
        status: "confirmed",
        totalGrossMinor: "1000",
        currency: "UAH",
      },
    });
    expect(listInputs).toEqual([{}]);
    expect(getInputs).toEqual([{ conversationId: conversationA }]);
    expect(JSON.stringify(listInputs)).not.toContain("userId");
    expect(JSON.stringify(getInputs)).not.toContain("userId");
    expect(JSON.stringify(listInputs)).not.toContain("companyId");
    expect(getOrder).toHaveBeenCalledWith(orderId);
  });

  it("skips a colleague newest item and leaves the sheet empty", async () => {
    const getConversation = vi.fn();
    const getOrder = vi.fn();
    const result = await resumeOwnAssistantConversation({
      companyEpochRef: { current: 0 },
      epoch: 0,
      sessionUserId: sessionUser,
      listConversations: () =>
        Promise.resolve({
          items: [{ id: conversationColleague, userId: colleagueUser }],
          nextCursor: null,
        }),
      getConversation,
      getOrder,
    });
    expect(result).toEqual({ kind: "empty" });
    expect(getConversation).not.toHaveBeenCalled();
    expect(getOrder).not.toHaveBeenCalled();
  });

  it("does not reuse the previous conversation after a company-switch reset", async () => {
    const conversationIdRef = { current: conversationA };
    const companyEpochRef = { current: 0 };
    resetAssistantTenantSession({
      conversationIdRef,
      setMessages: () => undefined,
      resetConfirmation: () => undefined,
      resetChoice: () => undefined,
    });
    companyEpochRef.current += 1;
    const result = await resumeOwnAssistantConversation({
      companyEpochRef,
      epoch: 1,
      sessionUserId: sessionUser,
      listConversations: () =>
        Promise.resolve({
          items: [{ id: conversationB, userId: sessionUser }],
          nextCursor: null,
        }),
      getConversation: (input) =>
        Promise.resolve(ownDetail(input.conversationId)),
      getOrder: (id) =>
        Promise.resolve({
          orderId: id,
          orderNumber: "1050",
          status: "new",
          totalGrossMinor: "0",
          currency: "UAH",
        }),
    });
    expect(conversationIdRef.current).toBeNull();
    expect(result.kind).toBe("resumed");
    if (result.kind !== "resumed") {
      return;
    }
    expect(result.conversationId).toBe(conversationB);
    expect(result.conversationId).not.toBe(conversationA);
  });

  it("drops an in-flight resume after company switch", async () => {
    const companyEpochRef = { current: 0 };
    let resolveList:
      | ((value: {
          readonly items: readonly {
            readonly id: string;
            readonly userId: string;
          }[];
          readonly nextCursor: string | null;
        }) => void)
      | undefined;
    const getConversation = vi.fn();
    const resumePromise = resumeOwnAssistantConversation({
      companyEpochRef,
      epoch: 0,
      sessionUserId: sessionUser,
      listConversations: () =>
        new Promise((resolve) => {
          resolveList = resolve;
        }),
      getConversation,
      getOrder: () => Promise.resolve(null),
    });
    companyEpochRef.current += 1;
    resolveList?.({
      items: [{ id: conversationA, userId: sessionUser }],
      nextCursor: null,
    });
    await expect(resumePromise).resolves.toEqual({ kind: "dropped" });
    expect(getConversation).not.toHaveBeenCalled();
  });

  it("does not call orders.get for an unrestorable list run", async () => {
    const getOrder = vi.fn();
    const result = await resumeOwnAssistantConversation({
      companyEpochRef: { current: 0 },
      epoch: 0,
      sessionUserId: sessionUser,
      listConversations: () =>
        Promise.resolve({
          items: [{ id: conversationA, userId: sessionUser }],
          nextCursor: null,
        }),
      getConversation: () =>
        Promise.resolve({
          id: conversationA,
          userId: sessionUser,
          messages: [
            {
              id: messageAssistantId,
              role: "assistant",
              body: "Ось список.",
              createdAt: "2026-09-03T10:00:01.000Z",
            },
          ],
          toolRuns: [
            {
              id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
              actionName: "orders.list",
              toolCallId: "call-list",
              resultIds: [],
              outcome: "success",
              createdAt: "2026-09-03T10:00:01.000Z",
            },
          ],
        }),
      getOrder,
    });
    expect(result.kind).toBe("resumed");
    expect(getOrder).not.toHaveBeenCalled();
    if (result.kind !== "resumed") {
      return;
    }
    expect(result.messages[0]?.parts).toEqual([
      { type: "text", text: "Ось список." },
    ]);
  });

  it("returns empty when list claims own userId but getConversation belongs to a colleague", async () => {
    const getOrder = vi.fn();
    const result = await resumeOwnAssistantConversation({
      companyEpochRef: { current: 0 },
      epoch: 0,
      sessionUserId: sessionUser,
      listConversations: () =>
        Promise.resolve({
          items: [{ id: conversationA, userId: sessionUser }],
          nextCursor: null,
        }),
      getConversation: () =>
        Promise.resolve({
          ...ownDetail(conversationA),
          userId: colleagueUser,
        }),
      getOrder,
    });
    expect(result).toEqual({ kind: "empty" });
    expect(getOrder).not.toHaveBeenCalled();
  });

  it("pins the found conversation id when getConversation throws", async () => {
    const getOrder = vi.fn();
    const getConversation = vi.fn(() =>
      Promise.reject(new Error("getConversation unavailable")),
    );
    const result = await resumeOwnAssistantConversation({
      companyEpochRef: { current: 0 },
      epoch: 0,
      sessionUserId: sessionUser,
      listConversations: () =>
        Promise.resolve({
          items: [{ id: conversationA, userId: sessionUser }],
          nextCursor: null,
        }),
      getConversation,
      getOrder,
    });
    expect(result).toEqual({
      kind: "unavailable",
      conversationId: conversationA,
    });
    expect(getConversation).toHaveBeenCalledWith({
      conversationId: conversationA,
    });
    expect(getOrder).not.toHaveBeenCalled();
  });

  it("does not create a second conversation after getConversation fails", async () => {
    const resume = await resumeOwnAssistantConversation({
      companyEpochRef: { current: 0 },
      epoch: 0,
      sessionUserId: sessionUser,
      listConversations: () =>
        Promise.resolve({
          items: [{ id: conversationA, userId: sessionUser }],
          nextCursor: null,
        }),
      getConversation: () => Promise.reject(new Error("unavailable")),
      getOrder: vi.fn(),
    });
    expect(resume.kind).toBe("unavailable");
    if (resume.kind !== "unavailable") {
      return;
    }
    const conversationIdRef = { current: resume.conversationId };
    let created = 0;
    const sendMessage = vi.fn(() => Promise.resolve());
    await sendEnsuredAssistantMessage({
      conversationIdRef,
      companyEpochRef: { current: 0 },
      create: () => {
        created += 1;
        return Promise.resolve({ id: conversationB });
      },
      sendMessage,
      text: "next turn",
    });
    expect(created).toBe(0);
    expect(conversationIdRef.current).toBe(conversationA);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("does not treat a listConversations failure as no own row", async () => {
    const getConversation = vi.fn();
    const getOrder = vi.fn();
    await expect(
      resumeOwnAssistantConversation({
        companyEpochRef: { current: 0 },
        epoch: 0,
        sessionUserId: sessionUser,
        listConversations: () => Promise.reject(new Error("list failed")),
        getConversation,
        getOrder,
      }),
    ).rejects.toThrow("list failed");
    expect(getConversation).not.toHaveBeenCalled();
    expect(getOrder).not.toHaveBeenCalled();
  });

  it("hydrates a live peek ChoiceCard and expires a missing record", async () => {
    const choiceId = "44444444-4444-4444-8444-444444444444";
    const live = {
      status: "needs_choice" as const,
      challengeId: choiceId,
      reason: "variant_required" as const,
      productName: "Macarons",
      options: [{ id: "77777777-7777-4777-8777-777777777777", label: "Lemon" }],
      optionsTruncated: false,
    };
    const peekChoice = vi.fn((input: { choiceId: string }) => {
      if (input.choiceId === choiceId) {
        return Promise.resolve(live);
      }
      return Promise.resolve({
        status: "expired" as const,
        challengeId: input.choiceId,
        options: [],
        optionsTruncated: false,
      });
    });
    const liveResult = await resumeOwnAssistantConversation({
      companyEpochRef: { current: 0 },
      epoch: 0,
      sessionUserId: sessionUser,
      listConversations: () =>
        Promise.resolve({
          items: [{ id: conversationA, userId: sessionUser }],
          nextCursor: null,
        }),
      getConversation: () =>
        Promise.resolve({
          id: conversationA,
          userId: sessionUser,
          messages: [
            {
              id: messageAssistantId,
              role: "assistant",
              body: "Select a variant.",
              createdAt: "2026-09-03T10:00:01.000Z",
            },
          ],
          toolRuns: [
            {
              id: "88888888-8888-4888-8888-888888888888",
              actionName: "orders.create",
              toolCallId: "call-create",
              challengeId: choiceId,
              resultIds: [],
              outcome: "choice_required",
              createdAt: "2026-09-03T10:00:01.000Z",
            },
          ],
        }),
      getOrder: vi.fn(),
      peekChoice,
    });
    expect(liveResult.kind).toBe("resumed");
    if (liveResult.kind !== "resumed") {
      return;
    }
    expect(liveResult.messages[0]?.parts).toEqual([
      { type: "text", text: "Select a variant." },
      { type: "data-choice", data: live },
    ]);
    expect(peekChoice).toHaveBeenCalledWith({
      conversationId: conversationA,
      choiceId,
    });

    const claimed = {
      status: "claimed" as const,
      challengeId: choiceId,
      reason: "variant_required" as const,
      productName: "Macarons",
      options: [{ id: "77777777-7777-4777-8777-777777777777", label: "Lemon" }],
      optionsTruncated: false,
      claimedOptionId: "77777777-7777-4777-8777-777777777777",
    };
    const claimedPeek = vi.fn(() => Promise.resolve(claimed));
    const claimedResult = await resumeOwnAssistantConversation({
      companyEpochRef: { current: 0 },
      epoch: 0,
      sessionUserId: sessionUser,
      listConversations: () =>
        Promise.resolve({
          items: [{ id: conversationA, userId: sessionUser }],
          nextCursor: null,
        }),
      getConversation: () =>
        Promise.resolve({
          id: conversationA,
          userId: sessionUser,
          messages: [
            {
              id: messageAssistantId,
              role: "assistant",
              body: "Select a variant.",
              createdAt: "2026-09-03T10:00:01.000Z",
            },
          ],
          toolRuns: [
            {
              id: "88888888-8888-4888-8888-888888888888",
              actionName: "orders.create",
              toolCallId: "call-create",
              challengeId: choiceId,
              resultIds: [],
              outcome: "choice_required",
              createdAt: "2026-09-03T10:00:01.000Z",
            },
          ],
        }),
      getOrder: vi.fn(),
      peekChoice: claimedPeek,
    });
    expect(claimedResult.kind).toBe("resumed");
    if (claimedResult.kind !== "resumed") {
      return;
    }
    expect(claimedResult.messages[0]?.parts).toEqual([
      { type: "text", text: "Select a variant." },
      { type: "data-choice", data: claimed },
    ]);
    expect(claimedPeek).toHaveBeenCalledWith({
      conversationId: conversationA,
      choiceId,
    });
    expect(claimed.claimedOptionId).toBe(
      "77777777-7777-4777-8777-777777777777",
    );
    expect(JSON.stringify(claimed)).not.toContain("canonicalInput");
    expect(JSON.stringify(claimed)).not.toContain("optionMap");

    const expiredResult = await resumeOwnAssistantConversation({
      companyEpochRef: { current: 0 },
      epoch: 0,
      sessionUserId: sessionUser,
      listConversations: () =>
        Promise.resolve({
          items: [{ id: conversationA, userId: sessionUser }],
          nextCursor: null,
        }),
      getConversation: () =>
        Promise.resolve({
          id: conversationA,
          userId: sessionUser,
          messages: [
            {
              id: messageAssistantId,
              role: "assistant",
              body: "Select a variant.",
              createdAt: "2026-09-03T10:00:01.000Z",
            },
          ],
          toolRuns: [
            {
              id: "88888888-8888-4888-8888-888888888888",
              actionName: "orders.create",
              toolCallId: "call-create",
              challengeId: choiceId,
              resultIds: [],
              outcome: "choice_required",
              createdAt: "2026-09-03T10:00:01.000Z",
            },
          ],
        }),
      getOrder: vi.fn(),
      peekChoice: () =>
        Promise.resolve({
          status: "expired",
          challengeId: choiceId,
          options: [],
          optionsTruncated: false,
        }),
    });
    expect(expiredResult.kind).toBe("resumed");
    if (expiredResult.kind !== "resumed") {
      return;
    }
    expect(expiredResult.messages[0]?.parts[1]).toEqual({
      type: "data-choice",
      data: {
        status: "expired",
        challengeId: choiceId,
        options: [],
        optionsTruncated: false,
      },
    });

    const unavailableResult = await resumeOwnAssistantConversation({
      companyEpochRef: { current: 0 },
      epoch: 0,
      sessionUserId: sessionUser,
      listConversations: () =>
        Promise.resolve({
          items: [{ id: conversationA, userId: sessionUser }],
          nextCursor: null,
        }),
      getConversation: () =>
        Promise.resolve({
          id: conversationA,
          userId: sessionUser,
          messages: [
            {
              id: messageAssistantId,
              role: "assistant",
              body: "Select a variant.",
              createdAt: "2026-09-03T10:00:01.000Z",
            },
          ],
          toolRuns: [
            {
              id: "88888888-8888-4888-8888-888888888888",
              actionName: "orders.create",
              toolCallId: "call-create",
              challengeId: choiceId,
              resultIds: [],
              outcome: "choice_required",
              createdAt: "2026-09-03T10:00:01.000Z",
            },
          ],
        }),
      getOrder: vi.fn(),
      peekChoice: () => Promise.reject(new TypeError("Failed to fetch")),
    });
    expect(unavailableResult.kind).toBe("resumed");
    if (unavailableResult.kind !== "resumed") {
      return;
    }
    expect(unavailableResult.messages[0]?.parts).toEqual([
      { type: "text", text: "Select a variant." },
    ]);
    expect(JSON.stringify(unavailableResult.messages)).not.toContain(
      '"status":"expired"',
    );

    const recoveredResult = await resumeOwnAssistantConversation({
      companyEpochRef: { current: 0 },
      epoch: 0,
      sessionUserId: sessionUser,
      listConversations: () =>
        Promise.resolve({
          items: [{ id: conversationA, userId: sessionUser }],
          nextCursor: null,
        }),
      getConversation: () =>
        Promise.resolve({
          id: conversationA,
          userId: sessionUser,
          messages: [
            {
              id: messageAssistantId,
              role: "assistant",
              body: "Select a variant.",
              createdAt: "2026-09-03T10:00:01.000Z",
            },
          ],
          toolRuns: [
            {
              id: "88888888-8888-4888-8888-888888888888",
              actionName: "orders.create",
              toolCallId: "call-create",
              challengeId: choiceId,
              resultIds: [],
              outcome: "choice_required",
              createdAt: "2026-09-03T10:00:01.000Z",
            },
          ],
        }),
      getOrder: vi.fn(),
      peekChoice: () => Promise.resolve(live),
    });
    expect(recoveredResult.kind).toBe("resumed");
    if (recoveredResult.kind !== "resumed") {
      return;
    }
    expect(recoveredResult.messages[0]?.parts[1]).toEqual({
      type: "data-choice",
      data: live,
    });
  });

  it("hydrates an open confirmation from GET /assistant/pending", async () => {
    const challengeId = "22222222-2222-4222-8222-222222222222";
    const pending = {
      kind: "confirmation" as const,
      id: challengeId,
      version: 2,
      status: "open" as const,
      actionName: "customers.deleteCustomer",
      challengeId,
      summary: "Delete this archived customer.",
      expiresAt: "2026-09-08T12:00:00.000Z",
      toolCallId: "call-delete",
    };
    const result = await resumeOwnAssistantConversation({
      companyEpochRef: { current: 0 },
      epoch: 0,
      sessionUserId: sessionUser,
      listConversations: () =>
        Promise.resolve({
          items: [{ id: conversationA, userId: sessionUser }],
          nextCursor: null,
        }),
      getConversation: () => Promise.resolve(ownDetail(conversationA)),
      getOrder: (id) =>
        Promise.resolve({
          orderId: id,
          orderNumber: "1049",
          status: "confirmed",
          totalGrossMinor: "1000",
          currency: "UAH",
        }),
      peekPending: () => Promise.resolve({ kind: "ok", pending }),
    });
    expect(result.kind).toBe("resumed");
    if (result.kind !== "resumed") {
      return;
    }
    expect(result.pending).toEqual(pending);
    expect(
      result.messages[1]?.parts.some(
        (part) =>
          part.type === "data-confirmation" &&
          "data" in part &&
          part.data.challengeId === challengeId,
      ),
    ).toBe(true);
  });

  it("hydrates an open choice from GET /assistant/pending without peekChoice", async () => {
    const choiceId = "44444444-4444-4444-8444-444444444444";
    const envelope = {
      status: "needs_choice" as const,
      challengeId: choiceId,
      reason: "variant_required" as const,
      productName: "Macarons",
      options: [{ id: "77777777-7777-4777-8777-777777777777", label: "Lemon" }],
      optionsTruncated: false,
    };
    const result = await resumeOwnAssistantConversation({
      companyEpochRef: { current: 0 },
      epoch: 0,
      sessionUserId: sessionUser,
      listConversations: () =>
        Promise.resolve({
          items: [{ id: conversationA, userId: sessionUser }],
          nextCursor: null,
        }),
      getConversation: () =>
        Promise.resolve({
          id: conversationA,
          userId: sessionUser,
          messages: [
            {
              id: messageAssistantId,
              role: "assistant",
              body: "Select a variant.",
              createdAt: "2026-09-03T10:00:01.000Z",
            },
          ],
          toolRuns: [
            {
              id: "88888888-8888-4888-8888-888888888888",
              actionName: "orders.create",
              toolCallId: "call-create",
              challengeId: choiceId,
              resultIds: [],
              outcome: "choice_required",
              createdAt: "2026-09-03T10:00:01.000Z",
            },
          ],
        }),
      getOrder: vi.fn(),
      peekPending: () =>
        Promise.resolve({
          kind: "ok",
          pending: {
            kind: "choice",
            id: choiceId,
            version: 1,
            status: "open",
            actionName: "orders.create",
            envelope,
          },
        }),
    });
    expect(result.kind).toBe("resumed");
    if (result.kind !== "resumed") {
      return;
    }
    expect(result.messages[0]?.parts[1]).toEqual({
      type: "data-choice",
      data: envelope,
    });
  });
});
