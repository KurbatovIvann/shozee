import { STAFF_ASSISTANT_TIME_ZONE } from "@showzy/ai";
import type { ActionPipelineDeps } from "@showzy/core";
import { PermissionDeniedError } from "@showzy/core/errors";
import {
  createShoClient,
  SHO_DEFAULT_TIMEOUT_MS,
  type ShoClient,
  type ShoNow,
  type ShoParseOutcome,
  type ShoResult,
} from "@showzy/sho-protocol";

import {
  createShoContextSource,
  parseWithShoContext,
  type ShoContextSource,
} from "./sho-context-source.js";
import { createShoPlanner } from "./sho-plan.js";
import type { ShoEngine, ShoPlan } from "./sho-turn.js";

export interface ShoVerifiedMember {
  readonly verifiedCompanyId: string;
  readonly userId: string;
  readonly requestId: string;
  readonly clientIp?: string;
}

export type ShoPlanner = (result: ShoResult, now: Date) => ShoPlan;

export type ShoEngineFor = (member: ShoVerifiedMember) => ShoEngine;

export interface ShoEngineDeps {
  readonly client: ShoClient;
  readonly source: ShoContextSource;
  readonly plan: ShoPlanner;
  readonly deadlineMs?: number;
}

const kyivParts = new Intl.DateTimeFormat("en-GB", {
  timeZone: STAFF_ASSISTANT_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

export function shoNowAt(now: Date): ShoNow {
  const parts = new Map(
    kyivParts.formatToParts(now).map((part) => [part.type, part.value]),
  );
  const read = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.get(type) ?? "0");
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour") % 24,
    minute: read("minute"),
  };
}

const fallback = (
  reason: Extract<ShoPlan, { kind: "fallback" }>["reason"],
): ShoPlan => ({ kind: "fallback", reason });

export function createShoEngine(deps: ShoEngineDeps): ShoEngineFor {
  const deadlineMs = deps.deadlineMs ?? SHO_DEFAULT_TIMEOUT_MS;
  return (member) => ({
    async plan(request) {
      const caller = {
        companyId: member.verifiedCompanyId,
        userId: member.userId,
        requestId: member.requestId,
        ...(member.clientIp === undefined ? {} : { clientIp: member.clientIp }),
      };
      let parsed: ShoParseOutcome;
      try {
        parsed = await parseWithShoContext(deps.client, deps.source, caller, {
          text: request.text,
          now: shoNowAt(request.now),
          deadlineMs,
          debug: false,
        });
      } catch (error) {
        if (error instanceof PermissionDeniedError) {
          return fallback("unreadable");
        }
        throw error;
      }
      if (parsed.outcome === "fallback") {
        return fallback(parsed.reason);
      }
      if (parsed.outcome !== "ok") {
        return fallback("unreadable");
      }
      return deps.plan(parsed.value.result, request.now);
    },
  });
}

export interface ShoMountConfig {
  readonly urls: readonly string[];
  readonly serviceToken: string | undefined;
  readonly actions: readonly string[];
}

export interface ShoMountDeps {
  readonly sho: ShoMountConfig;
  readonly pipeline: ActionPipelineDeps;
}

export function mountShoEngine(deps: ShoMountDeps): ShoEngineFor | undefined {
  const { urls, serviceToken, actions } = deps.sho;
  if (urls.length === 0 || serviceToken === undefined) {
    return undefined;
  }
  return createShoEngine({
    client: createShoClient({ urls: [...urls], token: serviceToken }),
    source: createShoContextSource({ pipeline: deps.pipeline }),
    plan: createShoPlanner({ actions }),
  });
}
