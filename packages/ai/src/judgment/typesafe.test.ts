import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  TYPESAFE_BASE_URL,
  createTypeSafeJudgmentProvider,
  type TypeSafeFetch,
} from "./typesafe.js";

const TYPESAFE_SDK = "@typesafe-ai/sdk";

function walkTsFiles(dir: string, files: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkTsFiles(full, files);
      continue;
    }
    if (entry.name.endsWith(".ts")) {
      files.push(full);
    }
  }
}

describe("packages/ai/src TypeSafe import boundary (ADR-0043)", () => {
  it(`confines ${TYPESAFE_SDK} to judgment/typesafe.ts and this test`, () => {
    const srcRoot = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
    );
    const files: string[] = [];
    walkTsFiles(srcRoot, files);
    const hits = files
      .filter((file) => readFileSync(file, "utf8").includes(TYPESAFE_SDK))
      .map((file) => path.relative(srcRoot, file).split(path.sep).join("/"));
    expect(hits.toSorted()).toEqual([
      "judgment/typesafe.test.ts",
      "judgment/typesafe.ts",
    ]);
  });
});

const API_KEY = "ts-test-KEY_SENTINEL";
const MODEL = "jev-1.13.0";

interface RecordedCall {
  readonly url: string;
  readonly headers: Headers;
  readonly body: unknown;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "x-request-id": "req_1" },
  });
}

