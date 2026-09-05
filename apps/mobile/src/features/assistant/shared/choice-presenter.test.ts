import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { assistantCopy } from "../../../i18n/assistant";
import {
  CHOICE_TRUNCATED_COPY,
  presentChoiceCardText,
  type StaffAssistantChoiceCardEnvelope,
} from "./choice";
import {
  canSelectChoiceOption,
  claimChoiceSelect,
  choiceCardOfferedOptions,
  choiceCardRetryOptionId,
  choiceCardState,
  choiceSelectAllowsSameOptionRetry,
  choiceSelectAppendParts,
  choiceSelectRememberedAttempt,
  choiceSelectShouldIgnoreChallenge,
  classifyChoiceSelect,
  commitChoiceSelectResult,
  executeChoiceSelect,
  pendingChoiceFromMessages,
  presentChoiceSelectErrorText,
  type AssistantChoiceMessage,
} from "./choice-presenter";

const choiceId = "33333333-3333-4333-8333-333333333333";
const lemonId = "88888888-8888-4888-8888-888888888888";
const vanillaId = "99999999-9999-4999-8999-999999999999";

const envelope = {
  status: "needs_choice" as const,
  challengeId: choiceId,
  reason: "variant_required" as const,
  productName: "Macarons",
  options: [
    { id: lemonId, label: "Lemon" },
    { id: vanillaId, label: "Vanilla" },
  ],
  optionsTruncated: false,
};

const successorId = "44444444-4444-4444-8444-444444444444";

const messages: readonly AssistantChoiceMessage[] = [
  {
    id: "u1",
    role: "user",
    parts: [{ type: "text", text: "Create macarons" }],
  },
  {
    id: "a1",
    role: "assistant",
    parts: [
      { type: "text", text: "Select a variant." },
      { type: "data-choice", data: envelope },
    ],
  },
];

function assistantChoiceMessage(
  id: string,
  data: StaffAssistantChoiceCardEnvelope,
): AssistantChoiceMessage {
  return {
    id,
    role: "assistant",
    parts: [
      { type: "text", text: "Select a variant." },
      { type: "data-choice", data },
    ],
  };
}

describe("executeChoiceSelect", () => {
  it("skips a duplicate tap and a different-option tap while a claim is in flight", async () => {
    const pending = pendingChoiceFromMessages(messages, new Set());
    expect(pending?.challengeId).toBe(choiceId);
    let resolvePost: ((value: { status: string }) => void) | undefined;
    const postChoice = vi.fn(
      () =>
        new Promise<{ status: string }>((resolve) => {
          resolvePost = resolve;
        }),
    );
    const resolvingRef = { current: null as string | null };
    const first = executeChoiceSelect({
      pending,
      optionId: lemonId,
      resolvingRef,
      postChoice,
    });
    const duplicate = await executeChoiceSelect({
      pending,
      optionId: lemonId,
      resolvingRef,
      postChoice,
    });
    const other = await executeChoiceSelect({
      pending,
      optionId: vanillaId,
      resolvingRef,
      postChoice,
    });
    expect(duplicate).toBe("skipped");
    expect(other).toBe("skipped");
    expect(postChoice).toHaveBeenCalledOnce();
    expect(resolvingRef.current).toBe(choiceId);
    resolvePost?.({ status: "completed" });
    await expect(first).resolves.toEqual({ status: "completed" });
  });

  it("retries a claimed recovery through POST /assistant/choice with no sendMessage", async () => {
    const claimed: StaffAssistantChoiceCardEnvelope = {
      ...envelope,
      status: "claimed",
      claimedOptionId: lemonId,
    };
    const pending = pendingChoiceFromMessages(
      [assistantChoiceMessage("a1", claimed)],
      new Set(),
    );
    const postChoice = vi.fn(() =>
      Promise.resolve({
        status: "completed",
        text: "Order #1049.",
        entity: {
          orderId: "0f0e2d5c-4a1b-4c3d-9e8f-102938475601",
          orderNumber: "1049",
        },
      }),
    );
    const result = await executeChoiceSelect({
      pending,
      optionId: lemonId,
      resolvingRef: { current: null },
      postChoice,
    });
    expect(result).toMatchObject({ status: "completed" });
    expect(postChoice).toHaveBeenCalledWith({
      choiceId: choiceId,
      optionId: lemonId,
    });
    expect(JSON.stringify(postChoice.mock.calls)).not.toContain("canonical");
    expect(JSON.stringify(postChoice.mock.calls)).not.toContain("target");
    expect(JSON.stringify(postChoice.mock.calls)).not.toContain("optionMap");
    expect(JSON.stringify(postChoice.mock.calls)).not.toContain("sendMessage");
  });

  it("does not claim an expired card", () => {
    const resolvingRef = { current: null as string | null };
    expect(
      claimChoiceSelect({
        pending: {
          ...envelope,
          status: "expired",
          options: [],
          messageId: "a1",
        },
        optionId: lemonId,
        resolvingRef,
      }),
    ).toBeNull();
    expect(resolvingRef.current).toBeNull();
  });
});

