/**
 * The loop adapter: one `streamText`, and what to do when a tool pauses.
 *
 * This is the half a consumer would otherwise hand-write. Four decisions live
 * here, each the inverse of a way this goes wrong:
 *
 * 1. The pause is opened **after** the turn, not inside `execute`. Only then
 *    does the provider history exist, so the continuation is what was really
 *    sent rather than something reassembled later.
 * 2. The paused call's id comes from the SDK (`options.toolCallId`). Nothing is
 *    minted, so nothing needs sanitising at the provider boundary.
 * 3. Tools run one at a time, and once a pause is captured no further tool in
 *    that step may act. A write must never overtake an unanswered question.
 * 4. What happened is stored as it happens. A card is written to the message
 *    when its tool completes, and history is handed to the caller when a step
 *    finishes — not both at the end, where a turn that dies first takes them
 *    with it. The end of the turn writes only what the end produces.
 */
import {
  stepCountIs,
  streamText,
  type LanguageModel,
  type ModelMessage,
  type SystemModelMessage,
  type ToolSet,
} from "ai";
import type { z } from "zod";

import { appendParts, type ChatPart } from "./messages.js";
import { providerToolCallId } from "./ids.js";
import type { InteractionType } from "./interaction.js";
import type { AssistantKit } from "./kit.js";
import type { CardRef, ToolOutcome } from "./outcome.js";
import type { ClaimResult, PublicPause } from "./pause.js";

const DEFAULT_MAX_STEPS = 8;

type AnyTypes = Record<string, InteractionType<z.ZodType, z.ZodType, never>>;

/** What a tool that ran after a pause returns. It did not act. */
export const HOST_SKIPPED_OUTPUT = {
  status: "skipped",
  reason: "interaction_open",
} as const;

interface Captured {
  readonly outcome: Extract<ToolOutcome, { kind: "pause" }>;
  readonly toolCallId: string;
  readonly toolName: string;
}

interface TurnState {
  paused: Captured | undefined;
  /** Every card written this turn, in the order written, repeats included. */
  readonly cards: CardRef[];
  chain: Promise<unknown>;
  /**
   * Provider messages of every step that finished, accumulated as they finish.
   *
   * The SDK's own accumulator is unreachable once the run is aborted — every
   * promise on the result rejects, including `steps`. This is the same value
   * (measured: identical to `responseMessages` on a clean run) built from the
   * parts that arrived, so an abort after a write keeps the memory of it.
   */
  readonly stepMessages: ModelMessage[];
  /**
   * The stream carried an error.
   *
   * Needed because `consumeStream` swallows one: measured against `ai@7.0.87`,
   * a provider failure after the first step leaves every promise resolving —
   * `text` is `""` and `finishReason` is `"other"` — so without this flag a
   * turn that broke halfway is indistinguishable from one that had nothing to
   * say.
   */
  interrupted: boolean;
  /**
   * A write made during the run failed: a card, or the history of a step.
   *
   * Held rather than thrown where it happens, because neither place can throw
   * usefully. A throw inside `execute` becomes a tool error the model reads as
   * "the action failed" when the action committed; a throw inside
   * `onStepFinish` is discarded by the SDK. So the loop stops at the next step
   * boundary and the turn rejects with it once the run has settled — the same
   * outcome a storage failure had when every write happened at the end.
   */
  failure: { readonly error: unknown } | undefined;
}

function cardPart(card: CardRef): ChatPart {
  return {
    kind: "card",
    cardId: card.cardId,
    revision: 1,
    type: card.type,
    payload: card.payload,
  };
}

function pausingTools(
  tools: ToolSet,
  state: TurnState,
  storeCard: (card: CardRef) => Promise<void>,
): ToolSet {
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
          const outcome = (await execute(input, options)) as ToolOutcome;
          if (outcome.kind === "ok") {
            if (outcome.card !== undefined) {
              state.cards.push(outcome.card);
              // Before the model sees the result: the write has committed, and
              // from here on the card is the only record the person has of it.
              await storeCard(outcome.card);
            }
            return outcome.result;
          }
          if (outcome.kind === "error") {
            return {
              status: "error",
              code: outcome.code,
              message: outcome.message,
            };
          }
          state.paused = {
            outcome,
            toolCallId: options.toolCallId,
            toolName: name,
          };
          // The prompt is the public payload, so the model may see exactly what
          // the person will be shown — no separate view to keep in step.
          return outcome.prompt;
        });
        state.chain = next.catch(() => undefined);
        return next;
      },
    };
  }
  return wrapped;
}

