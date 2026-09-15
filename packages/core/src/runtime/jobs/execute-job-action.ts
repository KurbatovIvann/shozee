import { companies, type Tx } from "@showzy/db";
import { eq } from "drizzle-orm";
import type { z } from "zod";

import { moduleOf } from "../../contract/module-of.js";
import { CoreInvariantError, NotFoundError } from "../../errors/index.js";
import type { AnyActionContract } from "../action-registry.js";
import type { SystemScopeInput } from "../context/factories.js";
import type { ImplementedAction } from "../implement-action.js";
import { UUID_PATTERN } from "../patterns.js";
import { executeAction } from "../pipeline/execute-action.js";
import type {
  ActionPipelineDeps,
  PipelineRequestMeta,
} from "../pipeline/types.js";
import type { JobEnvelope } from "./enqueue.js";

export interface JobActionInvocation<
  TInput extends z.ZodType,
  TOutput extends z.ZodType,
  TTarget,
> {
  readonly envelope: JobEnvelope;
  readonly action: ImplementedAction<TInput, TOutput, TTarget>;
  readonly input: unknown;
  readonly fanOutCompanyId?: string;
}

export async function executeJobAction<
  TInput extends z.ZodType,
  TOutput extends z.ZodType,
  TTarget,
>(
  deps: ActionPipelineDeps,
  invocation: JobActionInvocation<TInput, TOutput, TTarget>,
): Promise<z.output<TOutput>> {
  const { envelope, action } = invocation;
  const { contract } = action;
  assertRunnableByJob(envelope, contract);
  const scope = recordedScope(invocation);
  const request: PipelineRequestMeta = {
    requestId: envelope.requestId,
    correlationId: envelope.correlationId,
    causationId: envelope.id,
    channel: envelope.channel,
    ...(contract.idempotent ? { idempotencyKey: envelope.id } : {}),
  };
  return await deps.db.transaction(async (tx) => {
    if (scope.scope === "tenant") {
      await lockRecordedCompany(tx, scope.companyId, envelope, contract);
    }
    return await executeAction(
      { ...deps, db: tx },
      {
        action,
        input: invocation.input,
        request,
        principal: { mode: "system", serviceName: envelope.name, scope },
      },
    );
  });
}

function assertRunnableByJob(
  envelope: JobEnvelope,
  contract: AnyActionContract,
): void {
  const refusal = jobRefusal(envelope, contract);
  if (refusal !== undefined) {
    throw new CoreInvariantError(
      `job "${envelope.name}" cannot run "${contract.name}": ${refusal}`,
    );
  }
}

function jobRefusal(
  envelope: JobEnvelope,
  contract: AnyActionContract,
): string | undefined {
  if (contract.principal !== "system") {
    return `a job runs system actions only; a ${contract.principal} action keeps its own invocation path`;
  }
  if (moduleOf(contract.name) !== moduleOf(envelope.name)) {
    return `a job runs actions of its own module "${moduleOf(envelope.name)}"`;
  }
  if (contract.risk === "read") {
    return "a job runs mutations; a read runs through ctx.call inside one";
  }
  if ((contract.enqueues ?? []).length > 0 && !contract.idempotent) {
    return "an action that enqueues from a job must be idempotent, so a retry derives the same job ids from the job id";
  }
  return undefined;
}

function recordedScope<
  TInput extends z.ZodType,
  TOutput extends z.ZodType,
  TTarget,
>(invocation: JobActionInvocation<TInput, TOutput, TTarget>): SystemScopeInput {
  const { envelope, fanOutCompanyId } = invocation;
  if (envelope.companyId !== null) {
    if (fanOutCompanyId !== undefined) {
      throw new CoreInvariantError(
        `tenant job "${envelope.name}" cannot fan out to company ${fanOutCompanyId} — it runs only in its recorded company`,
      );
    }
    return { scope: "tenant", companyId: envelope.companyId };
  }
  return fanOutCompanyId === undefined
    ? { scope: "global" }
    : { scope: "tenant", companyId: fanOutCompanyId };
}

async function lockRecordedCompany(
  tx: Tx,
  companyId: string,
  envelope: JobEnvelope,
  contract: AnyActionContract,
): Promise<void> {
  if (!UUID_PATTERN.test(companyId)) {
    throw new CoreInvariantError(
      `job ${envelope.id} ("${envelope.name}") ran "${contract.name}" with a malformed companyId`,
    );
  }
  const rows = await tx
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.id, companyId))
    .for("key share");
  if (rows.length === 0) {
    throw new NotFoundError(undefined, {
      internalMessage: `job ${envelope.id} ("${envelope.name}") ran "${contract.name}" for company ${companyId}, which does not exist`,
    });
  }
}