describe("pendingChoiceFromMessages", () => {
  it("restores a live needs_choice picker", () => {
    const pending = pendingChoiceFromMessages(messages, new Set());
    expect(pending).toMatchObject({
      status: "needs_choice",
      challengeId: choiceId,
      messageId: "a1",
    });
    expect(pending?.options).toHaveLength(2);
    expect(choiceCardState({ pending, resolvingChallengeId: null })).toEqual({
      kind: "proposed",
      choice: pending,
    });
  });

  it("does not treat a completed peek as a pending tappable ChoiceCard", () => {
    const completed: StaffAssistantChoiceCardEnvelope = {
      ...envelope,
      status: "completed",
    };
    const pending = pendingChoiceFromMessages(
      [assistantChoiceMessage("a1", completed)],
      new Set(),
    );
    expect(pending).toBeNull();
    expect(
      choiceCardState({
        pending: { ...completed, messageId: "a1" },
        resolvingChallengeId: null,
      }),
    ).toEqual({ kind: "hidden" });
  });

  it("restores a claimed recovery card that retries only the claimed option", () => {
    const claimed: StaffAssistantChoiceCardEnvelope = {
      ...envelope,
      status: "claimed",
      claimedOptionId: lemonId,
    };
    const pending = pendingChoiceFromMessages(
      [assistantChoiceMessage("a1", claimed)],
      new Set(),
    );
    expect(pending).toMatchObject({
      status: "claimed",
      challengeId: choiceId,
      claimedOptionId: lemonId,
      messageId: "a1",
    });
    expect(choiceCardState({ pending, resolvingChallengeId: null })).toEqual({
      kind: "proposed",
      choice: pending,
    });
    const resolvingRef = { current: null as string | null };
    expect(
      claimChoiceSelect({
        pending,
        optionId: vanillaId,
        resolvingRef,
      }),
    ).toBeNull();
    expect(resolvingRef.current).toBeNull();
    expect(
      claimChoiceSelect({
        pending,
        optionId: lemonId,
        resolvingRef,
      }),
    ).toMatchObject({ challengeId: choiceId, claimedOptionId: lemonId });
    expect(resolvingRef.current).toBe(choiceId);
  });

  it("does not retry a claimed envelope that omitted claimedOptionId", () => {
    const claimed: StaffAssistantChoiceCardEnvelope = {
      ...envelope,
      status: "claimed",
    };
    const pending = pendingChoiceFromMessages(
      [assistantChoiceMessage("a1", claimed)],
      new Set(),
    );
    expect(pending?.status).toBe("claimed");
    expect(
      claimChoiceSelect({
        pending,
        optionId: lemonId,
        resolvingRef: { current: null },
      }),
    ).toBeNull();
  });

  it("restores expired copy, not a tappable picker", () => {
    const expired: StaffAssistantChoiceCardEnvelope = {
      status: "expired",
      challengeId: choiceId,
      options: [],
      optionsTruncated: false,
    };
    const pending = pendingChoiceFromMessages(
      [assistantChoiceMessage("a1", expired)],
      new Set(),
    );
    expect(pending).toMatchObject({
      status: "expired",
      challengeId: choiceId,
      messageId: "a1",
      options: [],
    });
    expect(
      claimChoiceSelect({
        pending,
        optionId: lemonId,
        resolvingRef: { current: null },
      }),
    ).toBeNull();
    expect(choiceCardState({ pending, resolvingChallengeId: null }).kind).toBe(
      "proposed",
    );
  });

  it("still shows a sequential later needs_choice after a completed predecessor", () => {
    const completed: StaffAssistantChoiceCardEnvelope = {
      ...envelope,
      status: "completed",
    };
    const successor: StaffAssistantChoiceCardEnvelope = {
      ...envelope,
      challengeId: successorId,
    };
    const pending = pendingChoiceFromMessages(
      [
        assistantChoiceMessage("a1", completed),
        assistantChoiceMessage("a2", successor),
      ],
      new Set(),
    );
    expect(pending).toMatchObject({
      status: "needs_choice",
      challengeId: successorId,
      messageId: "a2",
    });
  });

  it("skips an ignored live challenge so a successor picker still shows", () => {
    const successor: StaffAssistantChoiceCardEnvelope = {
      ...envelope,
      challengeId: successorId,
    };
    const pending = pendingChoiceFromMessages(
      [
        assistantChoiceMessage("a1", envelope),
        assistantChoiceMessage("a2", successor),
      ],
      new Set([choiceId]),
    );
    expect(pending).toMatchObject({
      status: "needs_choice",
      challengeId: successorId,
      messageId: "a2",
    });
  });

  it("shows expired copy after ignore, not a vanished picker or live needs_choice", () => {
    const expiredParts = choiceSelectAppendParts({
      result: { status: "expired" },
      previousChoiceId: choiceId,
      locale: "en",
    });
    const nextMessages: readonly AssistantChoiceMessage[] = [
      ...messages,
      {
        id: "a2",
        role: "assistant",
        parts: expiredParts,
      },
    ];
    const pending = pendingChoiceFromMessages(
      nextMessages,
      new Set([choiceId]),
    );
    expect(pending).toMatchObject({
      status: "expired",
      challengeId: choiceId,
      messageId: "a2",
      options: [],
    });
    expect(
      claimChoiceSelect({
        pending,
        optionId: lemonId,
        resolvingRef: { current: null },
      }),
    ).toBeNull();
    expect(choiceCardState({ pending, resolvingChallengeId: null }).kind).toBe(
      "proposed",
    );
    expect(pendingChoiceFromMessages(messages, new Set([choiceId]))).toBeNull();
  });
});

