import {
  CONTEXT_REWRITE_EXCHANGES_MAX,
  STAFF_ASSISTANT_TOOL_SEARCH_NAME,
  STAFF_JUDGMENT_SPECS,
  createStaffCascadeModel,
  judgmentShadowOf,
  planStaffTurnInContext,
  type JudgmentExchange,
  type JudgmentProvider,
  type LanguageModel,
  type ObservedToolCall,
  type StaffJudgmentSpec,
} from "@showzy/ai";
import type { ModelMessage } from "@showzy/assistant-kit";
import type { ActionContract } from "@showzy/core/contract";
import type { JudgmentShadow } from "@showzy/validation/assistant-judgment";
import type { Logger } from "pino";

export type AssistantJudgmentShadowResult = (
  turnMessages: readonly ModelMessage[],
) => JudgmentShadow;

export interface AssistantJudgmentShadow {
  begin(args: {
    readonly history: readonly ModelMessage[];
    readonly toolNames: readonly string[];
    readonly signal: AbortSignal;
  }): Promise<AssistantJudgmentShadowResult | undefined>;
}

function textOf(message: ModelMessage): string {
  if (typeof message.content === "string") {
    return message.content.trim();
  }
  return message.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join(" ")
    .trim();
}

export function lastUserText(
  history: readonly ModelMessage[],
): string | undefined {
  const last = history.at(-1);
  if (last?.role !== "user") {
    return undefined;
  }
  const text = textOf(last);
  return text.length === 0 ? undefined : text;
}

export function earlierExchanges(
  history: readonly ModelMessage[],
): JudgmentExchange[] {
  const exchanges: { user: string; assistant: string }[] = [];
  for (const message of history.slice(0, -1)) {
    const text = message.role === "tool" ? "" : textOf(message);
    if (message.role === "user" && text.length > 0) {
      exchanges.push({ user: text, assistant: "" });
    }
    const current = exchanges.at(-1);
    if (
      message.role === "assistant" &&
      text.length > 0 &&
      current !== undefined
    ) {
      current.assistant = [current.assistant, text]
        .filter((part) => part.length > 0)
        .join(" ");
    }
  }
  return exchanges.slice(-CONTEXT_REWRITE_EXCHANGES_MAX);
}

export function firstToolCall(
  turnMessages: readonly ModelMessage[],
): ObservedToolCall | undefined {
  for (const message of turnMessages) {
    if (message.role !== "assistant" || typeof message.content === "string") {
      continue;
    }
    for (const part of message.content) {
      if (
        part.type === "tool-call" &&
        part.toolName !== STAFF_ASSISTANT_TOOL_SEARCH_NAME
      ) {
        return { toolName: part.toolName, input: part.input };
      }
    }
  }
  return undefined;
}

export function createAssistantJudgmentShadow(deps: {
  readonly provider: JudgmentProvider;
  readonly rewriteModel: LanguageModel | undefined;
  readonly contracts: readonly ActionContract[];
  readonly logger: Pick<Logger, "warn">;
}): AssistantJudgmentShadow {
  const risk = new Map(
    deps.contracts.map((contract) => [contract.name, contract.risk]),
  );
  const isWrite = (spec: StaffJudgmentSpec): boolean =>
    risk.get(spec.action) !== "read";

  return {
    async begin({ history, toolNames, signal }) {
      const message = lastUserText(history);
      if (message === undefined) {
        return undefined;
      }
      const permitted = new Set(toolNames);
      const specs = STAFF_JUDGMENT_SPECS.filter((spec) =>
        permitted.has(spec.tool),
      );
      try {
        const plan = await planStaffTurnInContext({
          provider: deps.provider,
          rewriteModel: deps.rewriteModel,
          message,
          exchanges: earlierExchanges(history),
          specs,
          isWrite,
          signal,
        });
        return (turnMessages) =>
          judgmentShadowOf(plan, firstToolCall(turnMessages), specs, isWrite);
      } catch (error) {
        deps.logger.warn({ err: error }, "assistant judgment shadow failed");
        return undefined;
      }
    },
  };
}

export interface AssistantJudgmentCascadeTurn {
  readonly model: LanguageModel;
  outcome(turnMessages: readonly ModelMessage[]): {
    readonly judgmentShadow: JudgmentShadow | undefined;
    readonly toolLoopModelCalled: boolean;
  };
}

export interface AssistantJudgmentCascade {
  forTurn(args: {
    readonly reply: LanguageModel;
    readonly signal: AbortSignal;
  }): AssistantJudgmentCascadeTurn;
}

export function createAssistantJudgmentCascade(deps: {
  readonly provider: JudgmentProvider;
  readonly gateModel: LanguageModel | undefined;
  readonly contracts: readonly ActionContract[];
}): AssistantJudgmentCascade {
  const risk = new Map(
    deps.contracts.map((contract) => [contract.name, contract.risk]),
  );
  const isWrite = (spec: StaffJudgmentSpec): boolean =>
    risk.get(spec.action) !== "read";

  return {
    forTurn({ reply, signal }) {
      const cascade = createStaffCascadeModel({
        reply,
        gate: deps.gateModel,
        provider: deps.provider,
        rewriteModel: deps.gateModel,
        specs: STAFF_JUDGMENT_SPECS,
        isWrite,
        signal,
      });
      return {
        model: cascade.model,
        outcome(turnMessages) {
          const report = cascade.report();
          return {
            judgmentShadow:
              report.plan === undefined
                ? undefined
                : judgmentShadowOf(
                    report.plan,
                    firstToolCall(turnMessages),
                    STAFF_JUDGMENT_SPECS,
                    isWrite,
                    report.taken,
                    report.tier,
                  ),
            toolLoopModelCalled: report.toolLoopModelCalled,
          };
        },
      };
    },
  };
}
