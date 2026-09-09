import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { CONFIRMATION_CHALLENGE_HEADER } from "@showzy/contract";

import {
  commitHostConfirmResult,
  confirmationCardState,
  confirmationResumeHeaders,
  executeConfirmationAbandon,
  executeConfirmationConfirm,
  executeConfirmationDismiss,
  executeHostConfirmationConfirm,
  hideConfirmationLocally,
  pendingConfirmationFromMessages,
  shouldHidePendingCardAfterAbandon,
  shouldMarkConfirmationResolved,
  type AssistantChatMessage,
} from "./confirmation-presenter";

const challengeA = "22222222-2222-4222-8222-222222222222";
const challengeB = "33333333-3333-4333-8333-333333333333";
const conversationId = "11111111-1111-4111-8111-111111111111";

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
    const dismissed = executeConfirmationDismiss({
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
  it("calls challenge resume with the confirmation header", async () => {
    const resume = vi.fn(() => Promise.resolve());
    const pending = pendingConfirmationFromMessages(messages, new Set());
    await expect(
      executeConfirmationConfirm({
        pending,
        sendBusy: false,
        dismissedChallengeIds: new Set(),
        resolvingRef: { current: null },
        resume,
      }),
    ).resolves.toBe("resumed");
    expect(resume).toHaveBeenCalledOnce();
    expect(resume).toHaveBeenCalledWith({
      [CONFIRMATION_CHALLENGE_HEADER]: challengeA,
    });
    expect(confirmationResumeHeaders(challengeA)).toEqual({
      [CONFIRMATION_CHALLENGE_HEADER]: challengeA,
    });
  });

  it("does not resume when dismiss runs instead", async () => {
    const resume = vi.fn(() => Promise.resolve());
    const pending = pendingConfirmationFromMessages(messages, new Set());
    const dismissed = executeConfirmationDismiss({
      pending,
      dismissed: new Set(),
    });
    await expect(
      executeConfirmationConfirm({
        pending: pendingConfirmationFromMessages(messages, dismissed),
        sendBusy: false,
        dismissedChallengeIds: dismissed,
        resolvingRef: { current: null },
        resume,
      }),
    ).resolves.toBe("skipped");
    expect(resume).not.toHaveBeenCalled();
  });

  it("does not resume when dismiss then confirm share the live dismissed set", async () => {
    const resume = vi.fn(() => Promise.resolve());
    const pending = pendingConfirmationFromMessages(messages, new Set());
    const gate = {
      dismissed: new Set<string>(),
    };
    gate.dismissed = new Set(
      executeConfirmationDismiss({
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
        resume,
      }),
    ).resolves.toBe("skipped");
    expect(resume).not.toHaveBeenCalled();
  });

  it("confirms later challenge B after A is resolved", async () => {
    const resume = vi.fn(() => Promise.resolve());
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
        resume,
      }),
    ).resolves.toBe("resumed");
    expect(resume).toHaveBeenCalledWith({
      [CONFIRMATION_CHALLENGE_HEADER]: challengeB,
    });
  });

  it("two confirm() calls before busy confirm once", async () => {
    const resume = vi.fn(() => Promise.resolve());
    const pending = pendingConfirmationFromMessages(messages, new Set());
    const resolvingRef = { current: null as string | null };
    const args = {
      pending,
      sendBusy: false,
      dismissedChallengeIds: new Set<string>(),
      resolvingRef,
      resume,
    };
    const [first, second] = await Promise.all([
      executeConfirmationConfirm(args),
      executeConfirmationConfirm(args),
    ]);
    expect(new Set([first, second])).toEqual(new Set(["resumed", "skipped"]));
    expect(resume).toHaveBeenCalledOnce();
    expect(resolvingRef.current).toBe(challengeA);
  });
});

