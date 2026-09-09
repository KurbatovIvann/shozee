/**
 * The hook that replaced three.
 *
 * Most of these are the defects the old hooks carried state for. An answered
 * question disappearing with no local bookkeeping; a second tap that cannot
 * double-post; a refusal that both reports itself and corrects the card; a
 * company switch mid-request that must not paint the wrong tenant's thread.
 * Each of those used to need a Set, a ref, or both.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import "../../../auth/react-test-dom";

const fetchMock = vi.fn();

vi.mock("expo/fetch", () => ({
  fetch: (...args: unknown[]) => fetchMock(...args) as Promise<Response>,
}));

import {
  useAssistantConversation,
  type AssistantTenantEpochRef,
  type UseAssistantConversation,
} from "./use-assistant-conversation";

const CONVERSATION = "11111111-1111-4111-8111-111111111111";
const INTERACTION = "33333333-3333-4333-8333-333333333333";
const MESSAGE = "44444444-4444-4444-8444-444444444444";

/** Reads a request body without stringifying an object by accident. */
function sentBody(index: number): Record<string, unknown> {
  const call = fetchMock.mock.calls[index] as
    [string, { readonly body?: unknown }] | undefined;
  const body = call?.[1].body;
  return JSON.parse(typeof body === "string" ? body : "{}") as Record<
    string,
    unknown
  >;
}

const OPEN_PAUSE = {
  kind: "choice",
  interactionId: INTERACTION,
  revision: 2,
  status: "open",
  prompt: {
    subject: "Катя",
    options: [
      { optionId: "opt-a", label: "Катя Самбука" },
      { optionId: "opt-b", label: "Катя Іванова" },
    ],
    optionsTruncated: false,
  },
  expiresAt: "2026-09-09T10:15:00.000Z",
};

function document(options?: {
  readonly text?: string;
  readonly openPause?: unknown;
  readonly asked?: boolean;
}) {
  const parts: unknown[] = [
    { kind: "text", text: options?.text ?? "Яку Катю?", status: "complete" },
  ];
  if (options?.asked === true) {
    parts.push({
      kind: "interaction",
      interactionId: INTERACTION,
      revision: 2,
      pause: OPEN_PAUSE,
    });
  }
  return {
    conversationId: CONVERSATION,
    bind: "user-1:company-a",
    messages: [
      {
        messageId: MESSAGE,
        role: "assistant",
        createdAt: "2026-09-09T10:00:00.000Z",
        parts,
      },
    ],
    openPause: options?.openPause ?? null,
  };
}

