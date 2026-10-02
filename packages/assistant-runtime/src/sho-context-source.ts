import { listNameIndex as listCatalogNameIndex } from "@showzy/catalog";
import { executeAction, type ActionPipelineDeps } from "@showzy/core";
import { PermissionDeniedError } from "@showzy/core/errors";
import { listNameIndex as listCustomersNameIndex } from "@showzy/customers";
import { listNameIndex as listPricingNameIndex } from "@showzy/pricing";
import type {
  ShoClient,
  ShoFallback,
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

export const SHO_CONTEXT_UNREADABLE: ShoFallback = {
  outcome: "fallback",
  reason: "unreadable",
  httpStatus: null,
};

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
}

export interface ShoParseText {
  readonly text: string;
  readonly now: ShoNow;
  readonly previous?: ShoPrevious;
  readonly deadlineMs: number;
  readonly debug: boolean;
}

type Scope<Read> =
  { readonly read: Read } | { readonly denied: PermissionDeniedError };

async function asScope<Read>(read: () => Promise<Read>): Promise<Scope<Read>> {
  try {
    return { read: await read() };
  } catch (error) {
    if (error instanceof PermissionDeniedError) return { denied: error };
    throw error;
  }
}

const visible = <Read>(scope: Scope<Read>): Read | null =>
  "read" in scope ? scope.read : null;

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
  const scopes = await Promise.all([
    asScope(() =>
      executeAction(pipeline, {
        action: listCatalogNameIndex,
        input: {},
        ...call,
      }),
    ),
    asScope(() =>
      executeAction(pipeline, {
        action: listCustomersNameIndex,
        input: {},
        ...call,
      }),
    ),
    asScope(() =>
      executeAction(pipeline, {
        action: listPricingNameIndex,
        input: {},
        ...call,
      }),
    ),
  ]);
  const denials = scopes.flatMap((scope) =>
    "denied" in scope ? [scope.denied] : [],
  );
  const refusedEverything = denials[0];
  if (denials.length === scopes.length && refusedEverything !== undefined) {
    throw refusedEverything;
  }
  const [catalog, customers, pricing] = scopes;
  return {
    catalog: visible(catalog),
    customers: visible(customers),
    pricing: visible(pricing),
  };
}

export function createShoContextSource(
  deps: ShoContextSourceDeps,
): ShoContextSource {
  const clock = deps.now ?? (() => Date.now());
  const builds = new Map<string, { builtAt: number; build: ShoContextBuild }>();
  const scopeOfCaller = new Map<string, string>();
  const callerKey = (caller: ShoContextCaller): string =>
    `${caller.companyId}\u0000${caller.userId}`;
  const buildKey = (companyId: string, scopeHash: string): string =>
    `${companyId}\u0000${scopeHash}`;

  return {
    async current(caller) {
      const at = clock();
      const known = scopeOfCaller.get(callerKey(caller));
      const entry = known === undefined ? undefined : builds.get(known);
      if (entry !== undefined && at - entry.builtAt < SHO_CONTEXT_TTL_MS) {
        return entry.build;
      }

      const built = buildShoContext(
        await readShoNameIndex(deps.pipeline, caller),
      );
      for (const [key, stale] of builds) {
        if (at - stale.builtAt >= SHO_CONTEXT_TTL_MS) builds.delete(key);
      }
      const key = buildKey(caller.companyId, built.scopeHash);
      const shared = builds.get(key) ?? { builtAt: at, build: built };
      builds.set(key, shared);
      scopeOfCaller.set(callerKey(caller), key);
      for (const [who, pointed] of scopeOfCaller) {
        if (!builds.has(pointed)) scopeOfCaller.delete(who);
      }
      return shared.build;
    },
  };
}

export async function parseWithShoContext(
  client: ShoClient,
  source: ShoContextSource,
  caller: ShoContextCaller,
  request: ShoParseText,
): Promise<ShoParseOutcome> {
  let built: ShoContextBuild;
  try {
    built = await source.current(caller);
  } catch (error) {
    if (error instanceof PermissionDeniedError) throw error;
    return SHO_CONTEXT_UNREADABLE;
  }

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