describe("commitHostConfirmResult", () => {
  const okResult = {
    status: "ok" as const,
    speech: "Deleted the customer.",
    cards: [
      {
        kind: "confirmation" as const,
        envelope: confirmationA,
      },
    ],
    pending: null,
  };

  it("appends speech and cards when the session is still current", () => {
    const appendParts = vi.fn();
    const ignoreChallenge = vi.fn();
    expect(
      commitHostConfirmResult({
        result: okResult,
        previousChallengeId: challengeA,
        companyEpochRef: { current: 0 },
        epoch: 0,
        resolvingRef: { current: challengeA },
        appendParts,
        ignoreChallenge,
      }),
    ).toBe("applied");
    expect(appendParts).toHaveBeenCalledOnce();
    expect(appendParts).toHaveBeenCalledWith([
      { type: "text", text: "Deleted the customer." },
      { type: "data-confirmation", data: confirmationA },
    ]);
    expect(ignoreChallenge).toHaveBeenCalledWith(challengeA);
  });

  it("does not append a prior tenant result after epoch increment while POST is in flight", async () => {
    const pending = pendingConfirmationFromMessages(messages, new Set());
    let resolvePost: ((value: typeof okResult) => void) | undefined;
    const postConfirm = vi.fn(
      () =>
        new Promise<typeof okResult>((resolve) => {
          resolvePost = resolve;
        }),
    );
    const companyEpochRef = { current: 0 };
    const epoch = companyEpochRef.current;
    const resolvingRef = { current: null as string | null };
    const inFlight = executeHostConfirmationConfirm({
      pending,
      sendBusy: false,
      dismissedChallengeIds: new Set(),
      resolvingRef,
      conversationId,
      postConfirm,
    });
    expect(resolvingRef.current).toBe(challengeA);
    companyEpochRef.current += 1;
    resolvePost?.(okResult);
    const result = await inFlight;
    const appendParts = vi.fn();
    const ignoreChallenge = vi.fn();
    expect(
      commitHostConfirmResult({
        result,
        previousChallengeId: challengeA,
        companyEpochRef,
        epoch,
        resolvingRef,
        appendParts,
        ignoreChallenge,
      }),
    ).toBe("stale");
    expect(appendParts).not.toHaveBeenCalled();
    expect(ignoreChallenge).not.toHaveBeenCalled();
  });

  it("does not append a prior tenant result after reset while POST is in flight", async () => {
    const pending = pendingConfirmationFromMessages(messages, new Set());
    let resolvePost: ((value: typeof okResult) => void) | undefined;
    const postConfirm = vi.fn(
      () =>
        new Promise<typeof okResult>((resolve) => {
          resolvePost = resolve;
        }),
    );
    const companyEpochRef = { current: 0 };
    const epoch = companyEpochRef.current;
    const resolvingRef = { current: null as string | null };
    const inFlight = executeHostConfirmationConfirm({
      pending,
      sendBusy: false,
      dismissedChallengeIds: new Set(),
      resolvingRef,
      conversationId,
      postConfirm,
    });
    expect(resolvingRef.current).toBe(challengeA);
    resolvingRef.current = null;
    resolvePost?.(okResult);
    const result = await inFlight;
    const appendParts = vi.fn();
    const ignoreChallenge = vi.fn();
    expect(
      commitHostConfirmResult({
        result,
        previousChallengeId: challengeA,
        companyEpochRef,
        epoch,
        resolvingRef,
        appendParts,
        ignoreChallenge,
      }),
    ).toBe("stale");
    expect(appendParts).not.toHaveBeenCalled();
    expect(ignoreChallenge).not.toHaveBeenCalled();
  });

  it("drops expired ignore after company switch", () => {
    const appendParts = vi.fn();
    const ignoreChallenge = vi.fn();
    const companyEpochRef = { current: 0 };
    const epoch = companyEpochRef.current;
    companyEpochRef.current += 1;
    expect(
      commitHostConfirmResult({
        result: { status: "expired" },
        previousChallengeId: challengeA,
        companyEpochRef,
        epoch,
        resolvingRef: { current: challengeA },
        appendParts,
        ignoreChallenge,
      }),
    ).toBe("stale");
    expect(appendParts).not.toHaveBeenCalled();
    expect(ignoreChallenge).not.toHaveBeenCalled();
  });

  it("does not append error text onto the successor company", () => {
    const appendParts = vi.fn();
    const ignoreChallenge = vi.fn();
    const companyEpochRef = { current: 1 };
    expect(
      commitHostConfirmResult({
        result: {
          status: "error",
          code: "INTERNAL",
          message: "Confirm failed.",
        },
        previousChallengeId: challengeA,
        companyEpochRef,
        epoch: 0,
        resolvingRef: { current: challengeA },
        appendParts,
        ignoreChallenge,
      }),
    ).toBe("stale");
    expect(appendParts).not.toHaveBeenCalled();
    expect(ignoreChallenge).not.toHaveBeenCalled();
  });

  it("returns skipped without appending", () => {
    const appendParts = vi.fn();
    const ignoreChallenge = vi.fn();
    expect(
      commitHostConfirmResult({
        result: "skipped",
        previousChallengeId: challengeA,
        companyEpochRef: { current: 0 },
        epoch: 0,
        resolvingRef: { current: challengeA },
        appendParts,
        ignoreChallenge,
      }),
    ).toBe("skipped");
    expect(appendParts).not.toHaveBeenCalled();
    expect(ignoreChallenge).not.toHaveBeenCalled();
  });

  it("does not ignore the confirmation card on VALIDATION (SHO-545)", () => {
    const appendParts = vi.fn();
    const ignoreChallenge = vi.fn();
    expect(
      commitHostConfirmResult({
        result: {
          status: "error",
          code: "VALIDATION",
          message: "Customer must be archived before delete.",
        },
        previousChallengeId: challengeA,
        companyEpochRef: { current: 0 },
        epoch: 0,
        resolvingRef: { current: challengeA },
        appendParts,
        ignoreChallenge,
      }),
    ).toBe("applied");
    expect(appendParts).not.toHaveBeenCalled();
    expect(ignoreChallenge).not.toHaveBeenCalled();
    expect(pendingConfirmationFromMessages(messages, new Set())).toMatchObject({
      challengeId: challengeA,
    });
  });
});

