/**
 * The real tools: the existing staff façades, adapted to `ToolOutcome`.
 *
 * Nothing about the façades changes. Their descriptions — the part that took
 * real use to learn, and the part a rewrite would lose silently — their input
 * schemas, their mappings and their clipping all stay exactly as they are. Only
 * the shape of what comes back is new: `ok`, `pause` or `error` instead of a
 * value or a thrown `CoreError`.
 *
 * That makes this file the migration seam. A tool does not know it is being
 * used by a different runtime.
 *
 * One debt is carried over deliberately and named: ambiguity is still
 * discovered by calling `orders.create`, which resolves references and aborts
 * with CONFLICT before writing. It costs one rolled-back transaction per
 * picker. A read-only `resolveCreateInput` in the domain would remove that; it
 * is a domain change, not a runtime one, and the pause itself is already clean
 * — the continuation is stored, so resume replays once instead of a two-phase
 * retry.
 */
import { catalogPickerConflictExtrasFromError } from "@showzy/ai";
import type { CardRef, ToolOutcome, ToolSet } from "@showzy/assistant-kit";
import { CoreError } from "@showzy/core/errors";
import {
  assistantSurfacesFromToolResults,
  type AssistantSurfaceData,
  type AssistantSurfaceToolResult,
} from "@showzy/validation/assistant-surfaces";

import type {
  ChoicePickerTarget,
  ChoiceSecret,
} from "./assistant-interactions.js";

/**
 * The only thing this layer needs from a logger. Narrower than pino's, which a
 * pino logger satisfies structurally — so the runtime passes the real one and a
 * test passes an object.
 */
export interface AssistantToolLogger {
  warn(fields: Record<string, unknown>, message: string): void;
}

/**
 * One card per surface, addressed by what the surface is.
 *
 * A page and a rollup compose into a single `orders-list`; writing it under the
 * same id means the second tool call **updates** that card instead of adding a
 * second one next to it.
 */
function cardIdFor(surface: AssistantSurfaceData): string {
  return surface.kind === "order-entity"
    ? `order-entity:${surface.orderId}`
    : surface.kind;
}

function cardFor(
  before: readonly AssistantSurfaceData[],
  after: readonly AssistantSurfaceData[],
): CardRef | undefined {
  const seen = new Set(before.map((surface) => JSON.stringify(surface)));
  // The surface this call produced or changed. Composition is deterministic
  // over the results so far, so a diff is exact rather than a guess.
  const fresh = after.find((surface) => !seen.has(JSON.stringify(surface)));
  return fresh === undefined
    ? undefined
    : { cardId: cardIdFor(fresh), type: fresh.kind, payload: fresh };
}

/**
 * A `CONFLICT` that did not become a picker, named in the log.
 *
 * There are two reasons it can happen and they are very different: a terminal
 * refusal, where there is genuinely nothing to pick between, and a picker the
 * extractor could not read. Both look identical from outside — the model gets
 * an error and explains it in prose, and nobody can tell which one it was.
 *
 * Shape only, never content: the reason, what kind of thing was ambiguous, and
 * how many options came with it. A query or a label is the staff member's own
 * words about their customers, and those do not go in logs.
 */
function logUnpickableConflict(
  logger: AssistantToolLogger,
  toolName: string,
  error: CoreError,
): void {
  const target: unknown = Reflect.get(error, "target");
  const options: unknown = Reflect.get(error, "options");
  logger.warn(
    {
      tool_name: toolName,
      code: error.code,
      conflict_reason: Reflect.get(error, "reason"),
      target_kind:
        typeof target === "object" && target !== null
          ? Reflect.get(target, "kind")
          : undefined,
      option_count: Array.isArray(options) ? options.length : undefined,
    },
    "assistant conflict did not open a picker",
  );
}

/** What the person is choosing between, in their own words where possible. */
function subjectFor(target: ChoicePickerTarget): string {
  switch (target.kind) {
    case "customer":
      return target.query;
    case "order_line_product":
      return target.query;
    default:
      return target.productName;
  }
}

/**
 * Fresh per turn: the composer needs every result of the turn so far, and one
 * turn's results must never leak into another's.
 */
export function assistantKitTurnTools(
  base: ToolSet,
  logger: AssistantToolLogger,
): ToolSet {
  const results: AssistantSurfaceToolResult[] = [];
  const wrapped: ToolSet = {};

  for (const [name, definition] of Object.entries(base)) {
    const execute = definition.execute;
    if (execute === undefined) {
      wrapped[name] = definition;
      continue;
    }
    wrapped[name] = {
      ...definition,
      execute: async (input, options): Promise<ToolOutcome> => {
        try {
          const before = assistantSurfacesFromToolResults(results);
          const result: unknown = await execute(input, options);
          results.push({ toolName: name, output: result });
          const card = cardFor(
            before,
            assistantSurfacesFromToolResults(results),
          );
          return card === undefined
            ? { kind: "ok", result }
            : { kind: "ok", result, card };
        } catch (error) {
          const picker = catalogPickerConflictExtrasFromError(error);
          if (picker !== undefined) {
            const secret: ChoiceSecret = {
              // The option id is the entity id here; the map still exists so an
              // option this picker never offered is refused by the interaction.
              byOption: Object.fromEntries(
                picker.options.map((option) => [option.id, option.id]),
              ),
              toolName: name,
              input,
              target: picker.target,
            };
            return {
              kind: "pause",
              interaction: "choice",
              prompt: {
                subject: subjectFor(picker.target),
                options: picker.options.map((option) => ({
                  optionId: option.id,
                  label: option.label,
                })),
                optionsTruncated: picker.optionsTruncated,
              },
              secret,
            };
          }
          if (error instanceof CoreError) {
            if (error.code === "CONFLICT") {
              logUnpickableConflict(logger, name, error);
            }
            return { kind: "error", code: error.code, message: error.message };
          }
          // Not a domain refusal. Let the loop see it as a failed turn rather
          // than dressing an unknown fault as a business answer.
          throw error;
        }
      },
    };
  }

  return wrapped;
}