describe("choiceSelectAppendParts", () => {
  const orderId = "0f0e2d5c-4a1b-4c3d-9e8f-102938475601";

  it("appends completed presenter text and an orders.create entity with empty input", () => {
    const parts = choiceSelectAppendParts({
      result: {
        status: "completed",
        text: "Order #1049.",
        entity: { orderId, orderNumber: "1049" },
      },
      previousChoiceId: choiceId,
      locale: "en",
    });
    expect(parts).toEqual([
      { type: "text", text: "Order #1049." },
      {
        type: "dynamic-tool",
        toolName: "orders.create",
        toolCallId: `choice:${choiceId}`,
        state: "output-available",
        input: {},
        output: { orderId, orderNumber: "1049" },
      },
    ]);
    expect(JSON.stringify(parts)).not.toContain("canonical");
    expect(JSON.stringify(parts)).not.toContain("target");
    expect(JSON.stringify(parts)).not.toContain("optionMap");
    expect(
      choiceSelectShouldIgnoreChallenge({
        status: "completed",
        text: "Order #1049.",
        entity: { orderId, orderNumber: "1049" },
      }),
    ).toBe(true);
  });

  it("appends server-provided sequential text and a successor data-choice", () => {
    const result = {
      status: "needs_choice" as const,
      challengeId: successorId,
      reason: "variant_required" as const,
      productName: "Eclairs",
      options: [{ id: lemonId, label: "Coffee" }],
      optionsTruncated: true,
      text: "SERVER_PRESENTER: Eclairs Coffee truncated",
    };
    const parts = choiceSelectAppendParts({
      result,
      previousChoiceId: choiceId,
      locale: "uk",
    });
    expect(parts).toEqual([
      {
        type: "text",
        text: "SERVER_PRESENTER: Eclairs Coffee truncated",
      },
      {
        type: "data-choice",
        data: {
          status: "needs_choice",
          challengeId: successorId,
          reason: "variant_required",
          productName: "Eclairs",
          options: [{ id: lemonId, label: "Coffee" }],
          optionsTruncated: true,
        },
      },
    ]);
    expect(parts[0]).toMatchObject({
      type: "text",
      text: result.text,
    });
    expect(parts[0]).not.toEqual({
      type: "text",
      text: presentChoiceCardText(
        {
          status: "needs_choice",
          challengeId: successorId,
          reason: "variant_required",
          productName: "Eclairs",
          options: [{ id: lemonId, label: "Coffee" }],
          optionsTruncated: true,
        },
        "uk",
      ),
    });
    expect(choiceSelectShouldIgnoreChallenge(result)).toBe(true);
  });

  it("appends server truncated copy as-is for uk and en, including after a locale mismatch", () => {
    const ukText = `Оберіть варіант для Еклери: Кава. ${CHOICE_TRUNCATED_COPY.uk}`;
    const enText = `Select a variant for Eclairs: Coffee. ${CHOICE_TRUNCATED_COPY.en}`;
    const ukParts = choiceSelectAppendParts({
      result: {
        status: "needs_choice",
        challengeId: successorId,
        reason: "variant_required",
        productName: "Еклери",
        options: [{ id: lemonId, label: "Кава" }],
        optionsTruncated: true,
        text: ukText,
      },
      previousChoiceId: choiceId,
      locale: "en",
    });
    expect(ukParts[0]).toEqual({ type: "text", text: ukText });
    const enParts = choiceSelectAppendParts({
      result: {
        status: "needs_choice",
        challengeId: successorId,
        reason: "variant_required",
        productName: "Eclairs",
        options: [{ id: lemonId, label: "Coffee" }],
        optionsTruncated: true,
        text: enText,
      },
      previousChoiceId: choiceId,
      locale: "uk",
    });
    expect(enParts[0]).toEqual({ type: "text", text: enText });
    expect(ukText).not.toBe(
      presentChoiceCardText(
        {
          status: "needs_choice",
          challengeId: successorId,
          productName: "Еклери",
          options: [{ id: lemonId, label: "Кава" }],
          optionsTruncated: true,
        },
        "en",
      ),
    );
  });

  it("does not invent sequential bubble text when the server omits text", () => {
    const result = {
      status: "needs_choice" as const,
      challengeId: successorId,
      reason: "variant_required" as const,
      productName: "Eclairs",
      options: [{ id: lemonId, label: "Coffee" }],
      optionsTruncated: true,
    };
    expect(
      choiceSelectAppendParts({
        result,
        previousChoiceId: choiceId,
        locale: "en",
      }),
    ).toEqual([]);
    expect(choiceSelectShouldIgnoreChallenge(result)).toBe(false);
  });

  it("does not append or ignore when sequential needs_choice omits optionsTruncated", () => {
    const result = {
      status: "needs_choice" as const,
      challengeId: successorId,
      reason: "variant_required" as const,
      productName: "Eclairs",
      options: [{ id: lemonId, label: "Coffee" }],
    };
    expect(
      choiceSelectAppendParts({
        result,
        previousChoiceId: choiceId,
        locale: "en",
      }),
    ).toEqual([]);
    expect(choiceSelectShouldIgnoreChallenge(result)).toBe(false);
  });

  it("appends a non-tappable expired envelope", () => {
    const parts = choiceSelectAppendParts({
      result: { status: "expired" },
      previousChoiceId: choiceId,
      locale: "en",
    });
    expect(parts).toEqual([
      {
        type: "data-choice",
        data: {
          status: "expired",
          challengeId: choiceId,
          options: [],
          optionsTruncated: false,
        },
      },
    ]);
    expect(
      claimChoiceSelect({
        pending: {
          status: "expired",
          challengeId: choiceId,
          options: [],
          optionsTruncated: false,
          messageId: "a1",
        },
        optionId: lemonId,
        resolvingRef: { current: null },
      }),
    ).toBeNull();
    expect(choiceSelectShouldIgnoreChallenge({ status: "expired" })).toBe(true);
  });

  it("appends conflict error text, ignores the challenge, and does not leave a tappable picker", () => {
    const result = {
      status: "error" as const,
      code: "CHOICE_OPTION_CONFLICT",
      message: "This choice was already resolved with a different option.",
    };
    expect(classifyChoiceSelect(result)).toBe("terminal");
    expect(choiceSelectShouldIgnoreChallenge(result)).toBe(true);
    expect(choiceSelectAllowsSameOptionRetry(result)).toBe(false);
    expect(
      choiceSelectAppendParts({
        result,
        previousChoiceId: choiceId,
        locale: "en",
      }),
    ).toEqual([{ type: "text", text: result.message }]);
    const pending = pendingChoiceFromMessages(messages, new Set([choiceId]));
    expect(pending).toBeNull();
    expect(
      claimChoiceSelect({
        pending,
        optionId: lemonId,
        resolvingRef: { current: null },
      }),
    ).toBeNull();
    expect(choiceCardState({ pending, resolvingChallengeId: null })).toEqual({
      kind: "hidden",
    });
  });

  it("appends invalid-option error text and retires the picker", () => {
    const result = {
      status: "error" as const,
      code: "CHOICE_INVALID_OPTION",
      message: "That option is not available.",
    };
    expect(classifyChoiceSelect(result)).toBe("terminal");
    expect(choiceSelectShouldIgnoreChallenge(result)).toBe(true);
    expect(choiceSelectAllowsSameOptionRetry(result)).toBe(false);
    expect(
      choiceSelectAppendParts({
        result,
        previousChoiceId: choiceId,
        locale: "en",
      }),
    ).toEqual([{ type: "text", text: result.message }]);
    expect(pendingChoiceFromMessages(messages, new Set([choiceId]))).toBeNull();
  });

  it("does not retire the picker on a generic parse-failure error body", () => {
    const result = {
      status: "error" as const,
      text: "Choice resume failed.",
    };
    expect(classifyChoiceSelect(result)).toBe("ambiguous");
    expect(choiceSelectShouldIgnoreChallenge(result)).toBe(false);
    expect(choiceSelectAllowsSameOptionRetry(result)).toBe(true);
    expect(
      choiceSelectAppendParts({
        result,
        previousChoiceId: choiceId,
        locale: "en",
      }),
    ).toEqual([]);
    expect(pendingChoiceFromMessages(messages, new Set())).toMatchObject({
      status: "needs_choice",
      challengeId: choiceId,
    });
    expect(
      claimChoiceSelect({
        pending: pendingChoiceFromMessages(messages, new Set()),
        optionId: lemonId,
        resolvingRef: { current: null },
      }),
    ).toMatchObject({ challengeId: choiceId });
  });

  it("uses existing assistant unavailable copy when a terminal error has no text", () => {
    const result = {
      status: "error" as const,
      code: "CHOICE_INVALID_OPTION",
    };
    expect(choiceSelectShouldIgnoreChallenge(result)).toBe(true);
    expect(
      choiceSelectAppendParts({
        result,
        previousChoiceId: choiceId,
        locale: "uk",
      }),
    ).toEqual([{ type: "text", text: assistantCopy("uk").errors.unavailable }]);
    expect(presentChoiceSelectErrorText({ status: "error" }, "en")).toBe(
      assistantCopy("en").errors.unavailable,
    );
  });

  it("does not call sendMessage from the choice presenter or tap hook", () => {
    const presenter = readFileSync(
      new URL("./choice-presenter.ts", import.meta.url),
      "utf8",
    );
    const hook = readFileSync(
      new URL("../sheet/use-assistant-choice.ts", import.meta.url),
      "utf8",
    );
    expect(presenter).toContain("Never sendMessage");
    expect(presenter).toContain("choiceSelectAppendParts");
    expect(presenter).toContain("commitChoiceSelectResult");
    expect(presenter).toContain("args.result.text");
    expect(presenter).not.toContain("presentChoiceCardText");
    expect(presenter).not.toContain("sendMessage(");
    expect(hook).toContain("commitChoiceSelectResult");
    expect(hook).toContain("companyEpochRef");
    expect(hook).toContain("attemptedRef");
    expect(hook).toContain("choiceSelectRememberedAttempt");
    expect(hook).toContain("previous: attemptedRef.current");
    expect(hook).not.toContain("sendMessage");
  });
});

