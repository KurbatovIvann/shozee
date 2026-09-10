/**
 * Postgres behind the `assistant-kit` message-log and history ports.
 *
 * The conversation is the product's record, not a cache. Redis was right for
 * proving the protocol by hand and wrong the moment the app started using it: a
 * ttl means a conversation quietly starts over, and nothing that matters should
 * be one eviction from gone.
 *
 * The pause stays on Redis and belongs there — a deadline in minutes and one
 * atomic claim is what that store is for. What is durable here is what a person
 * reads and what the next turn is built from.
 *
 * Everything goes through `executeAction`, so the tenant scope and the author
 * rule are the module's, applied the same way as every other read and write of
 * that conversation. That is why these are built per caller rather than once at
 * boot: the store acts as the person, and there is no ambient principal to act
 * as.
 */
import {
  insertChatMessage,
  readChatMessages,
  readChatState,
  updateChatMessage,
  writeChatState,
} from "@showzy/assistant";
import type {
  MessageLogStore,
  ModelMessage,
  PauseScope,
} from "@showzy/assistant-kit";
import { executeAction, type ActionPipelineDeps } from "@showzy/core";
import { CoreError, CoreInvariantError } from "@showzy/core/errors";

import { ASSISTANT_INVOCATION_CHANNEL } from "../http/assistant-invocation.js";
import { assistantHistoryWindow } from "../http/assistant-kit-history-window.js";
import type { AssistantHistoryPort } from "../http/assistant-kit-http.js";

/**
 * Who the stores act as. Not the kit's `bind`, which is an opaque token the
 * package only ever compares — this is the principal the pipeline needs.
 */
export interface AssistantKitCaller {
  readonly userId: string;
  readonly companySelector: string;
  readonly requestId: string;
  readonly clientIp: string;
}

export interface AssistantKitStoreDeps {
  readonly pipeline: ActionPipelineDeps;
}

/**
 * Raised when the conversation does not exist, or is not this person's.
 *
 * One error for both, because the module answers both with `NOT_FOUND` — a
 * conversation id is not a secret, and telling the two apart would make it one.
 */
export class AssistantKitConversationGoneError extends Error {
  constructor() {
    super("assistant conversation not found");
    this.name = "AssistantKitConversationGoneError";
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof CoreError && error.code === "NOT_FOUND";
}

/** Runs one call as the caller, and names a missing conversation for what it is. */
async function asCaller<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (isNotFound(error)) {
      throw new AssistantKitConversationGoneError();
    }
    throw error;
  }
}

/**
 * What goes into a `jsonb` column has to be JSON, and `undefined` is not.
 *
 * The AI SDK's message parts carry optional fields as an explicit `undefined`
 * — `providerExecuted` is the one that turns up in practice. Postgres would
 * drop those keys on the way in regardless, but the audit hook hashes the
 * action's input first and refuses `undefined` outright, so an unnormalised
 * value fails the write rather than being quietly cleaned.
 *
 * Normalising here rather than in the module is deliberate: this is the edge
 * where a runtime's in-memory objects become stored bytes, and it is the only
 * place that knows they came from a JS object graph in the first place.
 */
function asJson(value: unknown): unknown {
  if (value === undefined) {
    return null;
  }
  return JSON.parse(JSON.stringify(value)) as unknown;
}

/** A stored message is always an object; anything else is a bug in the caller. */
function asJsonObject(value: unknown): Record<string, unknown> {
  const json = asJson(value);
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new CoreInvariantError("assistant chat message is not a JSON object");
  }
  return json as Record<string, unknown>;
}

function callFor(caller: AssistantKitCaller) {
  return {
    request: {
      requestId: caller.requestId,
      correlationId: caller.requestId,
      channel: ASSISTANT_INVOCATION_CHANNEL,
      clientIp: caller.clientIp,
      aiTraceId: caller.requestId,
    },
    principal: {
      mode: "staff" as const,
      session: { userId: caller.userId },
      companySelector: caller.companySelector,
    },
  };
}

/**
 * The transcript, one row per message.
 *
 * Each operation is one action as the caller, so the author rule holds for every
 * page read and every write alike. The sequence number and the refusal of a
 * repeated message id are the module's; the kit relies on both.
 */
export function createPostgresAssistantKitMessageLog(
  deps: AssistantKitStoreDeps,
  caller: AssistantKitCaller,
): MessageLogStore {
  const call = callFor(caller);
  return {
    page: (conversationId, options) =>
      asCaller(async () => {
        const page = await executeAction(deps.pipeline, {
          action: readChatMessages,
          input: {
            conversationId,
            limit: options.limit,
            ...(options.beforeSeq === undefined
              ? {}
              : { beforeSeq: options.beforeSeq }),
          },
          ...call,
        });
        return { records: page.records, hasOlder: page.hasOlder };
      }),

    insert: (conversationId, record) =>
      asCaller(async () => {
        const inserted = await executeAction(deps.pipeline, {
          action: insertChatMessage,
          input: {
            conversationId,
            messageId: record.messageId,
            bind: record.bind,
            message: asJsonObject(record.message),
          },
          ...call,
        });
        return { seq: inserted.seq };
      }),

    /**
     * Not through `asCaller`. The kit updates only the message it has just read
     * in the same request, so the conversation is already known to be this
     * person's; a not-found here means that message vanished under a held lease,
     * and dressing it as a gone conversation would hide a fault as a 410.
     */
    update: async (conversationId, record) => {
      await executeAction(deps.pipeline, {
        action: updateChatMessage,
        input: {
          conversationId,
          seq: record.seq,
          messageId: record.messageId,
          message: asJsonObject(record.message),
        },
        ...call,
      });
    },
  };
}

/**
 * Model history for the next turn.
 *
 * Stored whole, replacing what was there. The turn already holds the exact
 * provider messages it ran with — appending deltas here would make the next
 * turn's prompt a reconstruction, which is the thing this path exists to stop.
 */
export function createPostgresAssistantKitHistoryStore(
  deps: AssistantKitStoreDeps,
  caller: AssistantKitCaller,
): AssistantHistoryPort {
  const call = callFor(caller);
  return {
    load: (scope: PauseScope): Promise<ModelMessage[]> =>
      asCaller(async () => {
        const state = await executeAction(deps.pipeline, {
          action: readChatState,
          input: { conversationId: scope.conversationId },
          ...call,
        });
        // Anything unreadable is treated as no history: a malformed blob must
        // cost one conversation's memory, not the ability to answer at all.
        //
        // Windowed on the way out, which is where the decision belongs: what is
        // stored is what the last turn ran with, and how much of it the next
        // turn is told about is a budget question, not a storage one.
        return Array.isArray(state.history)
          ? assistantHistoryWindow(state.history as ModelMessage[])
          : [];
      }),

    save: (scope: PauseScope, messages: readonly ModelMessage[]) =>
      asCaller(async () => {
        await executeAction(deps.pipeline, {
          action: writeChatState,
          input: {
            conversationId: scope.conversationId,
            history: asJson(messages),
          },
          ...call,
        });
      }),
  };
}
