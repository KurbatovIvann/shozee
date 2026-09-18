import {
  STAFF_ASSISTANT_TOOL_SEARCH_NAME,
  STAFF_JUDGMENT_SPECS,
  judgmentShadowOf,
  planStaffTurn,
  type JudgmentProvider,
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

export function lastUserText(
  history: readonly ModelMessage[],
): string | undefined {
  const last = history.at(-1);
  if (last?.role !== "user") {
    return undefined;
  }
  const text =
    typeof last.content === "string"
      ? last.content
      : last.content
          .flatMap((part) => (part.type === "text" ? [part.text] : []))
          .join(" ");
  return text.trim().length === 0 ? undefined : text.trim();
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
        const plan = await planStaffTurn({
          provider: deps.provider,
          message,
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
