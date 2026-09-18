import { randomUUID } from "node:crypto";

import { CoreInvariantError } from "@showzy/core/errors";
import {
  wrapLanguageModel,
  type LanguageModel,
  type LanguageModelMiddleware,
} from "ai";

import type { StaffJudgmentSpec } from "../tool-facades/judgment-specs.js";
import {
  CONTEXT_REWRITE_EXCHANGES_MAX,
  type JudgmentExchange,
} from "./context-rewrite.js";
import {
  planStaffTurnInContext,
  type StaffJudgmentStagedPlan,
} from "./staged-planner.js";
import type { JudgmentProvider } from "./types.js";

export const STAFF_CASCADE_METADATA_KEY = "showzy";
export const STAFF_CASCADE_DECIDED_BY = "judgment";

type WrapStream = NonNullable<LanguageModelMiddleware["wrapStream"]>;
type WrapStreamOptions = Parameters<WrapStream>[0];
type CallParams = WrapStreamOptions["params"];
type PromptMessage = CallParams["prompt"][number];
type StreamResult = Awaited<ReturnType<WrapStream>>;
type StreamPart =
  StreamResult["stream"] extends ReadableStream<infer Part> ? Part : never;

export interface StaffCascadeReport {
  readonly plan: StaffJudgmentStagedPlan | undefined;
  readonly taken: boolean;
  readonly languageModelCalled: boolean;
}

export interface StaffCascadeModel {
  readonly model: LanguageModel;
  report(): StaffCascadeReport;
}

const NO_USAGE = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};

function streamOf(parts: readonly StreamPart[]): StreamResult {
  return {
    stream: new ReadableStream<StreamPart>({
      start(controller) {
        for (const part of parts) {
          controller.enqueue(part);
        }
        controller.close();
      },
    }),
  };
}

function textOf(message: PromptMessage): string {
  if (message.role === "system") {
    return "";
  }
  return message.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join(" ")
    .trim();
}

export function cascadeConversation(prompt: CallParams["prompt"]): {
  readonly message: string | undefined;
  readonly exchanges: JudgmentExchange[];
} {
  const last = prompt.at(-1);
  const message = last?.role === "user" ? textOf(last) : "";
  const exchanges: { user: string; assistant: string }[] = [];
  for (const entry of prompt.slice(0, -1)) {
    const text = entry.role === "tool" ? "" : textOf(entry);
    if (entry.role === "user" && text.length > 0) {
      exchanges.push({ user: text, assistant: "" });
    }
    const current = exchanges.at(-1);
    if (
      entry.role === "assistant" &&
      text.length > 0 &&
      current !== undefined
    ) {
      current.assistant = [current.assistant, text]
        .filter((part) => part.length > 0)
        .join(" ");
    }
  }
  return {
    message: message.length === 0 ? undefined : message,
    exchanges: exchanges.slice(-CONTEXT_REWRITE_EXCHANGES_MAX),
  };
}

function isRefusedResult(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    (value.status === "error" || value.status === "skipped")
  );
}

function judgmentCallAwaitingReply(
  prompt: CallParams["prompt"],
): string | undefined {
  const results = prompt.at(-1);
  const calls = prompt.at(-2);
  if (results?.role !== "tool" || calls?.role !== "assistant") {
    return undefined;
  }
  const call = calls.content.find((part) => part.type === "tool-call");
  if (
    call?.type !== "tool-call" ||
    call.providerOptions?.[STAFF_CASCADE_METADATA_KEY]?.["decidedBy"] !==
      STAFF_CASCADE_DECIDED_BY
  ) {
    return undefined;
  }
  const result = results.content.find(
    (part) =>
      part.type === "tool-result" && part.toolCallId === call.toolCallId,
  );
  return result?.type === "tool-result" &&
    result.output.type === "json" &&
    !isRefusedResult(result.output.value)
    ? call.toolName
    : undefined;
}

