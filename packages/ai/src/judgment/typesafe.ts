import {
  APIError,
  APITimeoutError,
  APIUserAbortError,
  RateLimitError,
  TypeSafeClient,
} from "@typesafe-ai/sdk";
import { z } from "zod";

import type {
  JudgmentAnswer,
  JudgmentAnswers,
  JudgmentAskOptions,
  JudgmentProvider,
  JudgmentQuestion,
  JudgmentQuestions,
  JudgmentRefused,
  JudgmentRequest,
  JudgmentResult,
} from "./types.js";

export const TYPESAFE_JUDGMENT_PROVIDER_ID = "typesafe";
export const TYPESAFE_BASE_URL = "https://api.typesafe.ai";
export const TYPESAFE_ATTEMPT_TIMEOUT_MS = 3000;
export const TYPESAFE_DEADLINE_MS = 5000;
export const TYPESAFE_MAX_RETRIES = 1;
export const TYPESAFE_OVERLOADED_STATUS = 529;

export type TypeSafeFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export interface TypeSafeJudgmentProviderOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly fetch?: TypeSafeFetch;
  readonly attemptTimeoutMs?: number;
  readonly deadlineMs?: number;
  readonly maxRetries?: number;
}

const probability = z.number().min(0).max(1);

const rawAnswerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("noul"), noul: probability }),
  z.object({
    type: z.literal("choice"),
    choice: z.string(),
    confidence: probability,
    probabilities: z.record(z.string(), probability),
  }),
  z.object({
    type: z.literal("score"),
    score: z.number(),
    confidence: probability,
    probabilities: z.record(z.string(), probability),
  }),
]);

function toAnswer(
  question: JudgmentQuestion,
  raw: unknown,
): JudgmentAnswer | undefined {
  const parsed = rawAnswerSchema.safeParse(raw);
  if (!parsed.success) {
    return undefined;
  }
  const answer = parsed.data;
  if (question.type === "noul") {
    return answer.type === "noul"
      ? { type: "noul", probability: answer.noul }
      : undefined;
  }
  if (question.type === "choice") {
    if (
      answer.type !== "choice" ||
      !Object.hasOwn(question.criteria, answer.choice)
    ) {
      return undefined;
    }
    return {
      type: "choice",
      choice: answer.choice,
      confidence: answer.confidence,
      probabilities: answer.probabilities,
    };
  }
  if (answer.type !== "score") {
    return undefined;
  }
  const probabilities: number[] = [];
  for (let level = 0; level < question.criteria.length; level += 1) {
    const value = answer.probabilities[String(level)];
    if (value === undefined) {
      return undefined;
    }
    probabilities.push(value);
  }
  return {
    type: "score",
    score: answer.score,
    confidence: answer.confidence,
    probabilities,
  };
}

function toAnswers<Q extends JudgmentQuestions>(
  questions: Q,
  raw: Readonly<Record<string, unknown>>,
): JudgmentAnswers<Q> | undefined {
  const answers: Record<string, JudgmentAnswer> = {};
  for (const [name, question] of Object.entries(questions)) {
    const answer = toAnswer(question, raw[name]);
    if (answer === undefined) {
      return undefined;
    }
    answers[name] = answer;
  }
  return answers as JudgmentAnswers<Q>;
}

function refusalFromError(error: unknown): JudgmentRefused {
  if (error instanceof APITimeoutError || error instanceof APIUserAbortError) {
    return { ok: false, reason: "timeout" };
  }
  if (error instanceof APIError) {
    const reason =
      error instanceof RateLimitError
        ? "rate_limited"
        : error.status === TYPESAFE_OVERLOADED_STATUS
          ? "overloaded"
          : error.status >= 500
            ? "unavailable"
            : "rejected";
    return {
      ok: false,
      reason,
      status: error.status,
      ...(error.requestId !== undefined ? { requestId: error.requestId } : {}),
    };
  }
  return { ok: false, reason: "unavailable" };
}

export function createTypeSafeJudgmentProvider(
  options: TypeSafeJudgmentProviderOptions,
): JudgmentProvider {
  const client = new TypeSafeClient({
    apiKey: options.apiKey,
    baseURL: TYPESAFE_BASE_URL,
    defaultModel: options.model,
    logLevel: "off",
    timeout: options.attemptTimeoutMs ?? TYPESAFE_ATTEMPT_TIMEOUT_MS,
    retry: { maxRetries: options.maxRetries ?? TYPESAFE_MAX_RETRIES },
    ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
  });
  const deadlineMs = options.deadlineMs ?? TYPESAFE_DEADLINE_MS;

  return {
    id: TYPESAFE_JUDGMENT_PROVIDER_ID,
    model: options.model,
    async ask<const Q extends JudgmentQuestions>(
      request: JudgmentRequest<Q>,
      askOptions?: JudgmentAskOptions,
    ): Promise<JudgmentResult<Q>> {
      const deadline = AbortSignal.timeout(deadlineMs);
      const signal =
        askOptions?.signal === undefined
          ? deadline
          : AbortSignal.any([askOptions.signal, deadline]);
      try {
        const result = await client.systemOne(
          { state: request.state, questions: request.questions },
          { signal },
        );
        const answers = toAnswers(request.questions, result.answers);
        if (answers === undefined) {
          return { ok: false, reason: "unavailable" };
        }
        return {
          ok: true,
          model: result.model,
          answers,
          usage: {
            inputTokens: result.usage.input_tokens,
            outputTokens: result.usage.output_tokens,
          },
        };
      } catch (error) {
        return refusalFromError(error);
      }
    },
  };
}