export interface HostTurnOptions<T extends AnyTypes> {
  readonly kit: AssistantKit<T>;
  readonly conversationId: string;
  /** Opaque owner token. Every pause read or written this turn is scoped by it. */
  readonly bind: string;
  readonly messageId: string;
  readonly model: LanguageModel;
  readonly messages: readonly ModelMessage[];
  /** Tools whose `execute` returns a `ToolOutcome`. */
  readonly tools: ToolSet;
  /**
   * Kept as a list, not a joined string: a caller that caches a static prefix
   * needs the parts that change to stay separate from the parts that do not.
   */
  readonly system?: string | SystemModelMessage[];
  /**
   * Provider-specific settings for this call — prompt caching, for instance.
   * Typed off `streamText` itself, because the SDK keeps the name internal.
   */
  readonly providerOptions?: NonNullable<
    Parameters<typeof streamText>[0]["providerOptions"]
  >;
  readonly abortSignal?: AbortSignal;
  readonly maxSteps?: number;
  /**
   * Store the provider history after each finished step, so a turn that dies
   * later keeps the model's memory of the steps that finished.
   *
   * Called with the whole history so far — the messages this turn started from
   * plus every finished step — never a delta. Each call supersedes the last,
   * and a turn that finishes normally has last called it with exactly the
   * `messages` its result returns, so storing both writes no step twice.
   *
   * Not called for the step that captured a pause. That history is the pause's
   * continuation; it becomes the conversation's history once the pause is
   * stored, which the caller does from the result, as it always has. A step
   * that died inside a tool never finished, so its memory is not saved — its
   * card is.
   *
   * A rejection stops the loop, and the turn rejects with it.
   */
  readonly saveHistory?: (messages: readonly ModelMessage[]) => Promise<void>;
}

export interface HostTurnResult {
  readonly kind: "settled" | "paused" | "pause_rejected";
  readonly pause: PublicPause | null;
  /** Present when a tool asked to pause on a kind or payload the registry refused. */
  readonly rejection?: string;
  /** As the stored message holds them: one card per `cardId`, however often written. */
  readonly parts: readonly ChatPart[];
  /** Provider history after this turn — the continuation when paused. */
  readonly messages: readonly ModelMessage[];
  /**
   * Generation did not finish: the provider failed, or the request was aborted.
   *
   * Anything a tool committed still stands and is still in `parts`; what is
   * missing is the reply that would have explained it. Reported rather than
   * thrown so a caller can log it — a turn that ends this way is otherwise
   * silent on both sides of the wire.
   */
  readonly interrupted: boolean;
}

