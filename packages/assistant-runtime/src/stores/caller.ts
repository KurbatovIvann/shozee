/**
 * How the Postgres stores act as a person: one principal, one request, and one
 * name for a conversation that is not theirs. Shared by the message log, the
 * history and the turn store; not part of the package's public surface.
 */
import type { ActionPipelineDeps } from "@showzy/core";
import { CoreError, CoreInvariantError } from "@showzy/core/errors";

import { ASSISTANT_INVOCATION_CHANNEL } from "../assistant-invocation.js";

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
export async function asCaller<T>(work: () => Promise<T>): Promise<T> {
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
export function asJson(value: unknown): unknown {
  if (value === undefined) {
    return null;
  }
  return JSON.parse(JSON.stringify(value)) as unknown;
}

/** A stored message is always an object; anything else is a bug in the caller. */
export function asJsonObject(value: unknown): Record<string, unknown> {
  const json = asJson(value);
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new CoreInvariantError("assistant chat message is not a JSON object");
  }
  return json as Record<string, unknown>;
}

export function callFor(caller: AssistantKitCaller) {
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
