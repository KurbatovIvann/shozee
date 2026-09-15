import type { z } from "zod";

import { moduleOf } from "../../contract/module-of.js";
import { CoreInvariantError } from "../../errors/index.js";
import type { Job } from "../../jobs/define-job.js";
import type { AnyActionContract } from "../action-registry.js";
import type { SystemScopeInput } from "../context/factories.js";
import type { ImplementedAction } from "../implement-action.js";
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
  readonly job: Job;
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
  refuseUnlessRunnable(invocation.job, envelope, contract);
  const request: PipelineRequestMeta = {
    requestId: envelope.requestId,
    correlationId: envelope.correlationId,
    causationId: envelope.id,
    channel: envelope.channel,
    ...(contract.idempotent ? { idempotencyKey: envelope.id } : {}),
  };
  return await executeAction(deps, {
    action,
    input: invocation.input,
    request,
    principal: {
      mode: "system",
      serviceName: envelope.name,
      scope: recordedScope(invocation),
      companyMustExist: true,
    },
  });
}

function refuseUnlessRunnable(
  job: Job,
  envelope: JobEnvelope,
  contract: AnyActionContract,
): void {
  const refusal =
    envelopeRefusal(job, envelope) ?? actionRefusal(envelope, contract);
  if (refusal !== undefined) {
    throw new CoreInvariantError(
      `job ${envelope.id} ("${envelope.name}") cannot run "${contract.name}": ${refusal}`,
    );
  }
}

function envelopeRefusal(job: Job, envelope: JobEnvelope): string | undefined {
  if (envelope.name !== job.name) {
    return `the envelope names job "${envelope.name}", not the declared job "${job.name}"`;
  }
  if ((envelope.companyId === null) !== (job.scope === "global")) {
    return `a ${job.scope} job's envelope must ${job.scope === "global" ? "carry no company" : "carry its recorded company"}`;
  }
  return undefined;
}

function actionRefusal(
  envelope: JobEnvelope,
  contract: AnyActionContract,
): string | undefined {
  if (contract.principal !== "system") {
    return `a job runs system actions only; a ${contract.principal} action keeps its own invocation path`;
  }
  if (moduleOf(contract.name) !== moduleOf(envelope.name)) {
    return `a job runs actions of its own module "${moduleOf(envelope.name)}"`;
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
  const { job, envelope, fanOutCompanyId } = invocation;
  if (fanOutCompanyId === undefined) {
    return envelope.companyId === null
      ? { scope: "global" }
      : { scope: "tenant", companyId: envelope.companyId };
  }
  if (job.scope !== "global" || job.lifecycle !== "periodic") {
    throw new CoreInvariantError(
      `job ${envelope.id} ("${envelope.name}") cannot fan out to company ${fanOutCompanyId}: only a global periodic job fans out tenant work`,
    );
  }
  return { scope: "tenant", companyId: fanOutCompanyId };
}