async function runLoop<T extends AnyTypes>(
  options: HostTurnOptions<T>,
  /**
   * Parts already earned — a write that committed before this turn began. They
   * are stored **before** generation is attempted, so a provider failure or a
   * disconnect cannot take the result down with the explanation.
   */
  commitFirst: readonly ChatPart[],
): Promise<HostTurnResult> {
  const state: TurnState = {
    paused: undefined,
    cards: [],
    chain: Promise.resolve(),
    stepMessages: [],
    interrupted: false,
    failure: undefined,
  };

  /** The cards as they were written, for the report. Never written again. */
  function cardParts(): ChatPart[] {
    return state.cards.map(cardPart);
  }

  async function append(parts: readonly ChatPart[]): Promise<void> {
    if (parts.length === 0) {
      return;
    }
    await options.kit.messages.write(
      { conversationId: options.conversationId, bind: options.bind },
      {
        kind: "append",
        messageId: options.messageId,
        role: "assistant",
        parts,
      },
    );
  }

  /** A write during the run: held on failure, and nothing after it is tried. */
  async function duringRun(write: () => Promise<void>): Promise<void> {
    if (state.failure !== undefined) {
      return;
    }
    try {
      await write();
    } catch (error) {
      state.failure = { error };
    }
  }

  /**
   * The run is over, but a tool may still be finishing: an abort rejects the
   * result without waiting for the tool in flight, and that tool's card write
   * must land before the end of the turn writes to the same message.
   */
  async function settled(): Promise<void> {
    await state.chain;
    if (state.failure !== undefined) {
      throw state.failure.error;
    }
  }

  const saveHistory = options.saveHistory;

  await append(commitFirst);

  const result = streamText({
    model: options.model,
    messages: [...options.messages],
    tools: pausingTools(options.tools, state, (card) =>
      duringRun(() => append([cardPart(card)])),
    ),
    stopWhen: [
      stepCountIs(options.maxSteps ?? DEFAULT_MAX_STEPS),
      () => state.paused !== undefined,
      () => state.failure !== undefined,
    ],
    onStepFinish: async (step) => {
      state.stepMessages.push(...step.response.messages);
      if (saveHistory !== undefined && state.paused === undefined) {
        const history = [...options.messages, ...state.stepMessages];
        await duringRun(() => saveHistory(history));
      }
    },
    onError: () => {
      state.interrupted = true;
    },
    ...(options.system !== undefined ? { system: options.system } : {}),
    ...(options.providerOptions !== undefined
      ? { providerOptions: options.providerOptions }
      : {}),
    ...(options.abortSignal !== undefined
      ? { abortSignal: options.abortSignal }
      : {}),
  });

  let messages: ModelMessage[];
  let text: string;
  try {
    await result.consumeStream();
    messages = [...options.messages, ...(await result.responseMessages)];
    text = await result.text;
  } catch {
    await settled();
    // Reached when nothing at all was generated, and when the run was aborted
    // mid-flight — a phone that lost the network or moved to the background.
    //
    // What a tool already committed is already stored: its card was written
    // when the tool completed (SHO-546, SHO-568). The empty text part follows
    // it, so the same message reads "this was done, and then something broke".
    const failed: ChatPart = { kind: "text", text: "", status: "error" };
    await append([failed]);
    return {
      kind: "settled",
      pause: null,
      parts: appendParts([], [...commitFirst, ...cardParts(), failed]),
      // The steps that finished, when any did. An abort inside a tool leaves
      // none — the step had not finished — and then the model's memory of this
      // turn is genuinely gone even though the write stands. That is the seam a
      // repeat can walk into twice, and it is closed by the command receipt in
      // SHO-547, not here.
      messages:
        state.stepMessages.length > 0
          ? [...options.messages, ...state.stepMessages]
          : options.messages,
      interrupted: true,
    };
  }
  await settled();

  // Two ways to get here without having finished. The stream carried an error
  // and `consumeStream` swallowed it; or the signal was aborted between steps,
  // which the SDK treats as a clean stop and reports as an ordinary result.
  //
  // Both are the same event to the person — the turn ended early — so both are
  // marked the same way. Reading the signal rather than only the error is what
  // keeps that true: measured, an abort that lands *inside* a tool rejects and
  // an abort a moment later does not, and one dropped connection must not write
  // two different-looking messages depending on which microsecond it hit.
  const interrupted =
    state.interrupted || options.abortSignal?.aborted === true;

  // Only what the end of the turn produced. The cards are stored already, and
  // sending them again would count as a second write of each (SHO-551).
  const parts: ChatPart[] = [];
  if (interrupted) {
    // Whatever text arrived before the break is kept and marked `error`: it is
    // a fragment, and a fragment presented as the answer is worse than none.
    parts.push({ kind: "text", text, status: "error" });
  } else if (text.length > 0) {
    parts.push({ kind: "text", text, status: "complete" });
  }

  let pause: PublicPause | null = null;
  let rejection: string | undefined;

  if (state.paused !== undefined) {
    const captured = state.paused;
    // Kept separately: the guard below narrows the outcome's own field, which
    // leaves nothing to print in the negative branch.
    const requestedKind: string = captured.outcome.interaction;
    const id = providerToolCallId(captured.toolCallId);
    if (id.kind !== "ok") {
      // An id the provider would reject cannot become a continuation.
      rejection = `unsendable tool call id: ${captured.toolCallId}`;
    } else if (!options.kit.interactions.has(captured.outcome.interaction)) {
      rejection = `unknown interaction kind: ${requestedKind}`;
    } else {
      const opened = await options.kit.open({
        conversationId: options.conversationId,
        bind: options.bind,
        kind: captured.outcome.interaction,
        prompt: captured.outcome.prompt,
        secret: captured.outcome.secret,
        continuation: {
          messages,
          pausedToolCall: { id: id.id, name: captured.toolName },
        },
      });
      if (opened.kind === "opened") {
        pause = opened.pause;
        parts.push({
          kind: "interaction",
          interactionId: opened.pause.interactionId,
          revision: opened.pause.revision,
          pause: opened.pause,
        });
      } else if (opened.kind === "already_open") {
        pause = opened.current;
      } else {
        rejection =
          opened.kind === "invalid_prompt"
            ? `invalid prompt for ${requestedKind}: ${opened.reason}`
            : `unknown interaction kind: ${opened.kindName}`;
      }
    }
  }

  await append(parts);

  return {
    kind:
      rejection !== undefined
        ? "pause_rejected"
        : pause !== null
          ? "paused"
          : "settled",
    pause,
    ...(rejection !== undefined ? { rejection } : {}),
    parts: appendParts([], [...commitFirst, ...cardParts(), ...parts]),
    messages,
    interrupted,
  };
}

/** A fresh turn from a new user message. */
export function runHostTurn<T extends AnyTypes>(
  options: HostTurnOptions<T>,
): Promise<HostTurnResult> {
  return runLoop(options, []);
}

export interface ContinueHostTurnOptions<T extends AnyTypes> extends Omit<
  HostTurnOptions<T>,
  "messages"
> {
  readonly claimed: Extract<ClaimResult, { kind: "claimed" }>;
  /**
   * What the paused tool would have returned had the person answered inline.
   * The caller produces it by running the real action with the resolved value,
   * so the effect happens once, here, and not during preparation.
   */
  readonly resolved: Extract<ToolOutcome, { kind: "ok" }>;
}

/** Phase two: the same loop, over the replayed continuation. */
export function continueHostTurn<T extends AnyTypes>(
  options: ContinueHostTurnOptions<T>,
): Promise<HostTurnResult> {
  const { claimed, resolved, ...rest } = options;
  const { messages } = options.kit.resume(claimed, resolved.result);
  const earned: ChatPart[] =
    resolved.card === undefined ? [] : [cardPart(resolved.card)];
  return runLoop({ ...rest, messages }, earned);
}
