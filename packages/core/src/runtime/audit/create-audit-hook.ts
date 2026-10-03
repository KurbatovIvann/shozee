/**
 * `createAuditHook` — the fnd-T13 audit protocol implementation (core.md §8).
 *
 * Inserts one `audit_log` row per audited action execution:
 * - **Success (mutations):** inside the handler transaction — atomically with effects.
 * - **Success (reads):** the pipeline calls this in a separate post-commit
 *   transaction; the hook itself is transaction-agnostic.
 * - **Failure / permission denial:** in its own short transaction after
 *   rollback; receives whatever identity the pipeline established.
 *   Failures before successful input validation pass `input: undefined`
 *   and write no row (core.md §8).
 *
 * `inputHash` is always the SHA-256 of the RFC 8785 canonical JSON of the
 * validated input. `inputSnapshot` is populated only when the action binds
 * an `auditSnapshot` callback (hash-only is the default).
 */
import { auditLog, type Database, type Tx } from "@showzy/db";
import type { Logger } from "pino";

import { CoreInvariantError } from "../../errors/index.js";
import { effectiveCompanyId } from "../context/factories.js";
import {
  SHARE_DURABLE_ACTOR,
  type ActionActor,
  type ActionChannel,
} from "../context/types.js";
import type { AuditTargetEnv, AuditTargetRef, JsonValue } from "../types.js";
import type {
  AuditHook,
  PreflightAuthorization,
  PrincipalInvocation,
} from "../pipeline/types.js";
import { canonicalJsonSha256OfUnknown } from "./canonical-json.js";

export interface AuditHookDeps {
  readonly db: Database;
  /** Process logger — audit-target callback failures are logged, never swallowed. */
  readonly logger: Logger;
}

export function createAuditHook(deps: AuditHookDeps): AuditHook {
  return {
    async recordSuccess(env) {
      const targetEnv: AuditTargetEnv = {
        input: env.input,
        output: env.output,
        ctx: env.ctx,
        ...(env.resolvedId !== undefined ? { resolvedId: env.resolvedId } : {}),
      };
      const target = await env.auditTarget(targetEnv);
      const inputHash = hashInput(env.input);
      const snapshot = env.auditSnapshot
        ? env.auditSnapshot(env.input)
        : undefined;

      const actor = toAuditActor(
        env.ctx.actor,
        effectiveCompanyId(env.ctx),
        env.ctx.principal === "share",
      );
      await insertAuditRow(env.tx, {
        requestId: env.ctx.requestId,
        correlationId: env.ctx.correlationId,
        action: env.contract.name,
        actorType: actor.actorType,
        actorId: actor.actorId,
        channel: env.ctx.channel,
        aiTraceId: env.ctx.aiTraceId,
        toolCallId: env.ctx.toolCallId,
        companyId: actor.companyId,
        target,
        inputHash,
        inputSnapshot: snapshot ?? null,
        outcome: "ok",
        durationMs: env.durationMs,
      });
    },

    async recordFailure(env) {
      // core.md §8: no validated input → no accountable audit row.
      if (env.input === undefined) return;

      const identity = resolveFailureIdentity(env.principal, env.authorization);

      let target: AuditTargetRef | undefined;
      if (env.auditTarget !== undefined) {
        try {
          const targetEnv: AuditTargetEnv = {
            input: env.input,
            ...(env.resolvedId !== undefined
              ? { resolvedId: env.resolvedId }
              : {}),
          };
          target = await env.auditTarget(targetEnv);
        } catch (targetError) {
          // The audit row must still be written — fall back to a synthetic
          // target, but a broken auditTarget builder is a server bug and
          // must be visible in the logs.
          deps.logger.error(
            {
              action: env.contract.name,
              request_id: env.request.requestId,
              err: targetError,
            },
            "auditTarget callback failed during failure recording — audit row falls back to a synthetic target",
          );
        }
      }

      const inputHash = hashInput(env.input);

      await deps.db.transaction(async (tx) => {
        await insertAuditRow(tx, {
          requestId: env.request.requestId,
          correlationId: env.request.correlationId,
          action: env.contract.name,
          actorType: identity.actorType,
          actorId: identity.actorId,
          channel: env.request.channel,
          aiTraceId: env.request.aiTraceId,
          toolCallId: env.request.toolCallId,
          companyId: identity.companyId,
          target: target ?? { type: "unknown", id: "unknown" },
          inputHash,
          inputSnapshot: null,
          outcome: env.error.code,
          durationMs: env.durationMs,
        });
      });
    },
  };
}

interface AuditRowInput {
  readonly requestId: string;
  readonly correlationId: string;
  readonly action: string;
  readonly actorType: "user" | "system";
  readonly actorId: string;
  readonly channel: ActionChannel;
  readonly aiTraceId: string | undefined;
  readonly toolCallId: string | undefined;
  readonly companyId: string | null;
  readonly target: AuditTargetRef;
  readonly inputHash: string;
  readonly inputSnapshot: JsonValue | null;
  readonly outcome: string;
  readonly durationMs: number;
}

async function insertAuditRow(tx: Tx, row: AuditRowInput): Promise<void> {
  await tx.insert(auditLog).values({
    requestId: row.requestId,
    correlationId: row.correlationId,
    action: row.action,
    actorType: row.actorType,
    actorId: row.actorId,
    channel: row.channel,
    aiTraceId: row.aiTraceId ?? null,
    toolCallId: row.toolCallId ?? null,
    companyId: row.companyId,
    targetType: row.target.type,
    targetId: row.target.id,
    inputHash: row.inputHash,
    inputSnapshot: row.inputSnapshot,
    outcome: row.outcome,
    durationMs: row.durationMs,
  });
}

function hashInput(input: unknown): string {
  return canonicalJsonSha256OfUnknown(input);
}

function resolveFailureIdentity(
  principal: PrincipalInvocation,
  authorization: PreflightAuthorization | undefined,
): {
  actorType: "user" | "system";
  actorId: string;
  companyId: string | null;
} {
  if (authorization !== undefined) {
    return toAuditActor(
      authorization.actor,
      authorization.companyId,
      principal.mode === "share",
    );
  }
  switch (principal.mode) {
    case "system":
      return {
        actorType: "system",
        actorId: principal.serviceName,
        companyId:
          principal.scope.scope === "tenant" ? principal.scope.companyId : null,
      };
    case "staff":
    case "customer":
    case "consumer":
    case "account":
      if (principal.session !== null) {
        return {
          actorType: "user",
          actorId: principal.session.userId,
          companyId: null,
        };
      }
      return { actorType: "user", actorId: "unknown", companyId: null };
    case "share":
      return {
        actorType: SHARE_DURABLE_ACTOR.type,
        actorId: SHARE_DURABLE_ACTOR.id,
        companyId: null,
      };
    case "public":
      return { actorType: "user", actorId: "unknown", companyId: null };
  }
}

function toAuditActor(
  actor: ActionActor,
  companyId: string | null,
  isShare = false,
): { actorType: "user" | "system"; actorId: string; companyId: string | null } {
  if (isShare) {
    return {
      actorType: SHARE_DURABLE_ACTOR.type,
      actorId: SHARE_DURABLE_ACTOR.id,
      companyId,
    };
  }
  if (actor.type === "anonymous") {
    throw new CoreInvariantError(
      "audit row cannot record anonymous actor — public-global actions must declare audit: false",
    );
  }
  return { actorType: actor.type, actorId: actor.id, companyId };
}
