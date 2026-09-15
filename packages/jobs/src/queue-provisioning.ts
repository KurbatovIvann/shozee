import type { Job } from "@showzy/core";
import { CoreInvariantError } from "@showzy/core/errors";
import type { PgBoss, Queue } from "pg-boss";

export const runnerRetentionSeconds = 24 * 60 * 60;

export const attemptExpiryMarginSeconds = 5;

export interface QueueSettings {
  readonly policy: "standard";
  readonly partition: false;
  readonly notify: false;
  readonly retryLimit: number;
  readonly retryDelay: 0;
  readonly retryBackoff: false;
  readonly retryDelayMax: null;
  readonly expireInSeconds: number;
  readonly retentionSeconds: number;
  readonly deleteAfterSeconds: number;
  readonly heartbeatSeconds: null;
  readonly deadLetter: string | null;
}

export interface QueueDeclaration {
  readonly name: string;
  readonly settings: QueueSettings;
}

const comparedSettings = [
  "policy",
  "partition",
  "notify",
  "retryLimit",
  "retryDelay",
  "retryBackoff",
  "retryDelayMax",
  "expireInSeconds",
  "retentionSeconds",
  "deleteAfterSeconds",
  "heartbeatSeconds",
  "deadLetter",
] as const satisfies readonly (keyof QueueSettings)[];

export function exhaustedQueueName(job: Job): string {
  return `${job.name}.exhausted`;
}

export function queueDeclarations(
  jobs: readonly Job[],
): readonly QueueDeclaration[] {
  return jobs.flatMap((job): QueueDeclaration[] => {
    const base = {
      policy: "standard",
      partition: false,
      notify: false,
      retryDelay: 0,
      retryBackoff: false,
      retryDelayMax: null,
      expireInSeconds:
        Math.ceil(job.attemptTimeoutMs / 1000) + attemptExpiryMarginSeconds,
      retentionSeconds: runnerRetentionSeconds,
      deleteAfterSeconds: runnerRetentionSeconds,
      heartbeatSeconds: null,
    } as const;
    if (job.lifecycle === "periodic") {
      return [
        {
          name: job.name,
          settings: { ...base, retryLimit: job.retries, deadLetter: null },
        },
      ];
    }
    const deadLetter = exhaustedQueueName(job);
    return [
      {
        name: deadLetter,
        settings: { ...base, retryLimit: 0, deadLetter: null },
      },
      {
        name: job.name,
        settings: { ...base, retryLimit: job.retries, deadLetter },
      },
    ];
  });
}

function createOptions(settings: QueueSettings): Omit<Queue, "name"> {
  return {
    policy: settings.policy,
    partition: settings.partition,
    notify: settings.notify,
    retryLimit: settings.retryLimit,
    retryDelay: settings.retryDelay,
    retryBackoff: settings.retryBackoff,
    expireInSeconds: settings.expireInSeconds,
    retentionSeconds: settings.retentionSeconds,
    deleteAfterSeconds: settings.deleteAfterSeconds,
    ...(settings.deadLetter === null
      ? {}
      : { deadLetter: settings.deadLetter }),
  };
}

export async function provisionQueues(
  boss: PgBoss,
  declarations: readonly QueueDeclaration[],
): Promise<void> {
  for (const { name, settings } of declarations) {
    if ((await boss.getQueue(name)) === null) {
      await boss.createQueue(name, createOptions(settings));
    }
  }
}

export async function assertQueuesMatchDeclarations(
  boss: PgBoss,
  declarations: readonly QueueDeclaration[],
): Promise<void> {
  if (declarations.length === 0) {
    return;
  }
  const stored = new Map(
    (await boss.getQueues(declarations.map(({ name }) => name))).map(
      (queue) => [queue.name, queue],
    ),
  );
  const problems: string[] = [];
  for (const { name, settings } of declarations) {
    const queue = stored.get(name);
    if (queue === undefined) {
      problems.push(`queue "${name}" is not provisioned`);
      continue;
    }
    for (const key of comparedSettings) {
      const actual = queue[key] ?? null;
      if (actual !== settings[key]) {
        problems.push(
          `queue "${name}" ${key}: stored ${String(actual)}, declared ${String(settings[key])}`,
        );
      }
    }
  }
  if (problems.length > 0) {
    throw new CoreInvariantError(
      `pg-boss queues do not match their job declarations; the runner refuses to boot (ADR-0041 J7):\n${problems.join("\n")}`,
    );
  }
}
