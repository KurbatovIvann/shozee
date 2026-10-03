import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AssistantInteraction } from "@showzy/validation/assistant-chat";

import "../../../auth/react-test-dom";
import { assistantChoiceAnswer } from "../shared/choice-answer";
import type {
  AssistantSendOutcome,
  UseAssistantConversation,
} from "../thread/use-assistant-conversation";

const CONVERSATION = "11111111-1111-4111-8111-111111111111";
const INTERACTION = "33333333-3333-4333-8333-333333333333";

function openChoice(revision: number): AssistantInteraction {
  return {
    kind: "choice",
    interactionId: INTERACTION,
    revision,
    subject: "Катя",
    options: [
      { kind: "record", optionId: "opt-a", label: "Катя Самбука" },
      { kind: "record", optionId: "opt-b", label: "Катя Іванова" },
    ],
    optionsTruncated: false,
    nearest: false,
    problem: undefined,
  };
}

const answered: unknown[] = [];
const sentTexts: string[] = [];
let sendOutcome: AssistantSendOutcome = {
  kind: "sent",
  messageId: "message-1",
};
let settleAnswer: (() => void) | null = null;
let interaction: AssistantInteraction | null = openChoice(2);

const conversation: UseAssistantConversation = {
  rows: [],
  get interaction() {
    return interaction;
  },
  busy: false,
  sending: false,
  failure: null,
  send: (text: string) => {
    sentTexts.push(text);
    return Promise.resolve(sendOutcome);
  },
  answer: (value: unknown) => {
    answered.push(value);
    return new Promise<void>((resolve) => {
      settleAnswer = resolve;
    });
  },
  dismiss: () => undefined,
  continueTurn: () => undefined,
  loadingOlder: false,
  loadOlder: () => undefined,
};

vi.mock("expo-audio", () => ({
  requestRecordingPermissionsAsync: () => Promise.resolve({ granted: false }),
  setAudioModeAsync: () => Promise.resolve(),
  useAudioStream: () => ({
    isStreaming: false,
    stream: { start: () => Promise.resolve(), stop: () => undefined },
  }),
}));

vi.mock("expo/fetch", () => ({
  fetch: () => Promise.reject(new Error("no request belongs to this test")),
}));

vi.mock("expo-router", () => ({
  useRouter: () => ({ push: () => undefined }),
}));

vi.mock("../../../api/config", () => ({
  apiUrlFromEnv: () => "https://api.example.com",
}));

vi.mock("../../../api/api-provider", () => ({
  useApiClient: () => ({
    client: {
      assistant: {
        listConversations: () => Promise.resolve({ conversations: [] }),
        createConversation: () => Promise.resolve({ conversationId: "c" }),
      },
    },
  }),
}));

vi.mock("../../../api/query-provider", () => ({
  useActiveCompany: () => ({ activeCompanyId: "company-a" }),
}));

vi.mock("../../../auth/session-provider", () => ({
  useAuthSession: () => ({
    session: { userId: "user-a" },
    getCookie: () => "cookie",
  }),
}));

vi.mock("../thread/use-assistant-conversation-id", () => ({
  useAssistantConversationId: () => ({
    conversationId: CONVERSATION,
    resolving: false,
    failed: false,
  }),
}));

vi.mock("../thread/use-assistant-conversation", () => ({
  useAssistantConversation: () => conversation,
}));

import { useAssistantSheet } from "./use-assistant-sheet";

type Model = ReturnType<typeof useAssistantSheet>;
type Latest = { current: Model | null };

function Probe(props: { readonly latest: Latest }) {
  props.latest.current = useAssistantSheet();
  return null;
}

let roots: Root[] = [];

function mount() {
  const latest: Latest = { current: null };
  const container = globalThis.document.createElement("div");
  const root = createRoot(container);
  roots.push(root);
  const render = () => {
    act(() => {
      root.render(createElement(Probe, { latest }));
    });
  };
  render();
  return {
    render,
    latest: () => {
      const value = latest.current;
      if (value === null) {
        throw new Error("hook probe did not mount");
      }
      return value;
    },
  };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function tap(view: ReturnType<typeof mount>, optionId: string): void {
  act(() => {
    view.latest().answer(assistantChoiceAnswer(optionId));
  });
}

async function settleInFlight(): Promise<void> {
  const resolve = settleAnswer;
  settleAnswer = null;
  if (resolve === null) {
    throw new Error("no answer in flight");
  }
  resolve();
  await flush();
}

beforeEach(() => {
  answered.length = 0;
  sentTexts.length = 0;
  sendOutcome = { kind: "sent", messageId: "message-1" };
  settleAnswer = null;
  interaction = openChoice(2);
});

afterEach(() => {
  for (const root of roots) {
    act(() => {
      root.unmount();
    });
  }
  roots = [];
});

describe("the chosen option the sheet marks", () => {
  it("lets a dropped reply be retried with the same option", async () => {
    const view = mount();
    expect(view.latest().pendingOptionId).toBeNull();

    tap(view, "opt-a");
    expect(view.latest().pendingOptionId).toBe("opt-a");

    await settleInFlight();
    expect(view.latest().pendingOptionId).toBeNull();

    tap(view, "opt-a");

    expect(answered).toEqual([{ optionId: "opt-a" }, { optionId: "opt-a" }]);
    expect(view.latest().pendingOptionId).toBe("opt-a");
  });

  it("drops the mark when the answer lands and the question moves on", async () => {
    const view = mount();

    tap(view, "opt-a");
    expect(view.latest().pendingOptionId).toBe("opt-a");

    interaction = openChoice(3);
    view.render();
    expect(view.latest().pendingOptionId).toBeNull();

    await settleInFlight();
    expect(view.latest().pendingOptionId).toBeNull();
  });

  it("keeps the newest mark when an earlier request settles late", async () => {
    const view = mount();

    tap(view, "opt-a");
    const first = settleAnswer;
    settleAnswer = null;

    tap(view, "opt-b");
    expect(view.latest().pendingOptionId).toBe("opt-b");

    first?.();
    await flush();

    expect(view.latest().pendingOptionId).toBe("opt-b");
  });

  it("puts a refused dictation back in the composer", async () => {
    sendOutcome = { kind: "refused", failure: { kind: "not_sent" } };
    const view = mount();

    act(() => {
      view.latest().sendExample("дві пачки");
    });
    await flush();

    expect(sentTexts).toEqual(["дві пачки"]);
    expect(view.latest().input).toBe("дві пачки");
  });

  it("leaves a draft the person started alone when a send is refused", async () => {
    sendOutcome = { kind: "refused", failure: { kind: "not_sent" } };
    const view = mount();

    act(() => {
      view.latest().sendExample("дві пачки");
    });
    act(() => {
      view.latest().changeInput("три пачки");
    });
    await flush();

    expect(view.latest().input).toBe("три пачки");
  });
});
