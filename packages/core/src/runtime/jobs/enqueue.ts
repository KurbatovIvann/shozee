import type { Tx } from "@showzy/db";

import { CoreInvariantError } from "../../errors/index.js";
import type { Job } from "../../jobs/define-job.js";
import type { AnyActionContract } from "../action-registry.js";
import { canonicalJsonSha256OfUnknown } from "../audit/canonical-json.js";
import { effectiveCompanyId } from "../context/factories.js";
import {
  SHARE_DURABLE_ACTOR,
  type ActionChannel,
  type ActionCtx,
  type CtxEnqueue,
} from "../context/types.js";
import {
  deriveJobId,
  jobDiscriminatorValues,
  type JobOrigin,
} from "./job-identity.js";

export interface JobEnvelope {
  readonly id: string;
  readonly name: string;
  readonly companyId: string | null;
  readonly actor: {
    readonly type: "user" | "system";
    readonly id: string;
  };
  readonly channel: ActionChannel;
  readonly requestId: string;
  readonly correlationId: string;
  readonly executionId: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface JobPort {
  enqueue(tx: Tx, envelopes: readonly JobEnvelope[]): Promise<void>;
}

interface BufferedJob {
  readonly job: Job;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface EnqueueBuffer {
  readonly executionId: string;
  readonly enqueue: CtxEnqueue;
  flush(env: {
    readonly tx: Tx;
    readonly ctx: ActionCtx;
    readonly origin: JobOrigin;
    readonly port: JobPort | undefined;
  }): Promise<void>;
}

export function rejectNestedEnqueue(calleeName: string): CtxEnqueue {
  return (job) => {
    throw new CoreInvariantError(
      `nested callee "${calleeName}" called ctx.enqueue("${job.name}") — only the root action of a transaction enqueues jobs (ADR-0041 J4)`,
    );
  };
}

export function createEnqueueBuffer(options: {
  readonly contract: AnyActionContract;
  readonly executionId: string;
}): EnqueueBuffer {
  const { contract, executionId } = options;
  const buffered: BufferedJob[] = [];
  const sendKeys = new Set<string>();
  let sealed = false;

  const enqueue: CtxEnqueue = (definition, payload) => {
    const job: Job = definition;
    if (sealed) {
      throw new CoreInvariantError(
        `"${contract.name}" called ctx.enqueue after its job flush — jobs are enqueued only while the handler runs`,
      );
    }
    if (contract.risk === "read") {
      throw new CoreInvariantError(
        `read action "${contract.name}" cannot enqueue jobs — a read-only transaction cannot write a job (ADR-0041 J4)`,
      );
    }
    if (!(contract.enqueues ?? []).includes(job.name)) {
      throw new CoreInvariantError(
        `action "${contract.name}" enqueued undeclared job "${job.name}" — every enqueued job must be listed in the contract's enqueues (ADR-0041 J4)`,
      );
    }
    const parsed = job.payload.safeParse(payload);
    if (!parsed.success) {
      throw new CoreInvariantError(
        `payload of job "${job.name}" enqueued by "${contract.name}" failed the job's schema: ${JSON.stringify(parsed.error.issues)}`,
      );
    }
    const sendKey = `${job.name}\0${canonicalJsonSha256OfUnknown(jobDiscriminatorValues(job, parsed.data))}`;
    if (sendKeys.has(sendKey)) {
      throw new CoreInvariantError(
        job.discriminator.length === 0
          ? `"${contract.name}" enqueued job "${job.name}" twice — fanning a job out requires a discriminator (ADR-0041 J2)`
          : `"${contract.name}" enqueued job "${job.name}" twice with the same discriminator — two sends with one job id (ADR-0041 J2)`,
      );
    }
    sendKeys.add(sendKey);
    buffered.push({ job, payload: parsed.data });
  };

  return {
    executionId,
    enqueue,
    async flush({ tx, ctx, origin, port }) {
      sealed = true;
      if (buffered.length === 0) {
        return;
      }
      if (port === undefined) {
        throw new CoreInvariantError(
          `"${contract.name}" enqueued jobs but no job port is composed`,
        );
      }
      const actor = ctx.principal === "share" ? SHARE_DURABLE_ACTOR : ctx.actor;
      if (actor.type === "anonymous") {
        throw new CoreInvariantError(
          `"${contract.name}" flushed jobs with an anonymous actor — job envelopes accept user/system actors only`,
        );
      }
      const envelopes = buffered.map(({ job, payload }): JobEnvelope => {
        const companyId = jobCompanyId(contract.name, job, ctx);
        return {
          id: deriveJobId({ job, companyId, origin, payload }),
          name: job.name,
          companyId,
          actor: { type: actor.type, id: actor.id },
          channel: ctx.channel,
          requestId: ctx.requestId,
          correlationId: ctx.correlationId,
          executionId,
          payload,
        };
      });
      await port.enqueue(tx, envelopes);
    },
  };
}

function jobCompanyId(
  actionName: string,
  job: Job,
  ctx: ActionCtx,
): string | null {
  if (job.scope === "global") {
    return null;
  }
  const companyId = effectiveCompanyId(ctx);
  if (companyId === null) {
    throw new CoreInvariantError(
      `"${actionName}" enqueued tenant-scope job "${job.name}" without a company scope — tenant jobs require a verified companyId (ADR-0041 J5)`,
    );
  }
  return companyId;
}
