/**
 * Which conversation this person is in.
 *
 * The kit stores its document under a `conversationId` it never mints and never
 * registers — an id is an argument to it, not something it owns. So identity has
 * to come from somewhere that survives an app restart, and the existing
 * `assistant.createConversation` / `listConversations` pair already is that: a
 * row per person per tenant, found again by listing. Reusing it keeps identity
 * orthogonal to the protocol, and means nothing has to be persisted on device.
 *
 * Resolved on mount rather than on the first message. The old path created the
 * row lazily inside `send`, which meant `send` had to wait on a mutation before
 * it knew where to post — an ordering problem worth one row per person. Opening
 * the sheet and typing nothing therefore creates a row; it is the same single row
 * that would have been created by the first message, not one per visit.
 */
import { useEffect, useRef, useState } from "react";

import type { AssistantTenantEpochRef } from "./use-assistant-conversation";

export const ASSISTANT_CONVERSATION_PAGE_MAX = 50;

export type AssistantConversationListItem = {
  readonly id: string;
  readonly userId: string;
};

export type AssistantConversationsPage = {
  readonly items: readonly AssistantConversationListItem[];
  readonly nextCursor: string | null;
};

/**
 * The two calls this needs, injected rather than reached for, so the resolution
 * order is testable without a transport.
 */
export interface AssistantConversationDirectory {
  list(input: {
    readonly cursor?: string;
  }): Promise<AssistantConversationsPage>;
  create(): Promise<{ readonly id: string }>;
}

/**
 * The caller's own conversation, or `null`.
 *
 * Filtered by `userId` because the listing is tenant-scoped, not person-scoped:
 * another member of the same company appears in it, and their thread is not this
 * person's to reopen.
 */
export async function findOwnConversationId(args: {
  readonly sessionUserId: string;
  readonly list: AssistantConversationDirectory["list"];
}): Promise<string | null> {
  let cursor: string | undefined;
  for (let page = 0; page < ASSISTANT_CONVERSATION_PAGE_MAX; page += 1) {
    const listed = await args.list(cursor === undefined ? {} : { cursor });
    const own = listed.items.find((item) => item.userId === args.sessionUserId);
    if (own !== undefined) {
      return own.id;
    }
    // A cursor that does not advance would page forever.
    if (listed.nextCursor === null || listed.nextCursor === cursor) {
      return null;
    }
    cursor = listed.nextCursor;
  }
  return null;
}

export interface UseAssistantConversationId {
  readonly conversationId: string | null;
  /** True until the first attempt settles, so a caller can tell empty apart. */
  readonly resolving: boolean;
  readonly failed: boolean;
}

export function useAssistantConversationId(args: {
  readonly sessionUserId: string | null;
  readonly directory: AssistantConversationDirectory | null;
  readonly tenantEpochRef: AssistantTenantEpochRef;
}): UseAssistantConversationId {
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const [failed, setFailed] = useState(false);
  const epochRef = args.tenantEpochRef;
  const startedRef = useRef<string | null>(null);

  useEffect(() => {
    const { sessionUserId, directory } = args;
    if (sessionUserId === null || directory === null) {
      setConversationId(null);
      setResolving(false);
      setFailed(false);
      startedRef.current = null;
      return;
    }
    // React 19 runs effects twice in development. Without this the second pass
    // creates a second row for a person who had none.
    const attempt = `${String(epochRef.current)}:${sessionUserId}`;
    if (startedRef.current === attempt) {
      return;
    }
    startedRef.current = attempt;

    const epoch = epochRef.current;
    const live: { current: boolean } = { current: true };
    setConversationId(null);
    setResolving(true);
    setFailed(false);

    void (async () => {
      try {
        const existing = await findOwnConversationId({
          sessionUserId,
          list: (input) => directory.list(input),
        });
        const id = existing ?? (await directory.create()).id;
        if (live.current && epochRef.current === epoch) {
          setConversationId(id);
        }
      } catch {
        if (live.current && epochRef.current === epoch) {
          setFailed(true);
        }
      } finally {
        if (live.current && epochRef.current === epoch) {
          setResolving(false);
        }
      }
    })();

    return () => {
      live.current = false;
    };
    // `directory` is the caller's to keep stable; a new identity on every render
    // would list and create on every render.
  }, [args.sessionUserId, args.directory, epochRef]);

  return { conversationId, resolving, failed };
}