describe("commitChoiceSelectResult", () => {
  const orderId = "0f0e2d5c-4a1b-4c3d-9e8f-102938475601";
  const completedResult = {
    status: "completed" as const,
    text: "Order #1049.",
    entity: { orderId, orderNumber: "1049" },
  };

  it("appends expired copy then ignores the tappable needs_choice", () => {
    const appendParts = vi.fn();
    const ignoreChallenge = vi.fn();
    const companyEpochRef = { current: 0 };
    const resolvingRef = { current: choiceId };
    const outcome = commitChoiceSelectResult({
      result: { status: "expired" },
      previousChoiceId: choiceId,
      locale: "en",
      companyEpochRef,
      epoch: 0,
      resolvingRef,
      appendParts,
      ignoreChallenge,
    });
    expect(outcome).toBe("applied");
    const appendOrder = appendParts.mock.invocationCallOrder[0];
    const ignoreOrder = ignoreChallenge.mock.invocationCallOrder[0];
    expect(appendOrder).toBeDefined();
    expect(ignoreOrder).toBeDefined();
    if (appendOrder === undefined || ignoreOrder === undefined) {
      return;
    }
    expect(appendOrder).toBeLessThan(ignoreOrder);
    expect(appendParts).toHaveBeenCalledWith([
      {
        type: "data-choice",
        data: {
          status: "expired",
          challengeId: choiceId,
          options: [],
          optionsTruncated: false,
        },
      },
    ]);
    expect(ignoreChallenge).toHaveBeenCalledWith(choiceId);
    const expiredParts = choiceSelectAppendParts({
      result: { status: "expired" },
      previousChoiceId: choiceId,
      locale: "en",
    });
    const nextMessages: readonly AssistantChoiceMessage[] = [
      ...messages,
      {
        id: "a2",
        role: "assistant",
        parts: expiredParts,
      },
    ];
    const pending = pendingChoiceFromMessages(
      nextMessages,
      new Set([choiceId]),
    );
    expect(pending?.status).toBe("expired");
    expect(
      claimChoiceSelect({
        pending,
        optionId: lemonId,
        resolvingRef: { current: null },
      }),
    ).toBeNull();
  });

  it("does not append a prior tenant result after epoch increment while POST is in flight", async () => {
    const pending = pendingChoiceFromMessages(messages, new Set());
    expect(pending?.challengeId).toBe(choiceId);
    let resolvePost: ((value: typeof completedResult) => void) | undefined;
    const postChoice = vi.fn(
      () =>
        new Promise<typeof completedResult>((resolve) => {
          resolvePost = resolve;
        }),
    );
    const companyEpochRef = { current: 0 };
    const epoch = companyEpochRef.current;
    const resolvingRef = { current: null as string | null };
    const inFlight = executeChoiceSelect({
      pending,
      optionId: lemonId,
      resolvingRef,
      postChoice,
    });
    expect(resolvingRef.current).toBe(choiceId);
    companyEpochRef.current += 1;
    resolvePost?.(completedResult);
    const result = await inFlight;
    const appendParts = vi.fn();
    const ignoreChallenge = vi.fn();
    expect(
      commitChoiceSelectResult({
        result,
        previousChoiceId: choiceId,
        locale: "en",
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
    const pending = pendingChoiceFromMessages(messages, new Set());
    expect(pending?.challengeId).toBe(choiceId);
    let resolvePost: ((value: typeof completedResult) => void) | undefined;
    const postChoice = vi.fn(
      () =>
        new Promise<typeof completedResult>((resolve) => {
          resolvePost = resolve;
        }),
    );
    const companyEpochRef = { current: 0 };
    const epoch = companyEpochRef.current;
    const resolvingRef = { current: null as string | null };
    const inFlight = executeChoiceSelect({
      pending,
      optionId: lemonId,
      resolvingRef,
      postChoice,
    });
    expect(resolvingRef.current).toBe(choiceId);
    resolvingRef.current = null;
    resolvePost?.(completedResult);
    const result = await inFlight;
    const appendParts = vi.fn();
    const ignoreChallenge = vi.fn();
    expect(
      commitChoiceSelectResult({
        result,
        previousChoiceId: choiceId,
        locale: "en",
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

  it("appends completed text and entity when the session is still current", () => {
    const appendParts = vi.fn();
    const ignoreChallenge = vi.fn();
    expect(
      commitChoiceSelectResult({
        result: completedResult,
        previousChoiceId: choiceId,
        locale: "en",
        companyEpochRef: { current: 0 },
        epoch: 0,
        resolvingRef: { current: choiceId },
        appendParts,
        ignoreChallenge,
      }),
    ).toBe("applied");
    expect(appendParts).toHaveBeenCalledOnce();
    expect(ignoreChallenge).toHaveBeenCalledWith(choiceId);
    expect(JSON.stringify(appendParts.mock.calls[0]?.[0])).not.toContain(
      "sendMessage",
    );
  });

  it("appends error text, ignores the picker, and does not leave needs_choice", () => {
    const appendParts = vi.fn();
    const ignoreChallenge = vi.fn();
    const result = {
      status: "error" as const,
      code: "CHOICE_OPTION_CONFLICT",
      message: "This choice was already resolved with a different option.",
    };
    expect(
      commitChoiceSelectResult({
        result,
        previousChoiceId: choiceId,
        locale: "en",
        companyEpochRef: { current: 0 },
        epoch: 0,
        resolvingRef: { current: choiceId },
        appendParts,
        ignoreChallenge,
      }),
    ).toBe("applied");
    expect(appendParts).toHaveBeenCalledWith([
      { type: "text", text: result.message },
    ]);
    expect(ignoreChallenge).toHaveBeenCalledWith(choiceId);
    expect(pendingChoiceFromMessages(messages, new Set([choiceId]))).toBeNull();
  });

  it("keeps the card after RETRY_IN_PROGRESS 409 so the same option can be posted again", () => {
    const appendParts = vi.fn();
    const ignoreChallenge = vi.fn();
    const result = {
      status: "error" as const,
      code: "RETRY_IN_PROGRESS",
      httpStatus: 409,
      retryAfterSec: 2,
      message:
        "A previous attempt of this request is still in progress. Retry shortly.",
    };
    expect(classifyChoiceSelect(result)).toBe("retryable");
    expect(choiceSelectShouldIgnoreChallenge(result)).toBe(false);
    expect(choiceSelectAllowsSameOptionRetry(result)).toBe(true);
    expect(
      commitChoiceSelectResult({
        result,
        previousChoiceId: choiceId,
        locale: "en",
        companyEpochRef: { current: 0 },
        epoch: 0,
        resolvingRef: { current: choiceId },
        appendParts,
        ignoreChallenge,
      }),
    ).toBe("applied");
    expect(appendParts).not.toHaveBeenCalled();
    expect(ignoreChallenge).not.toHaveBeenCalled();
    const pending = pendingChoiceFromMessages(messages, new Set());
    const resolvingRef = { current: null as string | null };
    expect(
      claimChoiceSelect({
        pending,
        optionId: lemonId,
        resolvingRef,
      }),
    ).toMatchObject({ challengeId: choiceId });
    expect(resolvingRef.current).toBe(choiceId);
  });
});

describe("choice select recoverability", () => {
  it("classifies numeric 409 by code, not every 409 as retryable", () => {
    expect(
      classifyChoiceSelect({
        status: "error",
        code: "RETRY_IN_PROGRESS",
        httpStatus: 409,
        retryAfterSec: 1,
      }),
    ).toBe("retryable");
    expect(
      classifyChoiceSelect({
        status: "error",
        code: "CONFLICT",
        httpStatus: 409,
      }),
    ).toBe("ambiguous");
    expect(
      classifyChoiceSelect({
        status: "error",
        code: "CHOICE_OPTION_CONFLICT",
        httpStatus: 200,
      }),
    ).toBe("terminal");
  });

  it("retains the picker for 429, 500, 503, network, and malformed outcomes", () => {
    const retryable = [
      {
        status: "error",
        code: "RATE_LIMITED",
        httpStatus: 429,
        retryAfterSec: 12,
      },
      {
        status: "error",
        code: "INTERNAL",
        httpStatus: 500,
      },
      {
        status: "error",
        httpStatus: 503,
        recoverability: "retryable" as const,
      },
      { status: "error", recoverability: "retryable" as const },
      {
        status: "error",
        httpStatus: 200,
        recoverability: "ambiguous" as const,
      },
    ] as const;
    for (const result of retryable) {
      expect(choiceSelectShouldIgnoreChallenge(result)).toBe(false);
      expect(choiceSelectAllowsSameOptionRetry(result)).toBe(true);
      expect(
        choiceSelectAppendParts({
          result,
          previousChoiceId: choiceId,
          locale: "en",
        }),
      ).toEqual([]);
    }
  });

  it("does not start an automatic retry loop from executeChoiceSelect", async () => {
    const postChoice = vi.fn(() =>
      Promise.resolve({
        status: "error",
        code: "INTERNAL",
        httpStatus: 500,
      }),
    );
    const pending = pendingChoiceFromMessages(messages, new Set());
    const result = await executeChoiceSelect({
      pending,
      optionId: lemonId,
      resolvingRef: { current: null },
      postChoice,
    });
    expect(result).toMatchObject({ status: "error", httpStatus: 500 });
    expect(postChoice).toHaveBeenCalledOnce();
    expect(postChoice).toHaveBeenCalledWith({
      choiceId,
      optionId: lemonId,
    });
  });

  it("permits a second same-option POST after the tap lock is released", async () => {
    const postChoice = vi.fn(() =>
      Promise.resolve({
        status: "completed",
        text: "Order #1049.",
        entity: {
          orderId: "0f0e2d5c-4a1b-4c3d-9e8f-102938475601",
          orderNumber: "1049",
        },
      }),
    );
    const pending = pendingChoiceFromMessages(messages, new Set());
    const resolvingRef = { current: null as string | null };
    const first = await executeChoiceSelect({
      pending,
      optionId: lemonId,
      resolvingRef,
      postChoice,
    });
    expect(
      choiceSelectAllowsSameOptionRetry({
        status: "error",
        code: "INTERNAL",
        httpStatus: 500,
      }),
    ).toBe(true);
    expect(first).toMatchObject({ status: "completed" });
    resolvingRef.current = null;
    const second = await executeChoiceSelect({
      pending,
      optionId: lemonId,
      resolvingRef,
      postChoice,
    });
    expect(second).toMatchObject({ status: "completed" });
    expect(postChoice).toHaveBeenCalledTimes(2);
    expect(postChoice).toHaveBeenNthCalledWith(1, {
      choiceId,
      optionId: lemonId,
    });
    expect(postChoice).toHaveBeenNthCalledWith(2, {
      choiceId,
      optionId: lemonId,
    });
  });

  it("gives distinct terminal copy for expired, invalid, and forbidden without unauthorized resume", () => {
    const expired = { status: "expired" as const };
    const invalid = {
      status: "error" as const,
      code: "CHOICE_INVALID_OPTION",
      message: "That option is not available.",
    };
    const forbidden = {
      status: "error" as const,
      code: "PERMISSION_DENIED",
      httpStatus: 403,
      message: "You do not have permission to perform this action.",
    };
    const unauthenticated = {
      status: "error" as const,
      code: "UNAUTHENTICATED",
      httpStatus: 401,
      message: "Authentication required.",
    };
    expect(
      choiceSelectAppendParts({
        result: expired,
        previousChoiceId: choiceId,
        locale: "en",
      }),
    ).toEqual([
      {
        type: "data-choice",
        data: {
          status: "expired",
          challengeId: choiceId,
          options: [],
          optionsTruncated: false,
        },
      },
    ]);
    expect(
      choiceSelectAppendParts({
        result: invalid,
        previousChoiceId: choiceId,
        locale: "en",
      }),
    ).toEqual([{ type: "text", text: invalid.message }]);
    expect(
      choiceSelectAppendParts({
        result: forbidden,
        previousChoiceId: choiceId,
        locale: "en",
      }),
    ).toEqual([{ type: "text", text: assistantCopy("en").errors.permission }]);
    expect(
      choiceSelectAppendParts({
        result: unauthenticated,
        previousChoiceId: choiceId,
        locale: "en",
      }),
    ).toEqual([
      { type: "text", text: assistantCopy("en").errors.unauthenticated },
    ]);
    expect(presentChoiceSelectErrorText(forbidden, "en")).not.toBe(
      presentChoiceSelectErrorText(unauthenticated, "en"),
    );
    expect(presentChoiceSelectErrorText(invalid, "en")).not.toBe(
      presentChoiceSelectErrorText(forbidden, "en"),
    );
    for (const result of [expired, invalid, forbidden, unauthenticated]) {
      expect(choiceSelectShouldIgnoreChallenge(result)).toBe(true);
      expect(choiceSelectAllowsSameOptionRetry(result)).toBe(false);
      expect(
        claimChoiceSelect({
          pending: pendingChoiceFromMessages(messages, new Set([choiceId])),
          optionId: lemonId,
          resolvingRef: { current: null },
        }),
      ).toBeNull();
    }
  });
});

describe("incomplete success-shaped bodies (SHO-452)", () => {
  const orderId = "0f0e2d5c-4a1b-4c3d-9e8f-102938475601";

  it("keeps a completed body without text or entity recoverable", () => {
    const result = { status: "completed" as const };
    expect(classifyChoiceSelect(result)).toBe("ambiguous");
    expect(choiceSelectShouldIgnoreChallenge(result)).toBe(false);
    expect(
      choiceSelectAppendParts({
        result,
        previousChoiceId: choiceId,
        locale: "en",
      }),
    ).toEqual([]);
    const pending = pendingChoiceFromMessages(messages, new Set());
    expect(pending?.status).toBe("needs_choice");
    expect(
      claimChoiceSelect({
        pending,
        optionId: lemonId,
        resolvingRef: { current: null },
      }),
    ).toMatchObject({ challengeId: choiceId });
  });

  it("keeps completed with invalid entity recoverable", () => {
    const result = {
      status: "completed" as const,
      text: "Order #1049.",
      entity: { orderId: "not-a-uuid", orderNumber: "1049" },
    };
    expect(classifyChoiceSelect(result)).toBe("ambiguous");
    expect(choiceSelectShouldIgnoreChallenge(result)).toBe(false);
    expect(
      choiceSelectAppendParts({
        result,
        previousChoiceId: choiceId,
        locale: "en",
      }),
    ).toEqual([]);
  });

  it("keeps completed with empty text recoverable even when entity is present", () => {
    const result = {
      status: "completed" as const,
      text: "",
      entity: { orderId, orderNumber: "1049" },
    };
    expect(classifyChoiceSelect(result)).toBe("ambiguous");
    expect(choiceSelectShouldIgnoreChallenge(result)).toBe(false);
  });
});

describe("HTTP 200 domain error vs HTTP 409 uncertain (SHO-452)", () => {
  it("treats a valid HTTP 200 interaction CONFLICT as terminal presenter text", () => {
    const uk =
      "«Macarons» в архіві, в замовлення його додати не можна. Напишіть інший товар або повторіть замовлення без нього.";
    const result = {
      status: "error" as const,
      code: "CONFLICT",
      message: uk,
      httpStatus: 200,
    };
    expect(classifyChoiceSelect(result)).toBe("terminal");
    expect(choiceSelectShouldIgnoreChallenge(result)).toBe(true);
    expect(choiceSelectAllowsSameOptionRetry(result)).toBe(false);
    expect(
      choiceSelectAppendParts({
        result,
        previousChoiceId: choiceId,
        locale: "uk",
      }),
    ).toEqual([{ type: "text", text: uk }]);
    expect(presentChoiceSelectErrorText(result, "en")).toBe(uk);
    expect(pendingChoiceFromMessages(messages, new Set([choiceId]))).toBeNull();
  });

  it("does not treat HTTP 409 CONFLICT as a terminal domain completion", () => {
    const result = {
      status: "error" as const,
      code: "CONFLICT",
      message: "PDF generation failed.",
      httpStatus: 409,
    };
    expect(classifyChoiceSelect(result)).toBe("ambiguous");
    expect(choiceSelectShouldIgnoreChallenge(result)).toBe(false);
    expect(choiceSelectAllowsSameOptionRetry(result)).toBe(true);
    expect(
      choiceSelectAppendParts({
        result,
        previousChoiceId: choiceId,
        locale: "en",
      }),
    ).toEqual([]);
    const pending = pendingChoiceFromMessages(messages, new Set());
    expect(pending?.status).toBe("needs_choice");
  });

  it("keeps an HTTP 200 error without code or message ambiguous", () => {
    const result = {
      status: "error" as const,
      httpStatus: 200,
    };
    expect(classifyChoiceSelect(result)).toBe("ambiguous");
    expect(choiceSelectShouldIgnoreChallenge(result)).toBe(false);
  });
});

describe("same-option recovery after an uncertain POST (SHO-452)", () => {
  const uncertain = {
    status: "error" as const,
    httpStatus: 503,
    recoverability: "retryable" as const,
  };

  it("does not POST a different option after an uncertain result", async () => {
    const pending = pendingChoiceFromMessages(messages, new Set());
    const postChoice = vi.fn(() => Promise.resolve(uncertain));
    const resolvingRef = { current: null as string | null };
    const first = await executeChoiceSelect({
      pending,
      optionId: lemonId,
      resolvingRef,
      postChoice,
    });
    expect(first).toMatchObject({ status: "error", httpStatus: 503 });
    const attempted = choiceSelectRememberedAttempt({
      result: first,
      challengeId: choiceId,
      optionId: lemonId,
      previous: null,
    });
    expect(attempted).toEqual({ challengeId: choiceId, optionId: lemonId });
    resolvingRef.current = null;
    const other = await executeChoiceSelect({
      pending,
      optionId: vanillaId,
      resolvingRef,
      attempted,
      postChoice,
    });
    expect(other).toBe("skipped");
    expect(postChoice).toHaveBeenCalledOnce();
    expect(postChoice).toHaveBeenCalledWith({
      choiceId,
      optionId: lemonId,
    });
    expect(
      canSelectChoiceOption({
        pending,
        optionId: vanillaId,
        attempted,
      }),
    ).toBe(false);
    expect(
      canSelectChoiceOption({
        pending,
        optionId: lemonId,
        attempted,
      }),
    ).toBe(true);
  });

  it("retries the same option and can complete the committed order once", async () => {
    const pending = pendingChoiceFromMessages(messages, new Set());
    const postChoice = vi
      .fn()
      .mockResolvedValueOnce(uncertain)
      .mockResolvedValueOnce({
        status: "completed",
        text: "Order #1049.",
        entity: {
          orderId: "0f0e2d5c-4a1b-4c3d-9e8f-102938475601",
          orderNumber: "1049",
        },
      });
    const resolvingRef = { current: null as string | null };
    const first = await executeChoiceSelect({
      pending,
      optionId: lemonId,
      resolvingRef,
      postChoice,
    });
    const attempted = choiceSelectRememberedAttempt({
      result: first,
      challengeId: choiceId,
      optionId: lemonId,
      previous: null,
    });
    resolvingRef.current = null;
    const second = await executeChoiceSelect({
      pending,
      optionId: lemonId,
      resolvingRef,
      attempted,
      postChoice,
    });
    expect(second).toMatchObject({ status: "completed" });
    expect(postChoice).toHaveBeenCalledTimes(2);
    expect(
      choiceSelectRememberedAttempt({
        result: second,
        challengeId: choiceId,
        optionId: lemonId,
        previous: attempted,
      }),
    ).toBeNull();
  });

  it("allows a different option after reload when peek still shows needs_choice", () => {
    const pending = pendingChoiceFromMessages(messages, new Set());
    expect(pending?.status).toBe("needs_choice");
    expect(
      canSelectChoiceOption({
        pending,
        optionId: vanillaId,
        attempted: null,
      }),
    ).toBe(true);
  });

  it("keeps claimed peek restoration limited to the claimed option", () => {
    const claimed: StaffAssistantChoiceCardEnvelope = {
      ...envelope,
      status: "claimed",
      claimedOptionId: lemonId,
    };
    const pending = pendingChoiceFromMessages(
      [assistantChoiceMessage("a1", claimed)],
      new Set(),
    );
    expect(
      canSelectChoiceOption({
        pending,
        optionId: vanillaId,
        attempted: { challengeId: choiceId, optionId: lemonId },
      }),
    ).toBe(false);
    expect(
      canSelectChoiceOption({
        pending,
        optionId: lemonId,
        attempted: { challengeId: choiceId, optionId: lemonId },
      }),
    ).toBe(true);
  });

  it("clears the attempted option on reset so a later picker is not locked", () => {
    const attempted = {
      challengeId: choiceId,
      optionId: lemonId,
    };
    expect(
      canSelectChoiceOption({
        pending: pendingChoiceFromMessages(messages, new Set()),
        optionId: vanillaId,
        attempted,
      }),
    ).toBe(false);
    expect(
      canSelectChoiceOption({
        pending: pendingChoiceFromMessages(messages, new Set()),
        optionId: vanillaId,
        attempted: null,
      }),
    ).toBe(true);
  });

  it("does not offer the other options after an uncertain POST of A", () => {
    const attempted = {
      challengeId: choiceId,
      optionId: lemonId,
    };
    expect(
      choiceCardOfferedOptions({
        choice: envelope,
        attempted,
      }).map((option) => option.id),
    ).toEqual([lemonId]);
    expect(
      choiceCardRetryOptionId({
        choice: envelope,
        attempted,
      }),
    ).toBe(lemonId);
    expect(
      choiceCardOfferedOptions({
        choice: envelope,
        attempted: null,
      }).map((option) => option.id),
    ).toEqual([lemonId, vanillaId]);
    expect(
      choiceCardOfferedOptions({
        choice: envelope,
        attempted,
      }).some((option) => option.id === vanillaId),
    ).toBe(false);
  });

  it("does not clear the remembered A attempt when skipped B is assigned", () => {
    const rememberedA = {
      challengeId: choiceId,
      optionId: lemonId,
    };
    expect(
      choiceSelectRememberedAttempt({
        result: "skipped",
        challengeId: choiceId,
        optionId: vanillaId,
        previous: rememberedA,
      }),
    ).toBe(rememberedA);
    expect(
      choiceSelectRememberedAttempt({
        result: "skipped",
        challengeId: choiceId,
        optionId: vanillaId,
        previous: null,
      }),
    ).toBeNull();
  });
});
