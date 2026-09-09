/**
 * The loop adapter: one `streamText`, and what to do when a tool pauses.
 *
 * This is the half a consumer would otherwise hand-write, and the half the
 * previous runtime got wrong. Three decisions live here:
 *
 * 1. The pause is opened **after** the turn, not inside `execute`. Only then
 *    does the provider history exist, so the continuation is what was really
 *    sent rather than something reassembled later.
 * 2. The paused call's id comes from the SDK (`options.toolCallId`). Nothing
 *    is minted, so nothing needs sanitising at the provider boundary.
 * 3. Tools run one at a time, and once a pause is captured no further tool in
 *    that step may act. A write must never overtake an unanswered question.
 */
import {
  stepCountIs,
  streamText,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
} from "ai";

import type { DocumentPart } from "./document.js";
import { providerToolCallId } from "./ids.js";
import type { AssistantKit } from "./kit.js";
import type { SurfaceRef, ToolOutcome } from "./outcome.js";
import type { ClaimResult, PublicPause } from "./pause.js";

const DEFAULT_MAX_STEPS = 8;

/** What a tool that ran after a pause returns. It did not act. */
export const HOST_SKIPPED_OUTPUT = {
  status: "skipped",
  reason: "interaction_open",
} as const;

interface Captured {
  readonly outcome: Extract<
    ToolOutcome<unknown>,
    { kind: "needs_choice" | "needs_confirmation" }
  >;
  readonly toolCallId: string;
  readonly toolName: string;
}

interface TurnState {
  paused: Captured | undefined;
  readonly surfaces: SurfaceRef[];
  chain: Promise<unknown>;
}

/** What the model is told when a tool needs a human. No entity ids. */
function modelViewOf(captured: Captured["outcome"]): unknown {
  return captured.kind === "needs_choice"
    ? {
        status: "needs_choice",
        subject: captured.subject,
        options: captured.options.map((option) => ({
          optionId: option.optionId,
          label: option.label,
        })),
        optionsTruncated: captured.optionsTruncated,
      }
    : { status: "needs_confirmation", summary: captured.summary };
}

function pausingTools(tools: ToolSet, state: TurnState): ToolSet {
  const wrapped: ToolSet = {};
  for (const [name, definition] of Object.entries(tools)) {
    const execute = definition.execute;
    if (execute === undefined) {
      wrapped[name] = definition;
      continue;
    }
    wrapped[name] = {
      ...definition,
      execute: (input, options) => {
        // One at a time: the chain is the whole concurrency policy.
        const next = state.chain.then(async () => {
          if (state.paused !== undefined) {
            return HOST_SKIPPED_OUTPUT;
          }
          const outcome = (await execute(input, options)) as ToolOutcome<unknown>;
          if (outcome.kind === "ok") {
            if (outcome.surface !== undefined) {
              state.surfaces.push(outcome.surface);
            }
            return outcome.result;
          }
          if (outcome.kind === "domain_error") {
            return { status: "error", code: outcome.code, message: outcome.message };
          }
          state.paused = {
            outcome,
            toolCallId: options.toolCallId,
            toolName: name,
          };
          return modelViewOf(outcome);
        });
        state.chain = next.catch(() => undefined);
        return next;
      },
    };
  }
  return wrapped;
}

export interface HostTurnOptions {
  readonly kit: AssistantKit;
  readonly conversationId: string;
  readonly messageId: string;
  readonly model: LanguageModel;
  readonly messages: readonly ModelMessage[];
  /** Tools whose `execute` returns a `ToolOutcome`. */
  readonly tools: ToolSet;
  readonly system?: string;
  readonly abortSignal?: AbortSignal;
  readonly maxSteps?: number;
}

export interface HostTurnResult {
  readonly kind: "settled" | "paused";
  readonly pause: PublicPause | null;
  readonly parts: readonly DocumentPart[];
  /** Provider history after this turn — the continuation when paused. */
  readonly messages: readonly ModelMessage[];
}

async function runLoop(
  options: HostTurnOptions,
  seedSurfaces: readonly SurfaceRef[],
): Promise<HostTurnResult> {
  const state: TurnState = {
    paused: undefined,
    surfaces: [...seedSurfaces],
    chain: Promise.resolve(),
  };

  const result = streamText({
    model: options.model,
    messages: [...options.messages],
    tools: pausingTools(options.tools, state),
    stopWhen: [
      stepCountIs(options.maxSteps ?? DEFAULT_MAX_STEPS),
      () => state.paused !== undefined,
    ],
    ...(options.system !== undefined ? { system: options.system } : {}),
    ...(options.abortSignal !== undefined
      ? { abortSignal: options.abortSignal }
      : {}),
  });

  await result.consumeStream();
  const messages = [...options.messages, ...(await result.responseMessages)];
  const text = await result.text;

  const parts: DocumentPart[] = state.surfaces.map((surface) => ({
    kind: "surface",
    cardId: surface.cardId,
    revision: 1,
    surface: surface.surface,
    payload: surface.payload,
  }));
  if (text.length > 0) {
    parts.push({ kind: "text", text, status: "complete" });
  }

  let pause: PublicPause | null = null;
  if (state.paused !== undefined) {
    const id = providerToolCallId(state.paused.toolCallId);
    // An id the provider would reject cannot become a continuation. Without a
    // stored pause the turn simply settles; it never becomes unsendable history.
    if (id.kind === "ok") {
      const opened = await options.kit.open({
        conversationId: options.conversationId,
        outcome: state.paused.outcome,
        continuation: {
          messages,
          pausedToolCall: { id: id.id, name: state.paused.toolName },
        },
      });
      pause = opened.kind === "opened" ? opened.pause : opened.current;
      if (opened.kind === "opened") {
        parts.push({
          kind: "interaction",
          interactionId: opened.pause.interactionId,
          revision: opened.pause.revision,
          pause: opened.pause,
        });
      }
    }
  }

  if (parts.length > 0) {
    await options.kit.document.write(options.conversationId, {
      kind: "append",
      messageId: options.messageId,
      role: "assistant",
      parts,
    });
  }

  return {
    kind: pause !== null ? "paused" : "settled",
    pause,
    parts,
    messages,
  };
}

/** A fresh turn from a new user message. */
export function runHostTurn(options: HostTurnOptions): Promise<HostTurnResult> {
  return runLoop(options, []);
}

export interface ContinueHostTurnOptions<TInput>
  extends Omit<HostTurnOptions, "messages"> {
  readonly claimed: Extract<ClaimResult<TInput>, { kind: "claimed" }>;
  /**
   * What the paused tool would have returned had the human answered inline.
   * The caller produces it by running the real action with the resolved input,
   * so the write happens once, here, and not during preparation.
   */
  readonly resolved: Extract<ToolOutcome<TInput>, { kind: "ok" }>;
}

/** Phase two: the same loop, over the replayed continuation. */
export function continueHostTurn<TInput>(
  options: ContinueHostTurnOptions<TInput>,
): Promise<HostTurnResult> {
  const { claimed, resolved, ...rest } = options;
  const { messages } = options.kit.resume(claimed, resolved.result);
  return runLoop(
    { ...rest, messages },
    resolved.surface !== undefined ? [resolved.surface] : [],
  );
}
