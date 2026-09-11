/**
 * Resolution order, and the two ways it can go wrong: creating a second row for
 * someone who already has one, and reopening a colleague's thread because the
 * listing is tenant-scoped rather than person-scoped.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import "../../../auth/react-test-dom";
import {
  findOwnConversationId,
  useAssistantConversationId,
  type AssistantConversationDirectory,
  type AssistantConversationsPage,
  type UseAssistantConversationId,
} from "./use-assistant-conversation-id";
import type { AssistantTenantEpochRef } from "./use-assistant-conversation";

const MINE = "11111111-1111-4111-8111-111111111111";
const THEIRS = "22222222-2222-4222-8222-222222222222";
const ME = "user-me";

function page(
  items: readonly { id: string; userId: string }[],
  nextCursor: string | null = null,
): AssistantConversationsPage {
  return { items, nextCursor };
}

let roots: Root[] = [];

afterEach(() => {
  for (const root of roots) {
    act(() => {
      root.unmount();
    });
  }
  roots = [];
});

type Latest = { current: UseAssistantConversationId | null };

function Probe(props: {
  readonly latest: Latest;
  readonly directory: AssistantConversationDirectory | null;
  readonly tenantEpochRef: AssistantTenantEpochRef;
  readonly sessionUserId: string | null;
}) {
  props.latest.current = useAssistantConversationId({
    sessionUserId: props.sessionUserId,
    directory: props.directory,
    tenantEpochRef: props.tenantEpochRef,
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

function mount(options: {
  readonly directory: AssistantConversationDirectory | null;
  readonly sessionUserId?: string | null;
}) {
  const latest: Latest = { current: null };
  const tenantEpochRef: AssistantTenantEpochRef = { current: 0 };
  const root = createRoot(globalThis.document.createElement("div"));
  roots.push(root);
  act(() => {
    root.render(
      createElement(Probe, {
        latest,
        directory: options.directory,
        tenantEpochRef,
        sessionUserId:
          options.sessionUserId === undefined ? ME : options.sessionUserId,
      }),
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

describe("findOwnConversationId", () => {
  it("skips a colleague's thread in the same company", async () => {
    const own = await findOwnConversationId({
      sessionUserId: ME,
      list: () =>
        Promise.resolve(
          page([
            { id: THEIRS, userId: "someone-else" },
            { id: MINE, userId: ME },
          ]),
        ),
    });

    expect(own).toBe(MINE);
  });

  it("pages until it finds one", async () => {
    const list = vi
      .fn<AssistantConversationDirectory["list"]>()
      .mockResolvedValueOnce(page([{ id: THEIRS, userId: "other" }], "c1"))
      .mockResolvedValueOnce(page([{ id: MINE, userId: ME }]));

    expect(await findOwnConversationId({ sessionUserId: ME, list })).toBe(MINE);
    expect(list).toHaveBeenNthCalledWith(1, {});
    expect(list).toHaveBeenNthCalledWith(2, { cursor: "c1" });
  });

  it("stops on a cursor that does not advance", async () => {
    const list = vi
      .fn<AssistantConversationDirectory["list"]>()
      .mockResolvedValue(page([{ id: THEIRS, userId: "other" }], "stuck"));

    expect(await findOwnConversationId({ sessionUserId: ME, list })).toBeNull();
    // Two calls: the first, and the one whose cursor repeated.
    expect(list).toHaveBeenCalledTimes(2);
  });
});

describe("useAssistantConversationId", () => {
  it("reuses the conversation this person already has", async () => {
    const create = vi.fn();
    const view = mount({
      directory: {
        list: () => Promise.resolve(page([{ id: MINE, userId: ME }])),
        create,
      },
    });

    await flush();

    expect(view.latest().conversationId).toBe(MINE);
    expect(view.latest().resolving).toBe(false);
    // The row already existed; creating a second one is the defect this guards.
    expect(create).not.toHaveBeenCalled();
  });

  it("creates one only when there is none", async () => {
    const create = vi.fn().mockResolvedValue({ id: MINE });
    const view = mount({
      directory: { list: () => Promise.resolve(page([])), create },
    });

    await flush();

    expect(create).toHaveBeenCalledTimes(1);
    expect(view.latest().conversationId).toBe(MINE);
  });

  it("waits for a session and a tenant before asking", async () => {
    const list = vi.fn();
    const view = mount({ directory: null, sessionUserId: null });

    await flush();

    expect(list).not.toHaveBeenCalled();
    expect(view.latest().conversationId).toBeNull();
    expect(view.latest().resolving).toBe(false);
  });

  it("reports a failure rather than looking like an empty conversation", async () => {
    const view = mount({
      directory: {
        list: () => Promise.reject(new Error("offline")),
        create: vi.fn(),
      },
    });

    await flush();

    expect(view.latest().failed).toBe(true);
    expect(view.latest().conversationId).toBeNull();
    expect(view.latest().resolving).toBe(false);
  });

  it("drops an id that resolves after the tenant changed", async () => {
    let settle: ((page: AssistantConversationsPage) => void) | null = null;
    const view = mount({
      directory: {
        list: () =>
          new Promise<AssistantConversationsPage>((resolve) => {
            settle = resolve;
          }),
        create: vi.fn(),
      },
    });
    await flush();

    view.tenantEpochRef.current += 1;
    act(() => {
      settle?.(page([{ id: MINE, userId: ME }]));
    });
    await flush();

    expect(view.latest().conversationId).toBeNull();
  });
});