const isUkrainian = (text: string): boolean =>
  /\p{Script=Cyrillic}/u.test(text);

export function createStaffCascadeModel(args: {
  readonly reply: LanguageModel;
  readonly provider: JudgmentProvider;
  readonly rewriteModel: LanguageModel | undefined;
  readonly specs: readonly StaffJudgmentSpec[];
  readonly isWrite: (spec: StaffJudgmentSpec) => boolean;
  readonly signal?: AbortSignal;
}): StaffCascadeModel {
  let plan: StaffJudgmentStagedPlan | undefined;
  let planned = false;
  let taken = false;
  let replyCalled = false;
  let askedIn = "";

  const delegate = (doStream: WrapStreamOptions["doStream"]) => {
    replyCalled = true;
    return doStream();
  };

  const middleware: LanguageModelMiddleware = {
    specificationVersion: "v4",
    async wrapStream({ doStream, params }) {
      const answered = judgmentCallAwaitingReply(params.prompt);
      const answeredSpec = args.specs.find((spec) => spec.tool === answered);
      if (taken && answeredSpec?.reply !== undefined) {
        const id = `text_${randomUUID()}`;
        const line = isUkrainian(askedIn)
          ? answeredSpec.reply.uk
          : answeredSpec.reply.en;
        return streamOf([
          { type: "stream-start", warnings: [] },
          { type: "text-start", id },
          { type: "text-delta", id, delta: line },
          { type: "text-end", id },
          {
            type: "finish",
            finishReason: { unified: "stop", raw: "judgment" },
            usage: NO_USAGE,
          },
        ]);
      }

      const conversation = cascadeConversation(params.prompt);
      if (planned || conversation.message === undefined) {
        return delegate(doStream);
      }
      planned = true;
      askedIn = conversation.message;
      const offered = new Set((params.tools ?? []).map((tool) => tool.name));
      const specs = args.specs.filter((spec) => offered.has(spec.tool));
      try {
        plan = await planStaffTurnInContext({
          provider: args.provider,
          rewriteModel: args.rewriteModel,
          message: conversation.message,
          exchanges: conversation.exchanges,
          specs,
          isWrite: args.isWrite,
          ...(args.signal === undefined ? {} : { signal: args.signal }),
        });
      } catch {
        return delegate(doStream);
      }
      const spec = specs.find((entry) => entry.tool === plan?.call?.tool);
      if (
        plan.call === undefined ||
        plan.declinedBecause !== undefined ||
        spec?.reply === undefined ||
        args.isWrite(spec)
      ) {
        return delegate(doStream);
      }

      taken = true;
      const toolCallId = `toolu_judgment_${randomUUID().replaceAll("-", "")}`;
      const input = JSON.stringify(plan.call.args);
      const providerMetadata = {
        [STAFF_CASCADE_METADATA_KEY]: {
          decidedBy: STAFF_CASCADE_DECIDED_BY,
          model: plan.model,
        },
      };
      return streamOf([
        { type: "stream-start", warnings: [] },
        { type: "tool-input-start", id: toolCallId, toolName: spec.tool },
        { type: "tool-input-delta", id: toolCallId, delta: input },
        { type: "tool-input-end", id: toolCallId },
        {
          type: "tool-call",
          toolCallId,
          toolName: spec.tool,
          input,
          providerMetadata,
        },
        {
          type: "finish",
          finishReason: { unified: "tool-calls", raw: "judgment" },
          usage: NO_USAGE,
        },
      ]);
    },
  };

  if (typeof args.reply === "string") {
    throw new CoreInvariantError(
      "the cascade model needs a model instance, not a model id",
    );
  }
  return {
    model: wrapLanguageModel({
      model: args.reply,
      middleware,
    }),
    report: () => ({
      plan,
      taken,
      languageModelCalled: replyCalled || plan?.rewriteAttempted === true,
    }),
  };
}
