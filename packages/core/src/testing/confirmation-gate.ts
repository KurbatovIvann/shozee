import { randomUUID } from "node:crypto";

import type { z } from "zod";

import { ConfirmationRequiredError } from "../errors/index.js";
import type { ImplementedAction } from "../runtime/implement-action.js";
import type { PipelineRequestMeta } from "../runtime/pipeline/types.js";
import {
  invokeAction,
  type InvokeOptions,
  type IsolationActor,
  type TestKit,
} from "./kit.js";

export async function challengeIdFor(
  actionName: string,
  attempt: Promise<unknown>,
): Promise<string> {
  const outcome = await attempt.then(
    () => ({ confirmed: true }) as const,
    (error: unknown) => ({ confirmed: false, error }) as const,
  );
  if (outcome.confirmed) {
    throw new Error(
      `expected "${actionName}" to answer the first invocation with a confirmation card`,
    );
  }
  if (outcome.error instanceof ConfirmationRequiredError) {
    return outcome.error.challenge.challengeId;
  }
  throw outcome.error;
}

export async function confirmedRequest<
  TInput extends z.ZodType,
  TOutput extends z.ZodType,
  TTarget = unknown,
>(
  kit: TestKit,
  action: ImplementedAction<TInput, TOutput, TTarget>,
  input: unknown,
  actor: IsolationActor = {},
  options: InvokeOptions = {},
): Promise<Partial<PipelineRequestMeta>> {
  const request: Partial<PipelineRequestMeta> = {
    idempotencyKey: randomUUID(),
    ...options.request,
  };
  const challengeId = await challengeIdFor(
    action.contract.name,
    invokeAction(kit, action, input, actor, {
      ...options,
      request: { ...request, requestId: randomUUID() },
    }),
  );
  return { ...request, confirmationChallengeId: challengeId };
}

export async function invokeConfirmedAction<
  TInput extends z.ZodType,
  TOutput extends z.ZodType,
  TTarget = unknown,
>(
  kit: TestKit,
  action: ImplementedAction<TInput, TOutput, TTarget>,
  input: unknown,
  actor: IsolationActor = {},
  options: InvokeOptions = {},
): Promise<z.output<TOutput>> {
  const request = await confirmedRequest(kit, action, input, actor, options);
  return await invokeAction(kit, action, input, actor, {
    ...options,
    request,
  });
}
