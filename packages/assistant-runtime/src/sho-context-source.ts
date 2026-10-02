import { listNameIndex as listCatalogNameIndex } from "@showzy/catalog";
import { executeAction, type ActionPipelineDeps } from "@showzy/core";
import { PermissionDeniedError } from "@showzy/core/errors";
import { listNameIndex as listCustomersNameIndex } from "@showzy/customers";
import { listNameIndex as listPricingNameIndex } from "@showzy/pricing";
import type {
  ShoClient,
  ShoNow,
  ShoParseOutcome,
  ShoPrevious,
} from "@showzy/sho-protocol";

import {
  buildShoContext,
  type ShoContextBuild,
  type ShoNameIndexSnapshot,
} from "./sho-context.js";
import { callFor } from "./stores/caller.js";

export const SHO_CONTEXT_TTL_MS = 30_000;

export interface ShoContextCaller {
  readonly companyId: string;
  readonly userId: string;
  readonly requestId: string;
  readonly clientIp?: string;
}

export interface ShoContextSourceDeps {
  readonly pipeline: ActionPipelineDeps;
  readonly now?: () => number;
}

export interface ShoContextSource {
  readonly current: (caller: ShoContextCaller) => Promise<ShoContextBuild>;
  readonly rebuild: (caller: ShoContextCaller) => Promise<ShoContextBuild>;
}

export interface ShoParseText {
  readonly text: string;
  readonly now: ShoNow;
  readonly previous?: ShoPrevious;
  readonly deadlineMs: number;
  readonly debug: boolean;
}

async function whenVisible<Read>(
  read: () => Promise<Read>,
): Promise<Read | null> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof PermissionDeniedError) return null;
    throw error;
  }
}

export async function readShoNameIndex(
  pipeline: ActionPipelineDeps,
  caller: ShoContextCaller,
): Promise<ShoNameIndexSnapshot> {
  const call = callFor({
    userId: caller.userId,
    companySelector: caller.companyId,
    requestId: caller.requestId,
    ...(caller.clientIp === undefined ? {} : { clientIp: caller.clientIp }),
  });
  const [catalog, customers, pricing] = await Promise.all([
    whenVisible(() =>
      executeAction(pipeline, {
        action: listCatalogNameIndex,
        input: {},
        ...call,
      }),
    ),
    whenVisible(() =>
      executeAction(pipeline, {
        action: listCustomersNameIndex,
        input: {},
        ...call,
      }),
    ),
    whenVisible(() =>
      executeAction(pipeline, {
        action: listPricingNameIndex,
        input: {},
        ...call,
      }),
    ),
  ]);
  return { catalog, customers, pricing };
}

export function createShoContextSource(
  deps: ShoContextSourceDeps,
): ShoContextSource {
  const clock = deps.now ?? (() => Date.now());
  const cached = new Map<string, { builtAt: number; build: ShoContextBuild }>();
  const keyOf = (caller: ShoContextCaller): string =>
    `${caller.companyId}\u0000${caller.userId}`;

  async function build(caller: ShoContextCaller): Promise<ShoContextBuild> {
    const builtAt = clock();
    const built = buildShoContext(
      await readShoNameIndex(deps.pipeline, caller),
    );
    for (const [key, entry] of cached) {
      if (builtAt - entry.builtAt >= SHO_CONTEXT_TTL_MS) cached.delete(key);
    }
    cached.set(keyOf(caller), { builtAt, build: built });
    return built;
  }

  return {
    rebuild: build,
    async current(caller) {
      const entry = cached.get(keyOf(caller));
      if (entry !== undefined && clock() - entry.builtAt < SHO_CONTEXT_TTL_MS) {
        return entry.build;
      }
      return build(caller);
    },
  };
}

export async function parseWithShoContext(
  client: ShoClient,
  source: ShoContextSource,
  caller: ShoContextCaller,
  request: ShoParseText,
): Promise<ShoParseOutcome> {
  const built = await source.current(caller);
  const send = (): Promise<ShoParseOutcome> =>
    client.parse({
      requestId: caller.requestId,
      companyId: caller.companyId,
      scopeHash: built.scopeHash,
      fingerprint: built.fingerprint,
      text: request.text,
      now: request.now,
      ...(request.previous === undefined ? {} : { previous: request.previous }),
      deadlineMs: request.deadlineMs,
      debug: request.debug,
    });

  const parsed = await send();
  if (parsed.outcome !== "context_required") return parsed;

  const stored = await client.putContext({
    companyId: caller.companyId,
    scopeHash: built.scopeHash,
    fingerprint: built.fingerprint,
    context: built.context,
  });
  if (stored.outcome !== "stored") return stored;
  return send();
}