function respond(status: number, body: unknown): void {
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

/** Never settles. Used to observe the in-flight state. */
function hang(): void {
  fetchMock.mockImplementationOnce(
    () => new Promise<Response>(() => undefined),
  );
}

const CALL = {
  apiUrl: "https://api.example.com",
  getCookie: () => "cookie",
  getCompanyId: () => "company-a",
};

type Latest = { current: UseAssistantConversation | null };

function Probe(props: {
  readonly latest: Latest;
  readonly conversationId: string | null;
  readonly tenantEpochRef: AssistantTenantEpochRef;
}) {
  props.latest.current = useAssistantConversation({
    conversationId: props.conversationId,
    locale: "uk",
    call: CALL,
    tenantEpochRef: props.tenantEpochRef,
    newId: () => "22222222-2222-4222-8222-222222222222",
  });
  return null;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

let roots: Root[] = [];

function mount(options?: { readonly conversationId?: string | null }) {
  const latest: Latest = { current: null };
  const tenantEpochRef: AssistantTenantEpochRef = { current: 0 };
  const container = globalThis.document.createElement("div");
  const root = createRoot(container);
  roots.push(root);
  const conversationId =
    options?.conversationId === undefined
      ? CONVERSATION
      : options.conversationId;
  act(() => {
    root.render(
      createElement(Probe, { latest, conversationId, tenantEpochRef }),
    );
  });
  return {
    tenantEpochRef,
    latest: () => {
      const value = latest.current;
      if (value === null) {
        throw new Error("hook probe did not mount");
      }
      return value;
    },
  };
}

beforeEach(() => {
  fetchMock.mockReset();
});

afterEach(() => {
  for (const root of roots) {
    act(() => {
      root.unmount();
    });
  }
  roots = [];
});

describe("useAssistantConversation", () => {
  it("reads the conversation on mount", async () => {
    respond(200, { status: "ok", document: document({ text: "Привіт." }) });
    const view = mount();

    await flush();

    expect(view.latest().rows.map((row) => row.text)).toEqual(["Привіт."]);
    expect(view.latest().busy).toBe(false);
    expect(view.latest().failure).toBeNull();
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain("/assistant/kit/messages");
  });

  it("does not call anything without a conversation", async () => {
    const view = mount({ conversationId: null });

    await flush();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(view.latest().rows).toEqual([]);
  });

  it("exposes the open question, parsed", async () => {
    respond(200, {
      status: "ok",
      document: document({ openPause: OPEN_PAUSE, asked: true }),
    });
    const view = mount();

    await flush();

    expect(view.latest().interaction).toEqual({
      kind: "choice",
      interactionId: INTERACTION,
      revision: 2,
      subject: "Катя",
      options: [
        { optionId: "opt-a", label: "Катя Самбука" },
        { optionId: "opt-b", label: "Катя Іванова" },
      ],
      optionsTruncated: false,
    });
    // Attached to the message that asked it, so the card renders in place.
    expect(view.latest().rows[0]?.interaction).not.toBeNull();
  });

  /**
   * The behaviour six commits of the old path were spent chasing. Nothing here
   * remembers that `INTERACTION` was answered — the answer removed it from the
   * document, and that is the whole mechanism.
   */
  it("leaves no answerable question once it is answered", async () => {
    respond(200, {
      status: "ok",
      document: document({ openPause: OPEN_PAUSE, asked: true }),
    });
    const view = mount();
    await flush();

    respond(200, {
      status: "ok",
      document: document({ text: "Готово.", asked: true }),
    });
    act(() => {
      view.latest().answer({ optionId: "opt-a" });
    });
    await flush();

    expect(view.latest().interaction).toBeNull();
    expect(view.latest().rows.every((row) => row.interaction === null)).toBe(
      true,
    );
    expect(sentBody(1)).toMatchObject({
      interactionId: INTERACTION,
      revision: 2,
      answer: { optionId: "opt-a" },
    });
  });

  it("sends the revision that is open now, not one captured earlier", async () => {
    respond(200, {
      status: "ok",
      document: document({
        openPause: { ...OPEN_PAUSE, revision: 7 },
        asked: true,
      }),
    });
    const view = mount();
    await flush();

    respond(200, { status: "ok", document: document() });
    act(() => {
      view.latest().answer({ optionId: "opt-a" });
    });
    await flush();

    expect(sentBody(1).revision).toBe(7);
  });

  /**
   * The old hook kept an `attempted` `(challenge, option)` pair so a second tap
   * on a different option could not post while the first might already be
   * claimed. One in-flight flag replaces it, because exactly-once is the
   * server's answer now, not a guess made here.
   */
  it("refuses a second request while one is in flight", async () => {
    respond(200, {
      status: "ok",
      document: document({ openPause: OPEN_PAUSE, asked: true }),
    });
    const view = mount();
    await flush();

    hang();
    act(() => {
      view.latest().answer({ optionId: "opt-a" });
    });
    await flush();
    expect(view.latest().busy).toBe(true);

    act(() => {
      view.latest().answer({ optionId: "opt-b" });
      view.latest().send("щось інше");
      view.latest().dismiss();
    });
    await flush();

    // One read on mount, one answer. Nothing else got out.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("applies a refusal's document and reports the refusal", async () => {
    respond(200, {
      status: "ok",
      document: document({ openPause: OPEN_PAUSE, asked: true }),
    });
    const view = mount();
    await flush();

    respond(409, {
      status: "stale",
      document: document({
        openPause: { ...OPEN_PAUSE, revision: 9 },
        asked: true,
      }),
    });
    act(() => {
      view.latest().answer({ optionId: "opt-a" });
    });
    await flush();

    expect(view.latest().failure?.kind).toBe("stale");
    // The card stays, at the version that is actually open.
    expect(view.latest().interaction?.revision).toBe(9);
  });

  it("keeps what it is showing when the network fails", async () => {
    respond(200, { status: "ok", document: document({ text: "Привіт." }) });
    const view = mount();
    await flush();

    fetchMock.mockRejectedValueOnce(new Error("offline"));
    act(() => {
      view.latest().send("ще одне");
    });
    await flush();

    expect(view.latest().failure?.kind).toBe("unreachable");
    expect(view.latest().rows.map((row) => row.text)).toEqual(["Привіт."]);
    expect(view.latest().busy).toBe(false);
  });

  it("drops a reply that arrives after the tenant changed", async () => {
    respond(200, { status: "ok", document: document({ text: "Привіт." }) });
    const view = mount();
    await flush();

    let settle: ((response: Response) => void) | null = null;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          settle = resolve;
        }),
    );
    act(() => {
      view.latest().send("ще одне");
    });
    await flush();

    view.tenantEpochRef.current += 1;
    act(() => {
      settle?.(
        new Response(
          JSON.stringify({
            status: "ok",
            document: document({ text: "ІНША КОМПАНІЯ" }),
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    });
    await flush();

    expect(view.latest().rows.map((row) => row.text)).toEqual(["Привіт."]);
  });

  it("shows a waiting row while a turn is running, hiding nothing", async () => {
    respond(200, { status: "ok", document: document({ text: "Привіт." }) });
    const view = mount();
    await flush();

    hang();
    act(() => {
      view.latest().send("ще одне");
    });
    await flush();

    const rows = view.latest().rows;
    expect(rows.map((row) => row.text)).toEqual(["Привіт.", ""]);
    expect(rows.at(-1)?.waiting).toBe(true);
  });

  it("sends nothing for blank text", async () => {
    respond(200, { status: "ok", document: document() });
    const view = mount();
    await flush();

    act(() => {
      view.latest().send("   ");
    });
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("dismisses the open question without a revision", async () => {
    respond(200, {
      status: "ok",
      document: document({ openPause: OPEN_PAUSE, asked: true }),
    });
    const view = mount();
    await flush();

    respond(200, { status: "abandoned" });
    act(() => {
      view.latest().dismiss();
    });
    await flush();

    const [url] = fetchMock.mock.calls[1] as [string];
    expect(url).toContain("/assistant/kit/abandon");
    expect(sentBody(1)).toEqual({
      conversationId: CONVERSATION,
      interactionId: INTERACTION,
    });
  });

  it("does nothing when asked to answer with no question open", async () => {
    respond(200, { status: "ok", document: document() });
    const view = mount();
    await flush();

    act(() => {
      view.latest().answer({ optionId: "opt-a" });
      view.latest().dismiss();
    });
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
