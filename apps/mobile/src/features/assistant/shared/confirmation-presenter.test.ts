import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { CONFIRMATION_CHALLENGE_HEADER } from "@showzy/contract";

import {
  confirmationCardState,
  confirmationResumeHeaders,
  executeConfirmationAbandon,
  executeConfirmationConfirm,
  hideConfirmationLocally,
  pendingConfirmationFromMessages,
  shouldMarkConfirmationResolved,
  type AssistantChatMessage,
} from "./confirmation-presenter";

const challengeA = "22222222-2222-4222-8222-222222222222";
const challengeB = "33333333-3333-4333-8333-333333333333";

const confirmationA = {
  status: "confirmation_required" as const,
  challengeId: challengeA,
  summary: "Delete this archived customer.",
  expiresAt: "2026-09-01T12:00:00.000Z",
  actionName: "customers.deleteCustomer",
  toolCallId: "call-delete",
};

const confirmationB = {
  status: "confirmation_required" as const,
  challengeId: challengeB,
  summary: "Request a signature.",
  expiresAt: "2026-09-01T12:05:00.000Z",
  actionName: "documents.requestSign",
  toolCallId: "call-sign",
};

const messages: readonly AssistantChatMessage[] = [
  {
    id: "u1",
    role: "user",
    parts: [{ type: "text", text: "Delete the customer" }],
  },
  {
    id: "a1",
    role: "assistant",
    parts: [
      { type: "text", text: "Confirmation required." },
      { type: "data-confirmation", data: confirmationA },
    ],
  },
];

const mergedResumeMessages: readonly AssistantChatMessage[] = [
  {
    id: "u1",
    role: "user",
    parts: [{ type: "text", text: "Delete then request sign" }],
  },
  {
    id: "a1",
    role: "assistant",
    parts: [
      { type: "text", text: "Confirmation required." },
      { type: "data-confirmation", data: confirmationA },
      { type: "data-confirmation", data: confirmationB },
    ],
  },
];

describe("pendingConfirmationFromMessages", () => {
  it("shows a card when confirmation is required", () => {
    expect(pendingConfirmationFromMessages(messages, new Set())).toEqual({
      ...confirmationA,
      messageId: "a1",
    });
    expect(
      confirmationCardState({
        pending: pendingConfirmationFromMessages(messages, new Set()),
        resolvingChallengeId: null,
      }),
    ).toEqual({
      kind: "proposed",
      confirmation: { ...confirmationA, messageId: "a1" },
    });
  });

  it("hides a dismissed challenge and does not execute", () => {
    const pending = pendingConfirmationFromMessages(messages, new Set());
    const dismissed = hideConfirmationLocally({
      pending,
      dismissed: new Set(),
    });
    expect(dismissed.has(challengeA)).toBe(true);
    expect(pendingConfirmationFromMessages(messages, dismissed)).toBeNull();
    expect(
      confirmationCardState({
        pending: pendingConfirmationFromMessages(messages, dismissed),
        resolvingChallengeId: null,
      }),
    ).toEqual({ kind: "hidden" });
  });

  it("shows the later confirmation after resolved challenge A on a merged message", () => {
    const pending = pendingConfirmationFromMessages(
      mergedResumeMessages,
      new Set([challengeA]),
    );
    expect(pending).toEqual({ ...confirmationB, messageId: "a1" });
    expect(
      confirmationCardState({
        pending,
        resolvingChallengeId: null,
      }),
    ).toEqual({
      kind: "proposed",
      confirmation: { ...confirmationB, messageId: "a1" },
    });
  });
});

