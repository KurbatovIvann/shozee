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

function conversationWindow(options?: {
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
        revision: 1,
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
  readonly visible?: boolean;
}) {
  props.latest.current = useAssistantConversation({
    conversationId: props.conversationId,
    locale: "uk",
    call: CALL,
    tenantEpochRef: props.tenantEpochRef,
    ...(props.visible === undefined ? {} : { visible: props.visible }),
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

function mount(options?: {
  readonly conversationId?: string | null;
  /**
   * Off unless a test says otherwise, matching the hook's own default: a caller
   * that never says the surface is on screen gets no stream, so the fetch
   * counts below are the commands and nothing else.
   */
  readonly visible?: boolean;
}) {
  const latest: Latest = { current: null };
  const tenantEpochRef: AssistantTenantEpochRef = { current: 0 };
  const container = globalThis.document.createElement("div");
  const root = createRoot(container);
  roots.push(root);
  const render = (conversationId: string | null) => {
    act(() => {
      root.render(
        createElement(Probe, {
          latest,
          conversationId,
          tenantEpochRef,
          ...(options?.visible === undefined
            ? {}
            : { visible: options.visible }),
        }),
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
    respond(200, {
      status: "ok",
      window: conversationWindow({ text: "Привіт." }),
    });
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
      window: conversationWindow({ openPause: OPEN_PAUSE, asked: true }),
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
   * window, and that is the whole mechanism.
   */
  it("leaves no answerable question once it is answered", async () => {
    respond(200, {
      status: "ok",
      window: conversationWindow({ openPause: OPEN_PAUSE, asked: true }),
    });
    const view = mount();
    await flush();

    respond(200, {
      status: "ok",
      window: conversationWindow({ text: "Готово.", asked: true }),
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
      window: conversationWindow({
        openPause: { ...OPEN_PAUSE, revision: 7 },
        asked: true,
      }),
    });
    const view = mount();
    await flush();

    respond(200, { status: "ok", window: conversationWindow() });
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
      window: conversationWindow({ openPause: OPEN_PAUSE, asked: true }),
    });
    const view = mount();
    await flush();

    hang();
    act(() => {
      view.latest().answer({ optionId: "opt-a" });
    });
    await flush();
    // `sending`, not `busy`: this screen has a command in flight. `busy` is the
    // conversation's own answer and no turn has been accepted yet.
    expect(view.latest().sending).toBe(true);
    expect(view.latest().busy).toBe(false);

    act(() => {
      view.latest().answer({ optionId: "opt-b" });
      void view.latest().send("щось інше");
      view.latest().dismiss();
    });
    await flush();

    // One read on mount, one answer. Nothing else got out.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("applies a refusal's window and reports the refusal", async () => {
    respond(200, {
      status: "ok",
      window: conversationWindow({ openPause: OPEN_PAUSE, asked: true }),
    });
    const view = mount();
    await flush();

    respond(409, {
      status: "stale",
      window: conversationWindow({
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
   * window brings the question in, and the failure is what the sheet uses
   * both to put the draft back and to say why.
   */
  it("reports a send refused by an open question, and shows that question", async () => {
    respond(200, { status: "ok", window: conversationWindow() });
    const view = mount();
    await flush();

    respond(409, {
      status: "interaction_open",
      window: conversationWindow({ openPause: OPEN_PAUSE, asked: true }),
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

  /**
   * ADR-0039. The accept may have stored the message and queued the turn, so
   * the words are not taken off the screen and put back in an empty composer —
   * that is an invitation to send a message the server already has. They stay
   * as the echo, and the outcome says `unknown` rather than `refused`, which is
   * what stops the sheet restoring the draft.
   */
  it("keeps the words on screen when the network fails, and does not offer them back", async () => {
    respond(200, {
      status: "ok",
      window: conversationWindow({ text: "Привіт." }),
    });
    const view = mount();
    await flush();

    fetchMock.mockRejectedValueOnce(new Error("offline"));
    let outcome: unknown = null;
    await act(async () => {
      outcome = await view.latest().send("ще одне");
    });

    expect(outcome).toEqual({
      kind: "unknown",
      failure: { kind: "unreachable" },
    });
    expect(view.latest().failure?.kind).toBe("unreachable");
    expect(view.latest().rows.map((row) => row.text)).toEqual([
      "Привіт.",
      "ще одне",
    ]);
    // No turn was reported, so the conversation is not busy.
    expect(view.latest().busy).toBe(false);
    expect(view.latest().sending).toBe(false);
  });

  /**
   * The other side of the same rule: the server decided this attempt and
   * accepted nothing, so the words belong back in the composer.
   */
  it("offers the words back when the server refused the send", async () => {
    respond(200, { status: "ok", window: conversationWindow() });
    const view = mount();
    await flush();

    respond(409, {
      status: "interaction_open",
      window: conversationWindow({ openPause: OPEN_PAUSE, asked: true }),
    });
    let outcome: unknown = null;
    await act(async () => {
      outcome = await view.latest().send("створи ще одне");
    });

    expect(outcome).toEqual({
      kind: "refused",
      failure: { kind: "interaction_open" },
    });
  });

  it("drops a reply that arrives after the tenant changed", async () => {
    respond(200, {
      status: "ok",
      window: conversationWindow({ text: "Привіт." }),
    });
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
            window: conversationWindow({ text: "ІНША КОМПАНІЯ" }),
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
    respond(200, {
      status: "ok",
      window: conversationWindow({ text: "Привіт." }),
    });
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
    respond(200, {
      status: "ok",
      window: conversationWindow({ text: "Привіт." }),
    });
    const view = mount();
    await flush();

    respond(200, {
      status: "ok",
      window: {
        ...conversationWindow({ text: "Готово." }),
        messages: [
          {
            messageId: "55555555-5555-4555-8555-555555555555",
            role: "user",
            createdAt: "2026-09-09T10:01:00.000Z",
            parts: [{ kind: "text", text: "ще одне", status: "complete" }],
            revision: 1,
          },
          ...conversationWindow({ text: "Готово." }).messages,
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
    respond(200, { status: "ok", window: conversationWindow() });
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
      window: conversationWindow({ openPause: OPEN_PAUSE, asked: true }),
    });
    const view = mount();
    await flush();

    // The server answers with the conversation, like every other route.
    respond(200, {
      status: "abandoned",
      window: conversationWindow({ asked: true }),
    });
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
    respond(200, { status: "ok", window: conversationWindow() });
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
 * may land on the one that is. The thread has been guarded against that since
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
    respond(200, {
      status: "ok",
      window: conversationWindow({ text: "Компанія A." }),
    });
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

    respond(200, {
      status: "ok",
      window: conversationWindow({ text: "Компанія B." }),
    });
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

    respond(200, {
      status: "ok",
      window: conversationWindow({ text: "Компанія B." }),
    });
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
      window:
        options?.open === true
          ? conversationWindow({ openPause: OPEN_PAUSE, asked: true })
          : conversationWindow(),
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

    respond(200, {
      status: "ok",
      window: conversationWindow({ text: "Готово." }),
    });
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

    respond(409, { status: "turn_open", window: conversationWindow() });
    await act(async () => {
      await view.latest().send("створи замовлення");
    });

    respond(200, {
      status: "ok",
      window: conversationWindow({ text: "Готово." }),
    });
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

    respond(200, {
      status: "ok",
      window: conversationWindow({ text: "Готово." }),
    });
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

    respond(200, {
      status: "ok",
      window: conversationWindow({ text: "Готово." }),
    });
    await act(async () => {
      await view.latest().send("створи замовлення");
    });

    respond(200, {
      status: "ok",
      window: conversationWindow({ text: "Ще раз." }),
    });
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

    respond(200, {
      status: "ok",
      window: conversationWindow({ text: "Готово." }),
    });
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

    respond(200, {
      status: "ok",
      window: conversationWindow({ text: "Готово." }),
    });
    await act(async () => {
      view.latest().answer({ optionId: "opt-a" });
      await flush();
    });

    expect(sentBody(2).commandId).not.toBe(sentBody(1).commandId);
  });
});

/**
 * SHO-555. The server answers with a window, not the whole conversation, and
 * the hook joins windows into one thread. The window here is three messages: a
 * request adds at most two, so a reply always overlaps what is on screen — as it
 * does with the real thirty.
 */
describe("a conversation longer than one window", () => {
  function numbered(n: number) {
    return {
      messageId: `77777777-7777-4777-8777-${n.toString(16).padStart(12, "0")}`,
      role: n % 2 === 1 ? "user" : "assistant",
      createdAt: "2026-09-09T10:00:00.000Z",
      parts: [
        { kind: "text", text: `повідомлення ${String(n)}`, status: "complete" },
      ],
      revision: 1,
    };
  }

  /** What the server answers for messages `from`..`to`. */
  function window(from: number, to: number) {
    return {
      conversationId: CONVERSATION,
      messages: Array.from({ length: to - from + 1 }, (_, index) =>
        numbered(from + index),
      ),
      olderCursor: from > 1 ? String(from) : null,
      openPause: null,
    };
  }

  function range(from: number, to: number): string[] {
    return Array.from(
      { length: to - from + 1 },
      (_, index) => `повідомлення ${String(from + index)}`,
    );
  }

  function texts(view: ReturnType<typeof mount>): string[] {
    return view.latest().rows.map((row) => row.text);
  }

  /** A page that arrives only when told to. */
  function pageLater(): (body: unknown) => void {
    const pending: { resolve: ((response: Response) => void) | null } = {
      resolve: null,
    };
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          pending.resolve = resolve;
        }),
    );
    return (body) => {
      pending.resolve?.(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    };
  }

  async function loadedWithOlder() {
    respond(200, { status: "ok", window: window(2, 4) });
    const view = mount();
    await flush();
    return view;
  }

  it("loads the page before the oldest message, and keeps the thread in order", async () => {
    const view = await loadedWithOlder();

    respond(200, { status: "ok", window: window(1, 1) });
    act(() => {
      view.latest().loadOlder();
    });
    await flush();

    expect(texts(view)).toEqual(range(1, 4));
    const [url] = fetchMock.mock.calls[1] as [string];
    expect(url).toContain("before=2");

    // Nothing precedes the first message, so there is nothing more to ask for.
    act(() => {
      view.latest().loadOlder();
    });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("joins a reply onto the pages already loaded", async () => {
    const view = await loadedWithOlder();
    respond(200, { status: "ok", window: window(1, 1) });
    act(() => {
      view.latest().loadOlder();
    });
    await flush();

    respond(200, { status: "ok", window: window(4, 6) });
    await act(async () => {
      await view.latest().send("повідомлення 5");
    });

    expect(texts(view)).toEqual(range(1, 6));

    // The loaded pages still reach the first message.
    act(() => {
      view.latest().loadOlder();
    });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("starts again from the latest window when the conversation moved on further than one", async () => {
    const view = await loadedWithOlder();
    respond(200, { status: "ok", window: window(1, 1) });
    act(() => {
      view.latest().loadOlder();
    });
    await flush();

    // Another device took several turns meanwhile.
    respond(200, { status: "ok", window: window(8, 10) });
    await act(async () => {
      await view.latest().send("ще одне");
    });

    expect(texts(view)).toEqual(range(8, 10));

    // Paging back starts again from the new window, not the dropped pages.
    hang();
    act(() => {
      view.latest().loadOlder();
    });
    await flush();
    const [url] = fetchMock.mock.calls[3] as [string];
    expect(url).toContain("before=8");
  });

  it("drops an older page that arrives after the thread was reset under it", async () => {
    const view = await loadedWithOlder();
    const deliver = pageLater();
    act(() => {
      view.latest().loadOlder();
    });
    await flush();
    expect(view.latest().loadingOlder).toBe(true);

    // Not held up by the page on its way.
    respond(200, { status: "ok", window: window(8, 10) });
    await act(async () => {
      await view.latest().send("ще одне");
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);

    act(() => {
      deliver({ status: "ok", window: window(1, 1) });
    });
    await flush();

    expect(texts(view)).toEqual(range(8, 10));
    expect(view.latest().loadingOlder).toBe(false);
  });

  it("drops an older page for a company that is no longer on screen", async () => {
    const view = await loadedWithOlder();
    const deliver = pageLater();
    act(() => {
      view.latest().loadOlder();
    });
    await flush();

    respond(200, {
      status: "ok",
      window: conversationWindow({ text: "Компанія B." }),
    });
    view.switchCompany("66666666-6666-4666-8666-666666666666");
    await flush();

    act(() => {
      deliver({ status: "ok", window: window(1, 1) });
    });
    await flush();

    expect(texts(view)).toEqual(["Компанія B."]);
    expect(view.latest().loadingOlder).toBe(false);
  });

  it("asks for nothing when nothing is older", async () => {
    respond(200, { status: "ok", window: window(1, 3) });
    const view = mount();
    await flush();

    act(() => {
      view.latest().loadOlder();
    });
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("asks once while a page is already on its way", async () => {
    const view = await loadedWithOlder();
    hang();

    act(() => {
      view.latest().loadOlder();
      view.latest().loadOlder();
    });
    await flush();
    act(() => {
      view.latest().loadOlder();
    });
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

/**
 * The turn runs off the request now (ADR-0039), so the reply does not come back
 * as the answer to the request that started it. It arrives on the stream, and
 * these are the ways that can go wrong.
 */
describe("the conversation, live", () => {
  const COMMAND = "88888888-8888-4888-8888-888888888888";

  /** A body this test writes into, exactly as the network would. */
  function bodyStream() {
    const encoder = new TextEncoder();
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });
    return {
      body,
      send(event: string, payload: unknown) {
        controller?.enqueue(
          encoder.encode(
            `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`,
          ),
        );
      },
    };
  }

  function streamingWindow(options?: { readonly openPause?: unknown }) {
    return {
      conversationId: CONVERSATION,
      olderCursor: null,
      messages: [
        {
          messageId: MESSAGE,
          role: "assistant",
          createdAt: "2026-09-09T10:00:00.000Z",
          parts: [{ kind: "text", text: "", status: "streaming" }],
          revision: 1,
        },
      ],
      openPause: options?.openPause ?? null,
    };
  }

  function settledWindow(text: string, openPause: unknown = null) {
    return {
      conversationId: CONVERSATION,
      olderCursor: null,
      messages: [
        {
          messageId: MESSAGE,
          role: "assistant",
          createdAt: "2026-09-09T10:00:00.000Z",
          parts: [{ kind: "text", text, status: "complete" }],
          revision: 4,
        },
      ],
      openPause,
    };
  }

  /** Routed by URL, because the stream and the commands interleave. */
  function serve(windows: { readonly messages: unknown[] }) {
    const source = bodyStream();
    let read = 0;
    fetchMock.mockImplementation((url: unknown) => {
      if (String(url).includes("/assistant/kit/events")) {
        return Promise.resolve({ ok: true, status: 200, body: source.body });
      }
      const window =
        windows.messages[Math.min(read, windows.messages.length - 1)];
      read += 1;
      return Promise.resolve(
        new Response(JSON.stringify({ status: "ok", window }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    });
    return source;
  }

  function messageReads(): number {
    return fetchMock.mock.calls.filter((call) =>
      String(call[0]).includes("/assistant/kit/messages"),
    ).length;
  }

  /**
   * Item 3 of the ticket, and the reason there is no client-side turn state:
   * the placeholder the accept stores is the report that a turn is running, so
   * a turn started on another device reads as busy here too.
   */
  it("is busy because the conversation says so, not because a request is open", async () => {
    serve({ messages: [streamingWindow()] });
    const view = mount({ visible: true });
    await flush();

    expect(view.latest().busy).toBe(true);
    expect(view.latest().sending).toBe(false);
  });

  it("merges a message the stream updates, and ignores an older revision", async () => {
    const source = serve({ messages: [streamingWindow()] });
    const view = mount({ visible: true });
    await flush();

    act(() => {
      source.send("message.updated", {
        type: "message.updated",
        conversationId: CONVERSATION,
        message: {
          messageId: MESSAGE,
          role: "assistant",
          createdAt: "2026-09-09T10:00:00.000Z",
          parts: [{ kind: "text", text: "Готово.", status: "complete" }],
          revision: 4,
        },
      });
    });
    await flush();

    expect(view.latest().rows.map((row) => row.text)).toEqual(["Готово."]);
    expect(view.latest().busy).toBe(false);

    act(() => {
      source.send("message.updated", {
        type: "message.updated",
        conversationId: CONVERSATION,
        message: {
          messageId: MESSAGE,
          role: "assistant",
          createdAt: "2026-09-09T10:00:00.000Z",
          parts: [{ kind: "text", text: "Шукаю", status: "streaming" }],
          revision: 2,
        },
      });
    });
    await flush();

    // The later write stands. Without the revision rule the placeholder would
    // overwrite the card that had already arrived.
    expect(view.latest().rows.map((row) => row.text)).toEqual(["Готово."]);
    expect(view.latest().busy).toBe(false);
  });

  it("takes the window of the turn it was following when that turn ends", async () => {
    const source = serve({ messages: [streamingWindow()] });
    const view = mount({ visible: true });
    await flush();
    const readsBefore = messageReads();

    act(() => {
      source.send("turn.started", {
        type: "turn.started",
        conversationId: CONVERSATION,
        kind: "chat",
        commandId: COMMAND,
      });
      source.send("turn.finished", {
        type: "turn.finished",
        kind: "chat",
        commandId: COMMAND,
        status: "done",
        window: settledWindow("Яку Катю?", OPEN_PAUSE),
      });
    });
    await flush();

    expect(view.latest().interaction?.interactionId).toBe(INTERACTION);
    expect(view.latest().busy).toBe(false);
    // It vouched for that window, so it had no reason to ask again.
    expect(messageReads()).toBe(readsBefore);
  });

  /**
   * The reconciler ends a turn while acting for no person and cannot read a
   * window as a user it cannot act as (SHO-570). The absence is not "no open
   * question" — the client goes and reads the authority, exactly once.
   */
  it("re-reads the window exactly once when a turn ends without one", async () => {
    const source = serve({
      messages: [
        streamingWindow(),
        settledWindow("Шозік не встиг", OPEN_PAUSE),
      ],
    });
    const view = mount({ visible: true });
    await flush();
    expect(messageReads()).toBe(1);

    act(() => {
      source.send("turn.finished", {
        type: "turn.finished",
        kind: "chat",
        commandId: COMMAND,
        status: "interrupted",
      });
    });
    await flush();

    expect(messageReads()).toBe(2);
    expect(view.latest().interaction?.interactionId).toBe(INTERACTION);
    expect(view.latest().busy).toBe(false);
  });

  /**
   * The stream subscribes, then reads its snapshot, and delivers what arrived
   * in the gap afterwards — so a `turn.finished` published before that snapshot
   * can land after it. The pause it carries was closed in between, by an
   * abandon on another device that published nothing.
   */
  it("does not reopen a question a newer snapshot had already closed", async () => {
    const source = serve({
      messages: [settledWindow("Готово."), settledWindow("Готово.")],
    });
    const view = mount({ visible: true });
    await flush();

    act(() => {
      source.send("snapshot", {
        type: "snapshot",
        window: settledWindow("Готово."),
      });
    });
    await flush();
    expect(view.latest().interaction).toBeNull();

    act(() => {
      source.send("turn.finished", {
        type: "turn.finished",
        kind: "chat",
        commandId: COMMAND,
        status: "done",
        window: settledWindow("Яку Катю?", OPEN_PAUSE),
      });
    });
    await flush();

    // Still closed: this client was not following that turn, so its `openPause`
    // — which carries no revision and cannot be ordered — does not stand.
    expect(view.latest().interaction).toBeNull();
  });

  /**
   * Two reread-triggering events close together. The read already on its way
   * may have been *issued before* the second event merged its stale window, so
   * it can come back older than the regression it was meant to repair — and a
   * finished turn publishes nothing further to try again. Dropping the second
   * ask would leave the thread wrong until the next turn or a reconnect.
   */
  it("re-arms a re-read asked for while one was in flight", async () => {
    const source = bodyStream();
    const reads: ((window: unknown) => void)[] = [];
    fetchMock.mockImplementation((url: unknown) => {
      if (String(url).includes("/assistant/kit/events")) {
        return Promise.resolve({ ok: true, status: 200, body: source.body });
      }
      return new Promise<Response>((resolve) => {
        reads.push((window) => {
          resolve(
            new Response(JSON.stringify({ status: "ok", window }), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          );
        });
      });
    });

    const view = mount({ visible: true });
    await flush();
    act(() => {
      reads[0]?.(streamingWindow());
    });
    await flush();
    expect(reads).toHaveLength(1);

    const ended = {
      type: "turn.finished",
      kind: "chat",
      commandId: COMMAND,
      status: "interrupted",
    };

    act(() => {
      source.send("turn.finished", ended);
    });
    await flush();
    expect(reads).toHaveLength(2);

    // A second ask while that read is still on its way.
    act(() => {
      source.send("turn.finished", ended);
    });
    await flush();
    expect(reads).toHaveLength(2);

    // It settles — and the re-armed read follows rather than being lost.
    act(() => {
      reads[1]?.(streamingWindow());
    });
    await flush();
    expect(reads).toHaveLength(3);

    act(() => {
      reads[2]?.(settledWindow("Готово."));
    });
    await flush();
    expect(view.latest().rows.map((row) => row.text)).toEqual(["Готово."]);
    expect(view.latest().busy).toBe(false);
  });

  /**
   * The re-read takes no command latch, so its window can predate the accept of
   * a send that is still in flight. Clearing the echo there took the words off
   * the screen, and because an undecided send does not restore the draft
   * either, they ended up in neither place — the SHO-552 class.
   */
  it("keeps the echo of a send that is still in flight, and does not lose the words", async () => {
    const source = bodyStream();
    const chat: { reject: ((reason: Error) => void) | null } = { reject: null };
    fetchMock.mockImplementation((url: unknown) => {
      const target = String(url);
      if (target.includes("/assistant/kit/events")) {
        return Promise.resolve({ ok: true, status: 200, body: source.body });
      }
      if (target.includes("/assistant/kit/chat")) {
        return new Promise<Response>((_resolve, reject) => {
          chat.reject = reject;
        });
      }
      // Every read answers with a window from before this send's accept.
      return Promise.resolve(
        new Response(
          JSON.stringify({ status: "ok", window: settledWindow("Готово.") }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    });

    const view = mount({ visible: true });
    await flush();

    const sent: { outcome: unknown } = { outcome: null };
    act(() => {
      void view
        .latest()
        .send("ще одне")
        .then((outcome) => {
          sent.outcome = outcome;
        });
    });
    await flush();
    expect(view.latest().rows.map((row) => row.text)).toContain("ще одне");

    // Another device's turn ends: untracked, so a re-read is forced.
    act(() => {
      source.send("turn.finished", {
        type: "turn.finished",
        kind: "chat",
        commandId: COMMAND,
        status: "done",
        window: settledWindow("Готово."),
      });
    });
    await flush();
    expect(view.latest().rows.map((row) => row.text)).toContain("ще одне");

    await act(async () => {
      chat.reject?.(new Error("network is gone"));
      await flush();
    });

    expect(sent.outcome).toEqual({
      kind: "unknown",
      failure: { kind: "unreachable" },
    });
    // Still on screen. The sheet does not restore an undecided send's draft, so
    // this echo is the only place the words exist.
    expect(view.latest().rows.map((row) => row.text)).toContain("ще одне");
  });

  /**
   * The mirror of the test above, with the order reversed — and the one the
   * first fix missed. The re-read is *issued* while the send is in flight, but
   * *resolves* after it has failed, so a guard that asks "is a send in flight?"
   * when the answer arrives says no and clears the echo. The window it carries
   * was taken before the accept, and an undecided send does not restore the
   * draft, so the words would be in neither place.
   */
  it("keeps the echo when the send fails before the re-read resolves", async () => {
    const source = bodyStream();
    const chat: { reject: ((reason: Error) => void) | null } = { reject: null };
    const reads: ((window: unknown) => void)[] = [];
    fetchMock.mockImplementation((url: unknown) => {
      const target = String(url);
      if (target.includes("/assistant/kit/events")) {
        return Promise.resolve({ ok: true, status: 200, body: source.body });
      }
      if (target.includes("/assistant/kit/chat")) {
        return new Promise<Response>((_resolve, reject) => {
          chat.reject = reject;
        });
      }
      return new Promise<Response>((resolve) => {
        reads.push((window) => {
          resolve(
            new Response(JSON.stringify({ status: "ok", window }), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          );
        });
      });
    });

    const view = mount({ visible: true });
    await flush();
    act(() => {
      reads[0]?.(settledWindow("Готово."));
    });
    await flush();

    const sent: { outcome: unknown } = { outcome: null };
    act(() => {
      void view
        .latest()
        .send("ще одне")
        .then((outcome) => {
          sent.outcome = outcome;
        });
    });
    await flush();

    // A re-read is issued while the send is still in flight.
    act(() => {
      source.send("turn.finished", {
        type: "turn.finished",
        kind: "chat",
        commandId: COMMAND,
        status: "done",
        window: settledWindow("Готово."),
      });
    });
    await flush();
    expect(reads).toHaveLength(2);

    // The send fails first, so nothing is in flight any more.
    await act(async () => {
      chat.reject?.(new Error("network is gone"));
      await flush();
    });
    expect(sent.outcome).toEqual({
      kind: "unknown",
      failure: { kind: "unreachable" },
    });

    // Only now does that read answer, with a window from before the accept.
    act(() => {
      reads[1]?.(settledWindow("Готово."));
    });
    await flush();

    expect(view.latest().rows.map((row) => row.text)).toContain("ще одне");
  });

  /**
   * The echo guard in the **positive** direction, which nothing else covered:
   * every other echo test asserts the words are kept.
   *
   * This branch is the only thing that un-doubles them after an undecided
   * send — `unreachable` deliberately keeps the echo and `send` never clears
   * it — so a condition that was permanently false would leave the echo
   * sitting beside the stored message until the conversation changed, silently
   * and forever green. Deleting the `if` body must fail this test.
   */
  it("clears the echo once a re-read brings back the stored message", async () => {
    const SENT = "66666666-6666-4666-8666-666666666666";
    const source = bodyStream();
    const chat: { reject: ((reason: Error) => void) | null } = { reject: null };
    let storedNow = false;
    const withSent = () => ({
      conversationId: CONVERSATION,
      olderCursor: null,
      messages: [
        {
          messageId: SENT,
          role: "user",
          createdAt: "2026-09-09T10:00:30.000Z",
          parts: [{ kind: "text", text: "ще одне", status: "complete" }],
          revision: 1,
        },
        {
          messageId: MESSAGE,
          role: "assistant",
          createdAt: "2026-09-09T10:01:00.000Z",
          parts: [{ kind: "text", text: "Готово.", status: "complete" }],
          revision: 4,
        },
      ],
      openPause: null,
    });
    fetchMock.mockImplementation((url: unknown) => {
      const target = String(url);
      if (target.includes("/assistant/kit/events")) {
        return Promise.resolve({ ok: true, status: 200, body: source.body });
      }
      if (target.includes("/assistant/kit/chat")) {
        return new Promise<Response>((_resolve, reject) => {
          chat.reject = reject;
        });
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            status: "ok",
            window: storedNow ? withSent() : settledWindow("Готово."),
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    });

    const view = mount({ visible: true });
    await flush();

    const sent: { outcome: unknown } = { outcome: null };
    act(() => {
      void view
        .latest()
        .send("ще одне")
        .then((outcome) => {
          sent.outcome = outcome;
        });
    });
    await flush();

    await act(async () => {
      chat.reject?.(new Error("network is gone"));
      await flush();
    });
    expect(sent.outcome).toEqual({
      kind: "unknown",
      failure: { kind: "unreachable" },
    });
    // Kept for now: the accept may well have stored it.
    expect(view.latest().rows.map((row) => row.text)).toContain("ще одне");

    // It had been stored. An untracked turn ending forces the re-read that
    // finds it, and this one is issued with no send in flight.
    storedNow = true;
    act(() => {
      source.send("turn.finished", {
        type: "turn.finished",
        kind: "chat",
        commandId: COMMAND,
        status: "done",
        window: settledWindow("Готово."),
      });
    });
    await flush();

    // Once, not twice: the echo gave way to the stored message.
    expect(view.latest().rows.map((row) => row.text)).toEqual([
      "ще одне",
      "Готово.",
    ]);
  });

  it("replaces stale state from the snapshot a reconnection opens with", async () => {
    const source = serve({ messages: [streamingWindow()] });
    const view = mount({ visible: true });
    await flush();
    expect(view.latest().busy).toBe(true);

    act(() => {
      source.send("snapshot", {
        type: "snapshot",
        window: settledWindow("Готово."),
      });
    });
    await flush();

    expect(view.latest().rows.map((row) => row.text)).toEqual(["Готово."]);
    expect(view.latest().busy).toBe(false);
  });
});
