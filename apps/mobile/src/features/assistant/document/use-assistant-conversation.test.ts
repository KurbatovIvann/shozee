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
    olderCursor: null,
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

/**
 * Distinct per call, so a test can see whether a retry reused a token or minted
 * a new one. A fixed id would make the whole of SHO-547 untestable from here.
 */
let minted = 0;
function nextId(): string {
  minted += 1;
  return `22222222-2222-4222-8222-${String(minted).padStart(12, "0")}`;
}

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
    newId: nextId,
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
  const render = (conversationId: string | null) => {
    act(() => {
      root.render(
        createElement(Probe, { latest, conversationId, tenantEpochRef }),
      );
    });
  };
  render(
    options?.conversationId === undefined
      ? CONVERSATION
      : options.conversationId,
  );
  return {
    tenantEpochRef,
    /**
     * What the sheet does when the company changes: a new epoch during render,
     * then the identity hook resolves the other company's conversation.
     */
    switchCompany: (conversationId: string) => {
      tenantEpochRef.current += 1;
      render(conversationId);
    },
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
  minted = 0;
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
      void view.latest().send("щось інше");
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

  /**
   * SHO-550. A send refused because a question is still open — possibly one
   * asked on another device, which this screen had not seen. The refusal's
   * document brings the question in, and the failure is what the sheet uses
   * both to put the draft back and to say why.
   */
  it("reports a send refused by an open question, and shows that question", async () => {
    respond(200, { status: "ok", document: document() });
    const view = mount();
    await flush();

    respond(409, {
      status: "interaction_open",
      document: document({ openPause: OPEN_PAUSE, asked: true }),
    });
    let refused: unknown = null;
    await act(async () => {
      refused = await view.latest().send("створи ще одне");
    });

    expect(refused).toEqual({
      kind: "refused",
      failure: { kind: "interaction_open" },
    });
    expect(view.latest().failure?.kind).toBe("interaction_open");
    expect(view.latest().interaction?.interactionId).toBe(INTERACTION);
    // Nothing was stored, so the echo of the words does not stay behind.
    expect(view.latest().rows.some((row) => row.role === "user")).toBe(false);
  });

  it("keeps what it is showing when the network fails", async () => {
    respond(200, { status: "ok", document: document({ text: "Привіт." }) });
    const view = mount();
    await flush();

    fetchMock.mockRejectedValueOnce(new Error("offline"));
    act(() => {
      void view.latest().send("ще одне");
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
      void view.latest().send("ще одне");
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

  /**
   * The complaint this fixes: the person's message was invisible for the whole
   * turn, so their words and the reply appeared together at the end and it read
   * as though the app had dropped what they typed.
   */
  it("shows the sent message straight away, above the waiting row", async () => {
    respond(200, { status: "ok", document: document({ text: "Привіт." }) });
    const view = mount();
    await flush();

    hang();
    act(() => {
      void view.latest().send("ще одне");
    });
    await flush();

    const rows = view.latest().rows;
    expect(rows.map((row) => [row.role, row.text])).toEqual([
      ["assistant", "Привіт."],
      ["user", "ще одне"],
      ["assistant", ""],
    ]);
    expect(rows.at(-1)?.waiting).toBe(true);
  });

  it("replaces the echo with the stored message rather than showing both", async () => {
    respond(200, { status: "ok", document: document({ text: "Привіт." }) });
    const view = mount();
    await flush();

    respond(200, {
      status: "ok",
      document: {
        ...document({ text: "Готово." }),
        messages: [
          {
            messageId: "55555555-5555-4555-8555-555555555555",
            role: "user",
            createdAt: "2026-09-09T10:01:00.000Z",
            parts: [{ kind: "text", text: "ще одне", status: "complete" }],
          },
          ...document({ text: "Готово." }).messages,
        ],
      },
    });
    act(() => {
      void view.latest().send("ще одне");
    });
    await flush();

    expect(view.latest().rows.map((row) => [row.role, row.text])).toEqual([
      ["user", "ще одне"],
      ["assistant", "Готово."],
    ]);
  });

  it("sends nothing for blank text", async () => {
    respond(200, { status: "ok", document: document() });
    const view = mount();
    await flush();

    act(() => {
      void view.latest().send("   ");
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

    // The server answers with the conversation, like every other route.
    respond(200, { status: "abandoned", document: document({ asked: true }) });
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
    // And the card stops rendering. Asserting only the request is what let a
    // cancel that changed nothing on screen ship.
    expect(view.latest().interaction).toBeNull();
    expect(view.latest().rows.every((row) => row.interaction === null)).toBe(
      true,
    );
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

/**
 * SHO-552. The company changes while a send is in flight, and then that send
 * fails. Its reply belongs to a thread nobody is looking at, so nothing it says
 * may land on the one that is. The document has been guarded against that since
 * this hook was written; the draft and the echo were settled after it, outside
 * the guard, and a failed send put company A's words in company B's composer.
 */
describe("a send still in flight when the company changes", () => {
  const OTHER_CONVERSATION = "66666666-6666-4666-8666-666666666666";

  /** A send that fails only when told to. */
  function failLater(): () => void {
    const pending: { reject: ((reason: Error) => void) | null } = {
      reject: null,
    };
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((_resolve, reject) => {
          pending.reject = reject;
        }),
    );
    return () => {
      pending.reject?.(new Error("network is gone"));
    };
  }

  function loadedInCompanyA() {
    respond(200, { status: "ok", document: document({ text: "Компанія A." }) });
    return mount();
  }

  it("comes back superseded, so the draft has nowhere to go back to", async () => {
    const view = loadedInCompanyA();
    await flush();

    const fail = failLater();
    const sent: { outcome?: ReturnType<UseAssistantConversation["send"]> } = {};
    act(() => {
      sent.outcome = view.latest().send("замовлення для Каті");
    });
    await flush();

    respond(200, { status: "ok", document: document({ text: "Компанія B." }) });
    view.switchCompany(OTHER_CONVERSATION);
    await flush();

    fail();
    await flush();

    expect(await sent.outcome).toEqual({ kind: "superseded" });
    // Nor does company B's screen report company A's failure.
    expect(view.latest().failure).toBeNull();
    expect(view.latest().rows.map((row) => row.text)).toEqual(["Компанія B."]);
  });

  it("leaves the echo of a send made after the switch where it is", async () => {
    const view = loadedInCompanyA();
    await flush();

    const fail = failLater();
    act(() => {
      void view.latest().send("замовлення для Каті");
    });
    await flush();

    respond(200, { status: "ok", document: document({ text: "Компанія B." }) });
    view.switchCompany(OTHER_CONVERSATION);
    await flush();

    hang();
    act(() => {
      void view.latest().send("а тут інше");
    });
    await flush();

    fail();
    await flush();

    expect(view.latest().rows.map((row) => [row.role, row.text])).toEqual([
      ["assistant", "Компанія B."],
      ["user", "а тут інше"],
      ["assistant", ""],
    ]);
  });
});

/**
 * SHO-547. A request that never came back may or may not have created the
 * order, and the draft goes straight back into the field — so the person is
 * invited to send it again.
 *
 * The token is what decides whether that second send is the same attempt. Held
 * across the one outcome where the client cannot know (`unreachable`), and
 * dropped for every outcome that is a reply, because those mean the request
 * arrived and was decided.
 */
describe("retrying a command whose reply never came", () => {
  /** Mounted with its conversation already loaded, as every tap here assumes. */
  function loaded(options?: { readonly open?: boolean }) {
    respond(200, {
      status: "ok",
      document:
        options?.open === true
          ? document({ openPause: OPEN_PAUSE, asked: true })
          : document(),
    });
    return mount();
  }

  it("sends the same command token, so the server can replay it", async () => {
    const view = loaded();
    await flush();

    fetchMock.mockRejectedValueOnce(new Error("network is gone"));
    await act(async () => {
      await view.latest().send("створи замовлення");
    });

    respond(200, { status: "ok", document: document({ text: "Готово." }) });
    await act(async () => {
      await view.latest().send("створи замовлення");
    });

    expect(sentBody(2).commandId).toBe(sentBody(1).commandId);
  });

  /**
   * The interaction between the two guards, and the one that would have been
   * silent. A retry refused by the turn lease did nothing, so the *first*
   * attempt's fate is still unknown — minting a new token here would miss the
   * receipt and write the order a second time (SHO-548 meeting SHO-547).
   */
  it("keeps the token when the retry is refused by a running turn", async () => {
    const view = loaded();
    await flush();

    fetchMock.mockRejectedValueOnce(new Error("network is gone"));
    await act(async () => {
      await view.latest().send("створи замовлення");
    });

    respond(409, { status: "turn_open", document: document() });
    await act(async () => {
      await view.latest().send("створи замовлення");
    });

    respond(200, { status: "ok", document: document({ text: "Готово." }) });
    await act(async () => {
      await view.latest().send("створи замовлення");
    });

    expect(sentBody(3).commandId).toBe(sentBody(1).commandId);
  });

  it("mints a new one once the draft has been edited", async () => {
    const view = loaded();
    await flush();

    fetchMock.mockRejectedValueOnce(new Error("network is gone"));
    await act(async () => {
      await view.latest().send("створи замовлення");
    });

    respond(200, { status: "ok", document: document({ text: "Готово." }) });
    await act(async () => {
      await view.latest().send("створи замовлення на завтра");
    });

    expect(sentBody(2).commandId).not.toBe(sentBody(1).commandId);
  });

  /**
   * The negative, and the reason the token is not simply the text: a person who
   * sends the same sentence twice on purpose wants it to happen twice.
   */
  it("mints a new one after a send that was answered", async () => {
    const view = loaded();
    await flush();

    respond(200, { status: "ok", document: document({ text: "Готово." }) });
    await act(async () => {
      await view.latest().send("створи замовлення");
    });

    respond(200, { status: "ok", document: document({ text: "Ще раз." }) });
    await act(async () => {
      await view.latest().send("створи замовлення");
    });

    expect(sentBody(2).commandId).not.toBe(sentBody(1).commandId);
  });

  it("reuses the token when the same option is tapped again", async () => {
    const view = loaded({ open: true });
    await flush();

    fetchMock.mockRejectedValueOnce(new Error("network is gone"));
    await act(async () => {
      view.latest().answer({ optionId: "opt-b" });
      await flush();
    });

    respond(200, { status: "ok", document: document({ text: "Готово." }) });
    await act(async () => {
      view.latest().answer({ optionId: "opt-b" });
      await flush();
    });

    expect(sentBody(2).commandId).toBe(sentBody(1).commandId);
  });

  it("mints a new one when a different option is tapped", async () => {
    const view = loaded({ open: true });
    await flush();

    fetchMock.mockRejectedValueOnce(new Error("network is gone"));
    await act(async () => {
      view.latest().answer({ optionId: "opt-b" });
      await flush();
    });

    respond(200, { status: "ok", document: document({ text: "Готово." }) });
    await act(async () => {
      view.latest().answer({ optionId: "opt-a" });
      await flush();
    });

    expect(sentBody(2).commandId).not.toBe(sentBody(1).commandId);
  });
});
