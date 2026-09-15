import type { z } from "zod";

import { moduleOf } from "../contract/module-of.js";
import { isCoreJobField, isCoreJobPayload } from "./job-payload.js";

export type JobScope = "tenant" | "global";

export type JobLifecycle = "expires" | "periodic";

export interface JobDefinition<TPayload extends z.ZodObject = z.ZodObject> {
  readonly name: string;
  readonly scope: JobScope;
  readonly payload: TPayload;
  readonly discriminator: readonly string[];
  readonly lifecycle: JobLifecycle;
  readonly onExhausted?: string;
  readonly retries: number;
  readonly attemptTimeoutMs: number;
  readonly cron?: string;
}

declare const jobBrand: unique symbol;

export type Job<TPayload extends z.ZodObject = z.ZodObject> = Readonly<
  JobDefinition<TPayload>
> & {
  readonly [jobBrand]: true;
};

export class JobDefinitionError extends Error {
  readonly jobName: string;
  readonly problems: readonly string[];

  constructor(jobName: string, problems: readonly string[]) {
    const details = problems.map((problem) => `  - ${problem}`).join("\n");
    super(`Invalid job definition "${jobName}":\n${details}`);
    this.name = "JobDefinitionError";
    this.jobName = jobName;
    this.problems = problems;
  }
}

const QUALIFIED_NAME_PATTERN = /^[a-z][a-zA-Z0-9]*\.[a-z][a-zA-Z0-9]*$/;

const CRON_FIELD_COUNTS: ReadonlySet<number> = new Set([5, 6]);

export function defineJob<const T extends JobDefinition>(
  definition: T,
): Job<T["payload"]> & Readonly<T> {
  const problems = collectJobDefinitionProblems(definition);
  if (problems.length > 0) {
    throw new JobDefinitionError(definition.name, problems);
  }
  return Object.freeze({ ...definition }) as Job<T["payload"]> & Readonly<T>;
}

function collectJobDefinitionProblems(definition: JobDefinition): string[] {
  const problems: string[] = [];
  const { name } = definition;

  if (!QUALIFIED_NAME_PATTERN.test(name)) {
    problems.push(
      `name "${name}" must be "<module>.<name>" with camelCase segments (e.g. "assistant.runTurn")`,
    );
  }
  validatePayload(definition, problems);
  if (!Number.isInteger(definition.retries) || definition.retries < 0) {
    problems.push("retries must be a non-negative integer");
  }
  if (
    !Number.isInteger(definition.attemptTimeoutMs) ||
    definition.attemptTimeoutMs <= 0
  ) {
    problems.push(
      "attemptTimeoutMs must be a positive integer of milliseconds",
    );
  }
  if (definition.lifecycle === "expires") {
    validateExpiring(definition, problems);
  } else {
    validatePeriodic(definition, problems);
  }
  return problems;
}

function validatePayload(definition: JobDefinition, problems: string[]): void {
  if (!isCoreJobPayload(definition.payload)) {
    problems.push(
      "payload must be built by jobPayload from jobField constructors — payloads are identity only (ADR-0041 J6)",
    );
    return;
  }
  const shape: Readonly<Record<string, unknown>> = definition.payload.shape;
  for (const [field, schema] of Object.entries(shape)) {
    if (!isCoreJobField(schema)) {
      problems.push(
        `payload field "${field}" must be a jobField (uuid, enum, literal, integer) used as built — payloads are identity only (ADR-0041 J6)`,
      );
    }
  }
  for (const key of definition.discriminator) {
    if (!(key in shape)) {
      problems.push(`discriminator "${key}" is not a payload field`);
    }
  }
  if (
    new Set(definition.discriminator).size !== definition.discriminator.length
  ) {
    problems.push("discriminator must not contain duplicates");
  }
}

function validateExpiring(definition: JobDefinition, problems: string[]): void {
  const { onExhausted } = definition;
  if (onExhausted === undefined) {
    problems.push(
      'lifecycle "expires" requires onExhausted, the system action that ends the owning row',
    );
  } else if (!QUALIFIED_NAME_PATTERN.test(onExhausted)) {
    problems.push(
      `onExhausted "${onExhausted}" must be an action name "<module>.<verb>"`,
    );
  } else if (
    QUALIFIED_NAME_PATTERN.test(definition.name) &&
    moduleOf(onExhausted) !== moduleOf(definition.name)
  ) {
    problems.push(
      `onExhausted "${onExhausted}" must belong to this job's module "${moduleOf(definition.name)}"`,
    );
  }
  if (definition.cron !== undefined) {
    problems.push('cron is allowed only on lifecycle "periodic"');
  }
}

function validatePeriodic(definition: JobDefinition, problems: string[]): void {
  const { cron } = definition;
  if (
    cron === undefined ||
    !CRON_FIELD_COUNTS.has(cron.trim().split(/\s+/).length)
  ) {
    problems.push(
      'lifecycle "periodic" requires cron, a 5- or 6-field cron expression',
    );
  }
  if (definition.onExhausted !== undefined) {
    problems.push(
      'onExhausted is allowed only on lifecycle "expires" — a periodic run has no owning row',
    );
  }
}