describe("executeConfirmationConfirm", () => {
  it("POSTs /assistant/confirm and does not resume with the challenge header", async () => {
    const postConfirm = vi.fn(() =>
      Promise.resolve({
        status: "ok" as const,
        speech: "Deleted.",
        cards: [],
        pending: null,
      }),
    );
    const resume = vi.fn(() => Promise.resolve());
    const pending = pendingConfirmationFromMessages(messages, new Set());
    await expect(
      executeConfirmationConfirm({
        pending,
        sendBusy: false,
        dismissedChallengeIds: new Set(),
        resolvingRef: { current: null },
        conversationId: "11111111-1111-4111-8111-111111111111",
        postConfirm,
      }),
    ).resolves.toMatchObject({ status: "ok", speech: "Deleted." });
    expect(postConfirm).toHaveBeenCalledOnce();
    expect(postConfirm).toHaveBeenCalledWith({
      conversationId: "11111111-1111-4111-8111-111111111111",
      challengeId: challengeA,
    });
    expect(resume).not.toHaveBeenCalled();
    expect(confirmationResumeHeaders(challengeA)).toEqual({
      [CONFIRMATION_CHALLENGE_HEADER]: challengeA,
    });
  });

  it("does not confirm when dismiss runs instead", async () => {
    const postConfirm = vi.fn(() =>
      Promise.resolve({
        status: "ok" as const,
        speech: "",
        cards: [],
        pending: null,
      }),
    );
    const pending = pendingConfirmationFromMessages(messages, new Set());
    const dismissed = hideConfirmationLocally({
      pending,
      dismissed: new Set(),
    });
    await expect(
      executeConfirmationConfirm({
        pending: pendingConfirmationFromMessages(messages, dismissed),
        sendBusy: false,
        dismissedChallengeIds: dismissed,
        resolvingRef: { current: null },
        conversationId: "11111111-1111-4111-8111-111111111111",
        postConfirm,
      }),
    ).resolves.toBe("skipped");
    expect(postConfirm).not.toHaveBeenCalled();
  });

  it("does not confirm when dismiss then confirm share the live dismissed set", async () => {
    const postConfirm = vi.fn(() =>
      Promise.resolve({
        status: "ok" as const,
        speech: "",
        cards: [],
        pending: null,
      }),
    );
    const pending = pendingConfirmationFromMessages(messages, new Set());
    const gate = {
      dismissed: new Set<string>(),
    };
    gate.dismissed = new Set(
      hideConfirmationLocally({
        pending,
        dismissed: gate.dismissed,
      }),
    );
    await expect(
      executeConfirmationConfirm({
        pending,
        sendBusy: false,
        dismissedChallengeIds: gate.dismissed,
        resolvingRef: { current: null },
        conversationId: "11111111-1111-4111-8111-111111111111",
        postConfirm,
      }),
    ).resolves.toBe("skipped");
    expect(postConfirm).not.toHaveBeenCalled();
  });

  it("confirms later challenge B after A is resolved", async () => {
    const postConfirm = vi.fn(() =>
      Promise.resolve({
        status: "ok" as const,
        speech: "Signed.",
        cards: [],
        pending: null,
      }),
    );
    const pending = pendingConfirmationFromMessages(
      mergedResumeMessages,
      new Set([challengeA]),
    );
    await expect(
      executeConfirmationConfirm({
        pending,
        sendBusy: false,
        dismissedChallengeIds: new Set([challengeA]),
        resolvingRef: { current: null },
        conversationId: "11111111-1111-4111-8111-111111111111",
        postConfirm,
      }),
    ).resolves.toMatchObject({ status: "ok" });
    expect(postConfirm).toHaveBeenCalledWith({
      conversationId: "11111111-1111-4111-8111-111111111111",
      challengeId: challengeB,
    });
  });

  it("two confirm() calls before busy confirm once", async () => {
    const postConfirm = vi.fn(() =>
      Promise.resolve({
        status: "ok" as const,
        speech: "Deleted.",
        cards: [],
        pending: null,
      }),
    );
    const pending = pendingConfirmationFromMessages(messages, new Set());
    const resolvingRef = { current: null as string | null };
    const args = {
      pending,
      sendBusy: false,
      dismissedChallengeIds: new Set<string>(),
      resolvingRef,
      conversationId: "11111111-1111-4111-8111-111111111111",
      postConfirm,
    };
    const [first, second] = await Promise.all([
      executeConfirmationConfirm(args),
      executeConfirmationConfirm(args),
    ]);
    expect(
      new Set([
        first === "skipped" ? "skipped" : "ok",
        second === "skipped" ? "skipped" : "ok",
      ]),
    ).toEqual(new Set(["ok", "skipped"]));
    expect(postConfirm).toHaveBeenCalledOnce();
    expect(resolvingRef.current).toBe(challengeA);
  });
});

