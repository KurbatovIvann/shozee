import {
  executeJobAction,
  type ActionPipelineDeps,
  type ImplementedAction,
  type Job,
  type JobEnvelope,
} from "@showzy/core";
import { CoreError, CoreInvariantError } from "@showzy/core/errors";
import type { JobResult, JobWithMetadata, PgBoss } from "pg-boss";
import { z } from "zod";

import { storedJobDataSchema } from "./pgboss-job-port.js";
import { exhaustedQueueName } from "./queue-provisioning.js";

export type JobFailureCode =
  CoreError["code"] | "ATTEMPT_TIMEOUT" | "DRAINED" | "ABORTED";

type ZodSchema = ImplementedAction["contract"]["output"];

export interface JobAttempt {
  readonly envelope: JobEnvelope;
  readonly signal: AbortSignal;
  run<TInput extends ZodSchema, TOutput extends ZodSchema, TTarget>(
    action: ImplementedAction<TInput, TOutput, TTarget>,
    input: unknown,
    fanOutCompanyId?: string,
  ): ReturnType<typeof executeJobAction<TInput, TOutput, TTarget>>;
}

export type JobExhaustedHook = (settled: {
  readonly envelope: JobEnvelope;
  readonly output: unknown;
}) => Promise<void>;

export interface JobHandler {
  readonly job: Job;
  readonly onExhausted?: ImplementedAction;
  readonly afterExhausted?: JobExhaustedHook;
  handle(attempt: JobAttempt): Promise<void>;
}

export interface JobWorkerOptions {
  readonly deps: ActionPipelineDeps;
  readonly handlers: readonly JobHandler[];
  readonly drainTimeoutMs: number;
}

export interface JobWorker {
  drain(): Promise<void>;
}

type StoredJob = JobWithMetadata<unknown>;

const drainSettleMs = 5_000;

export async function createJobWorker(
  boss: PgBoss,
  declared: readonly Job[],
  options: JobWorkerOptions,
  pollingIntervalSeconds = 2,
): Promise<JobWorker> {
  assertHandlersMatchDeclarations(declared, options.handlers);
  const { deps } = options;
  const running = new Set<(code: JobFailureCode) => void>();

  async function settle(
    stored: StoredJob,
    timeoutMs: number,
    body: (signal: AbortSignal) => Promise<unknown>,
  ): Promise<JobResult> {
    const controller = new AbortController();
    let abandon: (code: JobFailureCode) => void = () => undefined;
    const abandoned = new Promise<JobFailureCode>((resolve) => {
      abandon = (code) => {
        resolve(code);
        controller.abort();
        deps.logger.warn(
          { job: stored.name, jobId: stored.id, code },
          "job attempt abandoned",
        );
      };
    });
    const onRunnerAbort = (): void => {
      abandon("ABORTED");
    };
    stored.signal.addEventListener("abort", onRunnerAbort, { once: true });
    const timer = setTimeout(() => {
      abandon("ATTEMPT_TIMEOUT");
    }, timeoutMs);
    running.add(abandon);
    const finished = Promise.resolve()
      .then(() => body(controller.signal))
      .then(
        () => undefined,
        (error: unknown) => {
          const code = failureCodeOf(error);
          deps.logger.error(
            { err: error, job: stored.name, jobId: stored.id, code },
            "job attempt failed",
          );
          return code;
        },
      );
    try {
      const code = await Promise.race([finished, abandoned]);
      return code === undefined
        ? { id: stored.id, status: "completed" }
        : { id: stored.id, status: "failed", output: { code } };
    } finally {
      clearTimeout(timer);
      running.delete(abandon);
      stored.signal.removeEventListener("abort", onRunnerAbort);
    }
  }

  async function work(
    name: string,
    localConcurrency: number,
    attempt: (stored: StoredJob) => Promise<JobResult>,
  ): Promise<void> {
    const workOptions = {
      perJobResults: true,
      includeMetadata: true,
      batchSize: 1,
      localConcurrency,
      pollingIntervalSeconds,
    } as const;
    await boss.work<unknown, unknown, typeof workOptions>(
      name,
      workOptions,
      (jobs) => Promise.all(jobs.map((stored) => attempt(stored))),
    );
  }

  for (const handler of options.handlers) {
    const { job, onExhausted, afterExhausted } = handler;
    if (onExhausted !== undefined) {
      await work(exhaustedQueueName(job), job.concurrency, (stored) =>
        settle(stored, job.attemptTimeoutMs, async () => {
          const envelope = recordedEnvelope(job, stored);
          const output = await executeJobAction(deps, {
            job,
            envelope,
            action: onExhausted,
            input: envelope.payload,
          });
          if (afterExhausted !== undefined) {
            await afterExhausted({ envelope, output });
          }
        }),
      );
    }
    await work(job.name, job.concurrency, (stored) =>
      settle(stored, job.attemptTimeoutMs, (signal) =>
        handler.handle(
          attemptFor(deps, job, recordedEnvelope(job, stored), signal),
        ),
      ),
    );
    if (job.lifecycle === "periodic" && job.cron !== undefined) {
      await boss.schedule(job.name, job.cron, null, { tz: "UTC" });
    }
  }

  return {
    async drain() {
      const bound = setTimeout(() => {
        for (const abandon of running) {
          abandon("DRAINED");
        }
      }, options.drainTimeoutMs);
      try {
        await boss.stop({
          close: false,
          timeout: options.drainTimeoutMs + drainSettleMs,
        });
      } finally {
        clearTimeout(bound);
      }
    },
  };
}

