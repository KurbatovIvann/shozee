export const JEV_URL = "https://api.typesafe.ai/v1/systemone";
export const JEV_USD_PER_INPUT_MTOK = 0.042;

export interface JevChoiceAnswer {
  readonly choice: string;
  readonly confidence: number;
  readonly probabilities: Readonly<Record<string, number>>;
}

export interface JevReply {
  readonly answers: Readonly<Record<string, JevChoiceAnswer>>;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  readonly latencyMs: number;
  readonly error: string | null;
}

interface RawAnswer {
  readonly type?: string;
  readonly choice?: string;
  readonly confidence?: number;
  readonly probabilities?: Readonly<Record<string, number>>;
}

interface RawReply {
  readonly answers?: Readonly<Record<string, RawAnswer>>;
  readonly usage?: {
    readonly input_tokens?: number;
    readonly output_tokens?: number;
  };
  readonly error?: { readonly message?: string } | string;
}

export function jevRankedChoices(
  answer: JevChoiceAnswer | undefined,
  k: number,
): readonly string[] {
  if (answer === undefined) {
    return [];
  }
  return Object.entries(answer.probabilities)
    .sort((left, right) => right[1] - left[1])
    .slice(0, k)
    .map(([option]) => option);
}

export async function jevAsk(input: {
  readonly apiKey: string;
  readonly model: string;
  readonly state: string;
  readonly questions: Readonly<Record<string, unknown>>;
  readonly timeoutMs?: number;
}): Promise<JevReply> {
  const started = performance.now();
  const empty = {
    answers: {},
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
  };
  try {
    const response = await fetch(JEV_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${input.apiKey}`,
      },
      body: JSON.stringify({
        state: input.state,
        model: input.model,
        questions: input.questions,
      }),
      signal: AbortSignal.timeout(input.timeoutMs ?? 20_000),
    });
    const body = (await response.json()) as RawReply;
    const inputTokens = body.usage?.input_tokens ?? 0;
    const outputTokens = body.usage?.output_tokens ?? 0;
    const costUsd = (inputTokens / 1_000_000) * JEV_USD_PER_INPUT_MTOK;
    if (!response.ok) {
      const message =
        typeof body.error === "string"
          ? body.error
          : (body.error?.message ?? "request failed");
      return {
        ...empty,
        inputTokens,
        outputTokens,
        costUsd,
        latencyMs: performance.now() - started,
        error: `${String(response.status)} ${message}`,
      };
    }
    const answers: Record<string, JevChoiceAnswer> = {};
    for (const [name, raw] of Object.entries(body.answers ?? {})) {
      if (typeof raw.choice !== "string") {
        continue;
      }
      answers[name] = {
        choice: raw.choice,
        confidence: raw.confidence ?? 0,
        probabilities: raw.probabilities ?? {},
      };
    }
    return {
      answers,
      inputTokens,
      outputTokens,
      costUsd,
      latencyMs: performance.now() - started,
      error: null,
    };
  } catch (error) {
    return {
      ...empty,
      latencyMs: performance.now() - started,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