describe("shouldMarkConfirmationResolved", () => {
  const pendingA = {
    ...confirmationA,
    messageId: "a1",
  };

  it("keeps the card when a failed resume still completes ready with the same challenge", () => {
    const failedResume: readonly AssistantChatMessage[] = [
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "data-confirmation", data: confirmationA },
          {
            type: "tool-customers.deleteCustomer",
            toolCallId: "call-delete",
            state: "output-available",
            output: { status: "error", code: "INTERNAL" },
          },
        ],
      },
    ];
    expect(
      shouldMarkConfirmationResolved({
        resolvingChallengeId: challengeA,
        pending: pendingConfirmationFromMessages(failedResume, new Set()),
        hasError: false,
        messages: failedResume,
      }),
    ).toBe(false);
    expect(pendingConfirmationFromMessages(failedResume, new Set())).toEqual(
      pendingA,
    );
  });

  it("keeps the card when the stream reports a tool output-error", () => {
    const failedResume: readonly AssistantChatMessage[] = [
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "data-confirmation", data: confirmationA },
          {
            type: "tool-customers.deleteCustomer",
            toolCallId: "call-delete",
            state: "output-error",
          },
        ],
      },
    ];
    expect(
      shouldMarkConfirmationResolved({
        resolvingChallengeId: challengeA,
        pending: pendingA,
        hasError: false,
        messages: failedResume,
      }),
    ).toBe(false);
  });

  it("does not mark resolved when ready with no consume signal", () => {
    expect(
      shouldMarkConfirmationResolved({
        resolvingChallengeId: challengeA,
        pending: pendingA,
        hasError: false,
        messages,
      }),
    ).toBe(false);
  });

  it("marks resolved when the matching tool result succeeded", () => {
    const succeeded: readonly AssistantChatMessage[] = [
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "data-confirmation", data: confirmationA },
          {
            type: "tool-customers.deleteCustomer",
            toolCallId: "call-delete",
            state: "output-available",
            output: { id: "44444444-4444-4444-8444-444444444444" },
          },
        ],
      },
    ];
    expect(
      shouldMarkConfirmationResolved({
        resolvingChallengeId: challengeA,
        pending: pendingA,
        hasError: false,
        messages: succeeded,
      }),
    ).toBe(true);
  });

  it("marks resolved when a later confirmation replaced the challenge", () => {
    expect(
      shouldMarkConfirmationResolved({
        resolvingChallengeId: challengeA,
        pending: { ...confirmationB, messageId: "a1" },
        hasError: false,
        messages: mergedResumeMessages,
      }),
    ).toBe(true);
  });

  it("does not mark resolved when the chat reports an error", () => {
    expect(
      shouldMarkConfirmationResolved({
        resolvingChallengeId: challengeA,
        pending: null,
        hasError: true,
        messages,
      }),
    ).toBe(false);
  });
});

describe("executeConfirmationAbandon", () => {
  it("POSTs abandon with pendingId and expectedVersion", async () => {
    const postAbandon = vi.fn(() =>
      Promise.resolve({
        status: "ok" as const,
        speech: "",
        cards: [],
        pending: null,
      }),
    );
    const pending = pendingConfirmationFromMessages(messages, new Set());
    await expect(
      executeConfirmationAbandon({
        pending,
        conversationId: "11111111-1111-4111-8111-111111111111",
        pendingVersion: 1,
        peekPending: () => Promise.resolve({ kind: "unavailable" }),
        postAbandon,
      }),
    ).resolves.toMatchObject({ status: "ok" });
    expect(postAbandon).toHaveBeenCalledWith({
      conversationId: "11111111-1111-4111-8111-111111111111",
      pendingId: challengeA,
      expectedVersion: 1,
    });
  });

  it("peeks GET pending for version when the live card has none", async () => {
    const postAbandon = vi.fn(() =>
      Promise.resolve({
        status: "ok" as const,
        speech: "",
        cards: [],
        pending: null,
      }),
    );
    const pending = pendingConfirmationFromMessages(messages, new Set());
    await expect(
      executeConfirmationAbandon({
        pending,
        conversationId: "11111111-1111-4111-8111-111111111111",
        pendingVersion: undefined,
        peekPending: () =>
          Promise.resolve({
            kind: "ok",
            pending: {
              id: challengeA,
              version: 4,
              kind: "confirmation",
            },
          }),
        postAbandon,
      }),
    ).resolves.toMatchObject({ status: "ok" });
    expect(postAbandon).toHaveBeenCalledWith({
      conversationId: "11111111-1111-4111-8111-111111111111",
      pendingId: challengeA,
      expectedVersion: 4,
    });
  });
});

describe("hide-without-abandon is not the card path", () => {
  it("keeps local hide as a helper, not the confirmation HTTP", () => {
    const pending = pendingConfirmationFromMessages(messages, new Set());
    const hidden = hideConfirmationLocally({
      pending,
      dismissed: new Set(),
    });
    expect(hidden.has(challengeA)).toBe(true);
    const presenter = readFileSync(
      new URL("./confirmation-presenter.ts", import.meta.url),
      "utf8",
    );
    const hook = readFileSync(
      new URL("../sheet/use-assistant-confirmation.ts", import.meta.url),
      "utf8",
    );
    const card = readFileSync(
      new URL("../sheet/confirmation-card.tsx", import.meta.url),
      "utf8",
    );
    expect(presenter).toContain("executeConfirmationAbandon");
    expect(presenter).toContain("postConfirm");
    expect(presenter).not.toContain("args.resume(");
    expect(hook).toContain("executeConfirmationAbandon");
    expect(hook).toContain("postConfirm");
    expect(hook).not.toContain("chat.resume");
    expect(card).toContain("onDismiss");
    expect(card).not.toContain("hideConfirmationLocally");
  });
});
