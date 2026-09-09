/**
 * What happens after a person answers a picker: fill the chosen id into the
 * tool's own input and call that tool again.
 *
 * There is deliberately no second code path here. The resolved call goes back
 * through the same façade, with the same schema, the same mapping and the same
 * action — one field is no longer a query. A separate "resume" implementation
 * is what lets the two drift, and drift is what turns a picker into a duplicate
 * record or a missing one.
 */
import type { ToolOutcome } from "@showzy/assistant-kit";

import type {
  ChoicePickerTarget,
  ChoiceResolution,
} from "./assistant-interactions.js";
import type { ResolveAnswer } from "./assistant-kit-http.js";

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

export function createResolveAnswer(): ResolveAnswer {
  return async ({ value, tools }) => {
    const resolution = value as ChoiceResolution;
    const tool = tools[resolution.toolName];
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
  };
}