describe("executeHostConfirmationConfirm", () => {
  it("POSTs /assistant/confirm through the injected port", async () => {
    const postConfirm = vi.fn(() =>
      Promise.resolve({
        status: "ok" as const,
        speech: "Deleted.",
        cards: [],
        pending: null,
      }),
    );
    const pending = pendingConfirmationFromMessages(messages, new Set());
    await expect(
      executeHostConfirmationConfirm({
        pending,
        sendBusy: false,
        dismissedChallengeIds: new Set(),
        resolvingRef: { current: null },
        conversationId,
        postConfirm,
      }),
    ).resolves.toMatchObject({ status: "ok", speech: "Deleted." });
    expect(postConfirm).toHaveBeenCalledWith({
      conversationId,
      challengeId: challengeA,
    });
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
        conversationId,
        pendingVersion: 1,
        peekPending: () => Promise.resolve({ kind: "unavailable" }),
        postAbandon,
      }),
    ).resolves.toMatchObject({ status: "ok" });
    expect(postAbandon).toHaveBeenCalledWith({
      conversationId,
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
        conversationId,
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
      conversationId,
      pendingId: challengeA,
      expectedVersion: 4,
    });
  });

  it("peek unavailable keeps the card and does not hide", async () => {
    const postAbandon = vi.fn(() =>
      Promise.resolve({
        status: "ok" as const,
        speech: "",
        cards: [],
        pending: null,
      }),
    );
    const pending = pendingConfirmationFromMessages(messages, new Set());
    const result = await executeConfirmationAbandon({
      pending,
      conversationId,
      pendingVersion: undefined,
      peekPending: () => Promise.resolve({ kind: "unavailable" }),
      postAbandon,
    });
    expect(result).toMatchObject({ status: "error", code: "UNAVAILABLE" });
    expect(postAbandon).not.toHaveBeenCalled();
    expect(shouldHidePendingCardAfterAbandon(result)).toBe(false);
    const dismissed = shouldHidePendingCardAfterAbandon(result)
      ? hideConfirmationLocally({ pending, dismissed: new Set() })
      : new Set<string>();
    expect(dismissed.size).toBe(0);
    expect(pendingConfirmationFromMessages(messages, dismissed)).toEqual({
      ...confirmationA,
      messageId: "a1",
    });
    expect(
      confirmationCardState({
        pending: pendingConfirmationFromMessages(messages, dismissed),
        resolvingChallengeId: null,
      }).kind,
    ).toBe("proposed");
  });

  it("abandon HTTP error keeps the card", async () => {
    const pending = pendingConfirmationFromMessages(messages, new Set());
    const result = await executeConfirmationAbandon({
      pending,
      conversationId,
      pendingVersion: 1,
      peekPending: () => Promise.resolve({ kind: "unavailable" }),
      postAbandon: () =>
        Promise.resolve({
          status: "error",
          code: "INTERNAL",
          message: "Abandon failed.",
        }),
    });
    expect(shouldHidePendingCardAfterAbandon(result)).toBe(false);
    expect(pendingConfirmationFromMessages(messages, new Set())).not.toBeNull();
  });
});

