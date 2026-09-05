import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import "../../../auth/react-test-dom";
import type {
  AssistantChoiceMessage,
  ChoiceAppendPart,
  ChoiceSelectResult,
} from "../shared/choice-presenter";
import { useAssistantChoice } from "./use-assistant-choice";

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
};

function Probe(props: ProbeProps) {
  props.latest.current = useAssistantChoice({
    messages: props.messages,
    locale: "en",
    companyEpochRef: props.companyEpochRef,
    postChoice: props.postChoice,
    appendParts: props.appendParts,
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
    act(() => {
      mounted.latest().select(vanillaId);
    });
    await flush();
    expect(postChoice).toHaveBeenCalledOnce();
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
});
