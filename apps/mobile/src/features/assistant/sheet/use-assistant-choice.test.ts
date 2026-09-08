import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import "../../../auth/react-test-dom";
import {
  choiceCardOfferedOptions,
  type AssistantChoiceMessage,
  type ChoiceAppendPart,
  type ChoiceSelectResult,
} from "../shared/choice-presenter";
import type { AssistantHostInteractionResult } from "../shared/resume-envelope";
import { useAssistantChoice } from "./use-assistant-choice";

const conversationId = "11111111-1111-4111-8111-111111111111";
const choiceId = "33333333-3333-4333-8333-333333333333";
const lemonId = "88888888-8888-4888-8888-888888888888";
const vanillaId = "99999999-9999-4999-8999-999999999999";

const messages: readonly AssistantChoiceMessage[] = [
  {
    id: "a1",
    role: "assistant",
    parts: [
      { type: "text", text: "Select a variant." },
      {
        type: "data-choice",
        data: {
          status: "needs_choice",
          challengeId: choiceId,
          reason: "variant_required",
          productName: "Macarons",
          options: [
            { id: lemonId, label: "Lemon" },
            { id: vanillaId, label: "Vanilla" },
          ],
          optionsTruncated: false,
        },
      },
    ],
  },
];

type HookLatest = ReturnType<typeof useAssistantChoice>;

type ProbeProps = {
  readonly latest: { current: HookLatest | null };
  readonly messages: readonly AssistantChoiceMessage[];
  readonly postChoice: (input: {
    readonly choiceId: string;
    readonly optionId: string;
  }) => Promise<ChoiceSelectResult>;
  readonly appendParts: (parts: readonly ChoiceAppendPart[]) => void;
  readonly companyEpochRef: { current: number };
  readonly getConversationId: () => string | null;
  readonly peekPending: () => Promise<
    | {
        readonly kind: "ok";
        readonly pending: {
          readonly id: string;
          readonly version: number;
          readonly kind: "choice" | "confirmation";
        } | null;
      }
    | { readonly kind: "unavailable" }
  >;
  readonly postAbandon: (input: {
    readonly conversationId: string;
    readonly pendingId: string;
    readonly expectedVersion: number;
  }) => Promise<AssistantHostInteractionResult>;
};