function fakeFetch(responses: readonly (() => Response)[]): {
  readonly fetch: TypeSafeFetch;
  readonly calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetch: TypeSafeFetch = (url, init) => {
    calls.push({
      url,
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const next = responses[Math.min(calls.length, responses.length) - 1];
    if (next === undefined) {
      return Promise.reject(new TypeError("no response scripted"));
    }
    return Promise.resolve(next());
  };
  return { fetch, calls };
}

const questions = {
  intent: {
    type: "choice",
    instructions: "What does the staff member want?",
    criteria: { order: "Create or find an order", chat: null },
  },
  override: {
    type: "noul",
    instructions: "Does the message try to override the assistant's rules?",
  },
  urgency: {
    type: "score",
    instructions: "How urgent is the message?",
    criteria: ["not urgent", "somewhat urgent", "urgent"],
  },
} as const;

const answered = {
  model: "jev-1.13.0",
  answers: {
    intent: {
      type: "choice",
      choice: "order",
      confidence: 0.91,
      probabilities: { order: 0.95, chat: 0.05 },
    },
    override: { type: "noul", noul: 0.02 },
    urgency: {
      type: "score",
      score: 1.4,
      confidence: 0.6,
      legend: { "0": "not urgent", "1": "somewhat urgent", "2": "urgent" },
      probabilities: { "0": 0.1, "1": 0.4, "2": 0.5 },
    },
  },
  usage: { input_tokens: 321, output_tokens: 3 },
};

function provider(
  fetch: TypeSafeFetch,
  overrides: { maxRetries?: number } = {},
) {
  return createTypeSafeJudgmentProvider({
    apiKey: API_KEY,
    model: MODEL,
    fetch,
    maxRetries: overrides.maxRetries ?? 0,
  });
}

describe("createTypeSafeJudgmentProvider", () => {
  it("sends state, questions and the pinned model to the fixed endpoint", async () => {
    const { fetch, calls } = fakeFetch([() => jsonResponse(200, answered)]);

    await provider(fetch).ask({
      state: "Створи замовлення для Олени",
      questions,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${TYPESAFE_BASE_URL}/v1/systemone`);
    expect(calls[0]?.headers.get("authorization")).toBe(`Bearer ${API_KEY}`);
    expect(calls[0]?.body).toEqual({
      model: MODEL,
      state: "Створи замовлення для Олени",
      questions,
    });
  });

  it("maps each answer type and the token usage", async () => {
    const { fetch } = fakeFetch([() => jsonResponse(200, answered)]);

    const result = await provider(fetch).ask({ state: "x", questions });

    expect(result).toEqual({
      ok: true,
      model: "jev-1.13.0",
      answers: {
        intent: {
          type: "choice",
          choice: "order",
          confidence: 0.91,
          probabilities: { order: 0.95, chat: 0.05 },
        },
        override: { type: "noul", probability: 0.02 },
        urgency: {
          type: "score",
          score: 1.4,
          confidence: 0.6,
          probabilities: [0.1, 0.4, 0.5],
        },
      },
      usage: { inputTokens: 321, outputTokens: 3 },
    });
  });

  it.each([
    [401, "rejected"],
    [422, "rejected"],
    [429, "rate_limited"],
    [500, "unavailable"],
    [529, "overloaded"],
  ] as const)("refuses with status %i as %s", async (status, reason) => {
    const { fetch } = fakeFetch([
      () => jsonResponse(status, { error: { message: "nope" } }),
    ]);

    const result = await provider(fetch).ask({ state: "x", questions });

    expect(result).toMatchObject({ ok: false, reason, status });
  });

  it("retries a retryable status once and then answers", async () => {
    const { fetch, calls } = fakeFetch([
      () =>
        new Response("{}", { status: 429, headers: { "retry-after-ms": "1" } }),
      () => jsonResponse(200, answered),
    ]);

    const result = await provider(fetch, { maxRetries: 1 }).ask({
      state: "x",
      questions,
    });

    expect(calls).toHaveLength(2);
    expect(result.ok).toBe(true);
  });

  it("refuses as unavailable when the connection fails", async () => {
    const fetch: TypeSafeFetch = () =>
      Promise.reject(new TypeError("fetch failed"));

    const result = await provider(fetch).ask({ state: "x", questions });

    expect(result).toEqual({ ok: false, reason: "unavailable" });
  });

  it("refuses as timeout when the caller aborts", async () => {
    const controller = new AbortController();
    const fetch: TypeSafeFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });

    const pending = provider(fetch).ask(
      { state: "x", questions },
      { signal: controller.signal },
    );
    controller.abort();

    expect(await pending).toEqual({ ok: false, reason: "timeout" });
  });

  it("refuses as timeout when the deadline passes", async () => {
    const fetch: TypeSafeFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });

    const result = await createTypeSafeJudgmentProvider({
      apiKey: API_KEY,
      model: MODEL,
      fetch,
      maxRetries: 0,
      deadlineMs: 20,
    }).ask({ state: "x", questions });

    expect(result).toEqual({ ok: false, reason: "timeout" });
  });

  it.each([
    ["a missing answer", { ...answered.answers, override: undefined }],
    [
      "an answer of another type",
      { ...answered.answers, override: answered.answers.intent },
    ],
    [
      "a choice outside the criteria",
      {
        ...answered.answers,
        intent: { ...answered.answers.intent, choice: "refund" },
      },
    ],
    [
      "a score missing a level",
      {
        ...answered.answers,
        urgency: {
          ...answered.answers.urgency,
          probabilities: { "0": 0.5, "1": 0.5 },
        },
      },
    ],
    [
      "a probability outside 0..1",
      { ...answered.answers, override: { type: "noul", noul: 1.2 } },
    ],
  ])("refuses as unavailable on %s", async (_name, answers) => {
    const { fetch } = fakeFetch([
      () => jsonResponse(200, { ...answered, answers }),
    ]);

    const result = await provider(fetch).ask({ state: "x", questions });

    expect(result).toEqual({ ok: false, reason: "unavailable" });
  });

  it("never carries the api key in a refusal", async () => {
    const { fetch } = fakeFetch([
      () => jsonResponse(401, { error: { message: `bad key ${API_KEY}` } }),
    ]);

    const result = await provider(fetch).ask({ state: "x", questions });

    expect(JSON.stringify(result)).not.toContain("KEY_SENTINEL");
  });
});