function attemptFor(
  deps: ActionPipelineDeps,
  job: Job,
  envelope: JobEnvelope,
  signal: AbortSignal,
): JobAttempt {
  return {
    envelope,
    signal,
    run: async (action, input, fanOutCompanyId) => {
      if (signal.aborted) {
        throw new CoreInvariantError(
          `job ${envelope.id} ("${job.name}") was abandoned; its attempt starts no further action "${action.contract.name}"`,
        );
      }
      return await executeJobAction(deps, {
        job,
        envelope,
        action,
        input,
        ...(fanOutCompanyId === undefined ? {} : { fanOutCompanyId }),
      });
    },
  };
}

function recordedEnvelope(job: Job, stored: StoredJob): JobEnvelope {
  const id = stored.sourceId ?? stored.id;
  if (job.lifecycle === "periodic") {
    return {
      id,
      name: job.name,
      companyId: null,
      actor: { type: "system", id: job.name },
      channel: "system",
      requestId: id,
      correlationId: id,
      executionId: id,
      payload: {},
    };
  }
  if (stored.data === null) {
    throw new CoreInvariantError(
      `job ${id} ("${job.name}") has no recorded envelope`,
    );
  }
  const recorded = storedJobDataSchema.safeParse(stored.data);
  if (!recorded.success) {
    throw new CoreInvariantError(
      `job ${id} ("${job.name}") has a malformed recorded envelope: ${z.prettifyError(recorded.error)}`,
    );
  }
  return { ...recorded.data, id, name: job.name };
}

function failureCodeOf(error: unknown): JobFailureCode {
  return error instanceof CoreError ? error.code : "INTERNAL";
}

function assertHandlersMatchDeclarations(
  declared: readonly Job[],
  handlers: readonly JobHandler[],
): void {
  const declaredNames = new Set(declared.map(({ name }) => name));
  const seen = new Set<string>();
  const problems: string[] = [];
  for (const { job, onExhausted, afterExhausted } of handlers) {
    if (!declaredNames.has(job.name)) {
      problems.push(`job "${job.name}" is not a declared job of this runner`);
    } else if (!declared.includes(job)) {
      problems.push(
        `job "${job.name}" binds a definition other than the declared one`,
      );
    }
    if (seen.has(job.name)) {
      problems.push(`job "${job.name}" has more than one handler`);
    }
    seen.add(job.name);
    if (onExhausted?.contract.name !== job.onExhausted) {
      problems.push(
        `job "${job.name}" declares on-exhausted "${job.onExhausted ?? "none"}" but its handler binds "${onExhausted?.contract.name ?? "none"}"`,
      );
    }
    if (afterExhausted !== undefined && onExhausted === undefined) {
      problems.push(
        `job "${job.name}" binds a post-exhaustion hook without an on-exhausted action`,
      );
    }
    if (job.lifecycle === "periodic" && job.scope !== "global") {
      problems.push(
        `periodic job "${job.name}" must be global: a schedule records no company`,
      );
    }
  }
  for (const { name } of declared) {
    if (!seen.has(name)) {
      problems.push(`declared job "${name}" has no handler`);
    }
  }
  if (problems.length > 0) {
    throw new CoreInvariantError(
      `job handlers do not match their declarations:\n${problems.join("\n")}`,
    );
  }
}
