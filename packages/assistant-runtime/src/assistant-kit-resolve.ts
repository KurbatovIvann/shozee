/**
 * What happens after a person answers a question, by the kind of question.
 *
 * A picker: fill the chosen id into the tool's own input and call that tool
 * again. There is deliberately no second code path there. The resolved call goes
 * back through the same façade, with the same schema, the same mapping and the
 * same action — one field is no longer a query. A separate "resume"
 * implementation is what lets the two drift, and drift is what turns a picker
 * into a duplicate record or a missing one.
 *
 * A confirmation: present the stored attempt to core again with its challenge,
 * through the same call every tool makes. Core, not this file, decides whether
 * the approval holds.
 *
 * Which of the two runs is read from the claimed kind. This file used to assume
 * every answer was a picker, so the first confirmation anything opened would have
 * been answered `no tool named undefined` (SHO-553).
 */
import type { ToolOutcome } from "@showzy/assistant-kit";
import { CoreError } from "@showzy/core/errors";

import type {
  AssistantInteractionTypes,
  ChoicePickerTarget,
  ChoiceResolution,
  ConfirmationResolution,
} from "./assistant-interactions.js";
import {
  AssistantConfirmationRequired,
  confirmationPause,
} from "./assistant-kit-confirmation.js";
import type { AssistantToolContext, ResolveAnswer } from "./runtime-types.js";

interface FacadeInput {
  customerId?: string;
  customerQuery?: string;
  items?: Array<{
    productId?: string;
    productQuery?: string;
    variantId?: string;
    variantQuery?: string;
  }>;
}

/**
 * The chosen id replaces the query it was ambiguous about. Leaving the query in
 * place would send the same ambiguity back and pause again on the same
 * question.
 */
export function withChosenId(
  input: unknown,
  target: ChoicePickerTarget,
  entityId: string,
):
  | { readonly kind: "patched"; readonly input: unknown }
  | { readonly kind: "unpatchable"; readonly reason: string } {
  if (typeof input !== "object" || input === null) {
    return { kind: "unpatchable", reason: "input is not an object" };
  }
  const next = structuredClone(input) as FacadeInput;

  if (target.kind === "customer") {
    next.customerId = entityId;
    delete next.customerQuery;
    return { kind: "patched", input: next };
  }

  const line = next.items?.[target.lineIndex];
  if (line === undefined) {
    return {
      kind: "unpatchable",
      reason: `no line at index ${String(target.lineIndex)}`,
    };
  }
  if (target.kind === "order_line_product") {
    line.productId = entityId;
    delete line.productQuery;
  } else {
    line.variantId = entityId;
    delete line.variantQuery;
  }
  return { kind: "patched", input: next };
}

/**
 * Runs a confirmed action as the person answering, under the attempt core bound
 * the challenge to. Supplied by the runtime, so it is the call every tool makes.
 */
export type RunConfirmedAction = (args: {
  readonly context: AssistantToolContext;
  readonly actionName: string;
  readonly input: unknown;
  readonly idempotencyKey: string;
  readonly challengeId: string;
}) => Promise<unknown>;

export interface ResolveAnswerDeps {
  readonly runConfirmed: RunConfirmedAction;
}

type ResolveArgs = Parameters<ResolveAnswer>[0];

type Resolver = (
  args: ResolveArgs,
  deps: ResolveAnswerDeps,
) => Promise<ToolOutcome>;

async function resolveChoice(args: ResolveArgs): Promise<ToolOutcome> {
  const resolution = args.value as ChoiceResolution;
  const tool = args.tools[resolution.toolName];
  const execute = tool?.execute;
  if (execute === undefined) {
    return {
      kind: "error",
      code: "CONFLICT",
      message: `no tool named ${resolution.toolName}`,
    } satisfies ToolOutcome;
  }

  const patched = withChosenId(
    resolution.input,
    resolution.target,
    resolution.entityId,
  );
  if (patched.kind === "unpatchable") {
    return {
      kind: "error",
      code: "CONFLICT",
      message: `cannot apply the choice: ${patched.reason}`,
    } satisfies ToolOutcome;
  }

  // A fresh id: this is a new call, and the action's own idempotency key is
  // what makes a retry of it safe.
  return (await execute(patched.input, {
    toolCallId: `resume_${resolution.entityId}`,
    messages: [],
  } as never)) as ToolOutcome;
}

async function resolveConfirmation(
  args: ResolveArgs,
  deps: ResolveAnswerDeps,
): Promise<ToolOutcome> {
  const resolution = args.value as ConfirmationResolution;
  try {
    const result = await deps.runConfirmed({
      context: args.context,
      actionName: resolution.actionName,
      input: resolution.canonicalInput,
      idempotencyKey: resolution.idempotencyKey,
      challengeId: resolution.challengeId,
    });
    return { kind: "ok", result };
  } catch (error) {
    if (error instanceof AssistantConfirmationRequired) {
      // Core would not accept the challenge — it expired, or it was presented
      // for something it was not issued for — and issued another. A new
      // question for the person, never an execution.
      return confirmationPause(error);
    }
    if (error instanceof CoreError) {
      return { kind: "error", code: error.code, message: error.message };
    }
    throw error;
  }
}

/**
 * One resolver per kind this deployment registers, keyed by the registry's own
 * kinds. A kind added there without a resolver here fails to compile, rather
 * than falling through to whichever resolver was written first.
 */
const RESOLVERS: {
  readonly [K in keyof AssistantInteractionTypes]: Resolver;
} = {
  choice: resolveChoice,
  confirmation: resolveConfirmation,
};

function isRegisteredKind(
  kind: string,
): kind is keyof AssistantInteractionTypes {
  return Object.hasOwn(RESOLVERS, kind);
}

export function createResolveAnswer(deps: ResolveAnswerDeps): ResolveAnswer {
  return async (args) => {
    if (!isRegisteredKind(args.kind)) {
      return {
        kind: "error",
        code: "CONFLICT",
        message: `no resolver for ${args.kind}`,
      } satisfies ToolOutcome;
    }
    return await RESOLVERS[args.kind](args, deps);
  };
}