describe("hide-without-abandon is not the host card path", () => {
  it("only hides after ok or a real server expired, not peek unavailable", async () => {
    const pending = pendingConfirmationFromMessages(messages, new Set());
    const peekUnavailable = await executeConfirmationAbandon({
      pending,
      conversationId,
      pendingVersion: undefined,
      peekPending: () => Promise.resolve({ kind: "unavailable" }),
      postAbandon: () =>
        Promise.resolve({
          status: "ok",
          speech: "",
          cards: [],
          pending: null,
        }),
    });
    expect(shouldHidePendingCardAfterAbandon(peekUnavailable)).toBe(false);
    const expired = await executeConfirmationAbandon({
      pending,
      conversationId,
      pendingVersion: undefined,
      peekPending: () =>
        Promise.resolve({
          kind: "ok",
          pending: null,
        }),
      postAbandon: () =>
        Promise.resolve({
          status: "ok",
          speech: "",
          cards: [],
          pending: null,
        }),
    });
    expect(expired).toEqual({ status: "expired" });
    expect(shouldHidePendingCardAfterAbandon(expired)).toBe(true);
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
    expect(presenter).toContain("executeHostConfirmationConfirm");
    expect(presenter).toContain("commitHostConfirmResult");
    expect(presenter).toContain("isCurrentAssistantChoiceSelect");
    expect(presenter).toContain("args.resume(");
    expect(hook).toContain("executeHostConfirmationConfirm");
    expect(hook).toContain("executeConfirmationAbandon");
    expect(hook).toContain("commitHostConfirmResult");
    expect(hook).toContain("companyEpochRef");
    expect(hook).toContain("postConfirm");
    expect(hook).not.toContain("executeConfirmationConfirm");
    expect(hook).not.toContain("args.resume");
    expect(hook).not.toContain("partsFromResumeEnvelope");
    expect(card).toContain("onDismiss");
    expect(card).not.toContain("hideConfirmationLocally");
  });
});

describe("live sheet calls host HTTP (SHO-524)", () => {
  it("POSTs confirm/abandon and GETs pending from production hooks", () => {
    const sheet = readFileSync(
      new URL("../sheet/use-assistant-sheet.ts", import.meta.url),
      "utf8",
    );
    const chat = readFileSync(
      new URL("../sheet/use-assistant-chat.ts", import.meta.url),
      "utf8",
    );
    const confirmation = readFileSync(
      new URL("../sheet/use-assistant-confirmation.ts", import.meta.url),
      "utf8",
    );
    const choice = readFileSync(
      new URL("../sheet/use-assistant-choice.ts", import.meta.url),
      "utf8",
    );
    expect(chat).toContain("postAssistantChat");
    expect(chat).toContain("commitAssistantHostResult");
    expect(chat).toContain("postAssistantConfirm");
    expect(chat).toContain("postAssistantPendingAbandon");
    expect(chat).toContain("getAssistantPending");
    expect(chat).not.toContain("createStaffAssistantTransport");
    expect(chat).not.toContain("peekAssistantChoice");
    expect(confirmation).toContain("executeHostConfirmationConfirm");
    expect(confirmation).toContain("commitHostConfirmResult");
    expect(confirmation).toContain("companyEpochRef");
    expect(confirmation).toContain("executeConfirmationAbandon");
    expect(confirmation).not.toContain("executeConfirmationConfirm(");
    expect(choice).toContain("executeChoiceAbandon");
    expect(sheet).toContain("choice.dismiss");
    expect(sheet).toContain("confirmation.dismiss");
    expect(sheet).toContain("dismissPendingCard");
    expect(sheet).toContain("companyEpochRef: chat.companyEpochRef");
  });
});
