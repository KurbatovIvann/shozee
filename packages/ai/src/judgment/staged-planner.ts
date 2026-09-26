import type { LanguageModel } from "ai";

import type { StaffJudgmentSpec } from "../tool-facades/judgment-specs.js";
import {
  isExtensionOfTyped,
  isRewriteGrounded,
  rewriteWithConversation,
  type JudgmentExchange,
} from "./context-rewrite.js";
import {
  JUDGMENT_NEEDS_HISTORY_THRESHOLD,
  planStaffTurn,
  type StaffJudgmentPlan,
  type StaffJudgmentPlannedCall,
} from "./staff-planner.js";
import type { JudgmentProvider } from "./types.js";

export const JUDGMENT_STAGE_DEADLINE_MS = 3000;

export interface StaffJudgmentStagedPlan extends StaffJudgmentPlan {
  readonly rewriteUsed: boolean;
  readonly rewriteAttempted: boolean;
}

function keepingWhatWasTyped(
  typed: StaffJudgmentPlannedCall | undefined,
  made: StaffJudgmentPlannedCall,
): StaffJudgmentPlannedCall {
  if (typed?.tool !== made.tool) {
    return made;
  }
  const input: Record<string, unknown> = { ...made.input };
  const args = { ...made.args };
  for (const [name, value] of Object.entries(typed.input)) {
    const extended = made.input[name];
    if (
      typeof value === "string" &&
      typeof extended === "string" &&
      isExtensionOfTyped(value, extended)
    ) {
      input[name] = value;
      args[name] = value;
    }
  }
  return { ...made, input, args };
}

const isTalk = (plan: StaffJudgmentPlan): boolean =>
  plan.kind === "small_talk" || plan.kind === "capability_question";

export async function planStaffTurnInContext(args: {
  readonly provider: JudgmentProvider;
  readonly rewriteModel: LanguageModel | undefined;
  readonly message: string;
  readonly exchanges: readonly JudgmentExchange[];
  readonly specs: readonly StaffJudgmentSpec[];
  readonly isWrite: (spec: StaffJudgmentSpec) => boolean;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
}): Promise<StaffJudgmentStagedPlan> {
  const now = args.now ?? (() => performance.now());
  const startedAt = now();
  const deadline = AbortSignal.timeout(JUDGMENT_STAGE_DEADLINE_MS);
  const signal =
    args.signal === undefined
      ? deadline
      : AbortSignal.any([args.signal, deadline]);
  const inConversation = args.exchanges.length > 0;
  const shared = {
    provider: args.provider,
    specs: args.specs,
    isWrite: args.isWrite,
    signal,
    now,
  };

  const rewriteAbort = new AbortController();
  const rewriting =
    inConversation && args.rewriteModel !== undefined
      ? rewriteWithConversation({
          model: args.rewriteModel,
          exchanges: args.exchanges,
          message: args.message,
          signal: AbortSignal.any([signal, rewriteAbort.signal]),
        })
      : undefined;
  const first = await planStaffTurn({
    ...shared,
    message: args.message,
    askNeedsHistory: inConversation,
  });
  const dependsOnHistory =
    (first.needsHistory ?? 0) >= JUDGMENT_NEEDS_HISTORY_THRESHOLD;
  if (first.refusal !== undefined || !dependsOnHistory || isTalk(first)) {
    rewriteAbort.abort();
    return {
      ...first,
      rewriteUsed: false,
      rewriteAttempted: rewriting !== undefined,
    };
  }

  const rewritten = await rewriting;
  if (rewritten === undefined) {
    return {
      ...first,
      latencyMs: Math.round(now() - startedAt),
      declinedBecause: "needs_history",
      rewriteUsed: false,
      rewriteAttempted: rewriting !== undefined,
    };
  }
  const second = await planStaffTurn({ ...shared, message: rewritten });
  const spec = args.specs.find((entry) => entry.tool === second.call?.tool);
  const grounded =
    second.call === undefined ||
    spec === undefined ||
    isRewriteGrounded({
      spec,
      callArgs: second.call.args,
      rewritten,
      conversation: [
        args.message,
        ...args.exchanges.flatMap((exchange) => [
          exchange.user,
          exchange.assistant,
        ]),
      ],
    });
  return {
    ...second,
    ...(second.call === undefined
      ? {}
      : { call: keepingWhatWasTyped(first.call, second.call) }),
    latencyMs: Math.round(now() - startedAt),
    ...(first.needsHistory === undefined
      ? {}
      : { needsHistory: first.needsHistory }),
    ...(grounded ? {} : { declinedBecause: "ungrounded_value" as const }),
    rewriteUsed: true,
    rewriteAttempted: true,
  };
}