function Probe(props: ProbeProps) {
  props.latest.current = useAssistantChoice({
    messages: props.messages,
    locale: "en",
    companyEpochRef: props.companyEpochRef,
    postChoice: props.postChoice,
    appendParts: props.appendParts,
    getConversationId: props.getConversationId,
    peekPending: props.peekPending,
    postAbandon: props.postAbandon,
  });
  return null;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function mount(env: {
  readonly postChoice: ProbeProps["postChoice"];
  readonly appendParts?: ProbeProps["appendParts"];
  readonly getConversationId?: ProbeProps["getConversationId"];
  readonly peekPending?: ProbeProps["peekPending"];
  readonly postAbandon?: ProbeProps["postAbandon"];
}): {
  latest: () => HookLatest;
  unmount: () => void;
} {
  const latest: { current: HookLatest | null } = { current: null };
  const container = globalThis.document.createElement("div");
  const root: Root = createRoot(container);
  const companyEpochRef = { current: 0 };
  act(() => {
    root.render(
      createElement(Probe, {
        latest,
        messages,
        postChoice: env.postChoice,
        appendParts: env.appendParts ?? (() => undefined),
        companyEpochRef,
        getConversationId: env.getConversationId ?? (() => conversationId),
        peekPending:
          env.peekPending ??
          (() => Promise.resolve({ kind: "unavailable" as const })),
        postAbandon:
          env.postAbandon ??
          (() =>
            Promise.resolve({
              status: "ok" as const,
              speech: "",
              cards: [],
              pending: null,
            })),
      }),
    );
  });
  return {
    latest: () => {
      const value = latest.current;
      if (value === null) {
        throw new Error("hook probe did not mount");
      }
      return value;
    },
    unmount: () => {
      act(() => {
        root.unmount();
      });
    },
  };
}

describe("useAssistantChoice attempted-option recovery (SHO-452)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not POST a different option after an uncertain result", async () => {
    const postChoice = vi.fn(() =>
      Promise.resolve({
        status: "error",
        httpStatus: 503,
        recoverability: "retryable" as const,
      }),
    );
    const mounted = mount({ postChoice });
    act(() => {
      mounted.latest().select(lemonId);
    });
    await flush();
    expect(postChoice).toHaveBeenCalledOnce();
    expect(postChoice).toHaveBeenCalledWith({
      choiceId,
      optionId: lemonId,
    });
    expect(mounted.latest().attempted).toEqual({
      challengeId: choiceId,
      optionId: lemonId,
    });
    const pending = mounted.latest().pending;
    if (pending === null) {
      throw new Error("expected pending needs_choice after uncertain POST");
    }
    expect(
      choiceCardOfferedOptions({
        choice: pending,
        attempted: mounted.latest().attempted,
      }).map((option) => option.id),
    ).toEqual([lemonId]);
    expect(
      choiceCardOfferedOptions({
        choice: pending,
        attempted: mounted.latest().attempted,
      }).some((option) => option.id === vanillaId),
    ).toBe(false);
    act(() => {
      mounted.latest().select(vanillaId);
    });
    await flush();
    expect(postChoice).toHaveBeenCalledOnce();
    expect(mounted.latest().attempted).toEqual({
      challengeId: choiceId,
      optionId: lemonId,
    });
    mounted.unmount();
  });

  it("retries the same option after the in-flight lock clears", async () => {
    const postChoice = vi
      .fn()
      .mockResolvedValueOnce({
        status: "error",
        httpStatus: 503,
        recoverability: "retryable" as const,
      })
      .mockResolvedValueOnce({
        status: "completed",
        text: "Order #1049.",
        entity: {
          orderId: "0f0e2d5c-4a1b-4c3d-9e8f-102938475601",
          orderNumber: "1049",
        },
      });
    const appendParts = vi.fn();
    const mounted = mount({ postChoice, appendParts });
    act(() => {
      mounted.latest().select(lemonId);
    });
    await flush();
    act(() => {
      mounted.latest().select(lemonId);
    });
    await flush();
    expect(postChoice).toHaveBeenCalledTimes(2);
    expect(postChoice).toHaveBeenNthCalledWith(2, {
      choiceId,
      optionId: lemonId,
    });
    expect(appendParts).toHaveBeenCalledOnce();
    expect(mounted.latest().ignoredChallengeIds.has(choiceId)).toBe(true);
    mounted.unmount();
  });

  it("retains the attempted option after a transport throw", async () => {
    const postChoice = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce({
        status: "error",
        httpStatus: 503,
        recoverability: "retryable" as const,
      });
    const mounted = mount({ postChoice });
    act(() => {
      mounted.latest().select(lemonId);
    });
    await flush();
    act(() => {
      mounted.latest().select(vanillaId);
    });
    await flush();
    expect(postChoice).toHaveBeenCalledOnce();
    act(() => {
      mounted.latest().select(lemonId);
    });
    await flush();
    expect(postChoice).toHaveBeenCalledTimes(2);
    mounted.unmount();
  });

  it("clears the attempted option on reset so a later tap can choose another option", async () => {
    const postChoice = vi.fn(() =>
      Promise.resolve({
        status: "error",
        httpStatus: 503,
        recoverability: "retryable" as const,
      }),
    );
    const mounted = mount({ postChoice });
    act(() => {
      mounted.latest().select(lemonId);
    });
    await flush();
    act(() => {
      mounted.latest().reset();
    });
    act(() => {
      mounted.latest().select(vanillaId);
    });
    await flush();
    expect(postChoice).toHaveBeenNthCalledWith(2, {
      choiceId,
      optionId: vanillaId,
    });
    mounted.unmount();
  });

  it("does not clear the remembered A attempt when a skipped B tap is assigned", async () => {
    const postChoice = vi.fn(() =>
      Promise.resolve({
        status: "error",
        httpStatus: 503,
        recoverability: "retryable" as const,
      }),
    );
    const mounted = mount({ postChoice });
    act(() => {
      mounted.latest().select(lemonId);
    });
    await flush();
    act(() => {
      mounted.latest().select(vanillaId);
    });
    await flush();
    expect(mounted.latest().attempted).toEqual({
      challengeId: choiceId,
      optionId: lemonId,
    });
    act(() => {
      mounted.latest().select(lemonId);
    });
    await flush();
    expect(postChoice).toHaveBeenCalledTimes(2);
    expect(postChoice).toHaveBeenNthCalledWith(2, {
      choiceId,
      optionId: lemonId,
    });
    mounted.unmount();
  });
});

describe("useAssistantChoice dismiss (SHO-524)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("POSTs abandon and hides only after ok", async () => {
    const postAbandon = vi.fn(() =>
      Promise.resolve({
        status: "ok" as const,
        speech: "",
        cards: [],
        pending: null,
      }),
    );
    const mounted = mount({
      postChoice: () =>
        Promise.resolve({
          status: "error",
          httpStatus: 503,
          recoverability: "retryable",
        }),
      peekPending: () =>
        Promise.resolve({
          kind: "ok" as const,
          pending: {
            id: choiceId,
            version: 1,
            kind: "choice" as const,
          },
        }),
      postAbandon,
    });
    expect(mounted.latest().card.kind).toBe("proposed");
    act(() => {
      mounted.latest().dismiss();
    });
    await flush();
    expect(postAbandon).toHaveBeenCalledWith({
      conversationId,
      pendingId: choiceId,
      expectedVersion: 1,
    });
    expect(mounted.latest().ignoredChallengeIds.has(choiceId)).toBe(true);
    expect(mounted.latest().card.kind).toBe("hidden");
    mounted.unmount();
  });

  it("keeps the picker when abandon peek is unavailable", async () => {
    const postAbandon = vi.fn();
    const mounted = mount({
      postChoice: () =>
        Promise.resolve({
          status: "error",
          httpStatus: 503,
          recoverability: "retryable",
        }),
      peekPending: () => Promise.resolve({ kind: "unavailable" }),
      postAbandon,
    });
    act(() => {
      mounted.latest().dismiss();
    });
    await flush();
    expect(postAbandon).not.toHaveBeenCalled();
    expect(mounted.latest().card.kind).toBe("proposed");
    expect(mounted.latest().ignoredChallengeIds.has(choiceId)).toBe(false);
    mounted.unmount();
  });
});
