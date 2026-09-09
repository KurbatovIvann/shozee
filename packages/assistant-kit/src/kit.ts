/**
 * The public surface. Signatures only — no implementation in this commit.
 *
 * Scope, stated so it can be checked rather than remembered. The kit does
 * not: call a model, mount HTTP, own storage, render UI, hold a tool
 * registry, run a queue, or name a domain concept. A domain word appearing
 * anywhere in `src` is the failure signal — `no-domain.test.ts` enforces it.
 */
import type { ChatDocument, DocumentWrite } from "./document.js";
import type {
  Answer,
  ClaimResult,
  PauseRecord,
  PauseScope,
  PublicPause,
  ResumeInput,
} from "./pause.js";
import type { ToolOutcome } from "./outcome.js";

export interface OpenPauseInput<TInput> {
  readonly conversationId: string;
  /** Opaque owner token. See `PauseRecord.bind`. */
  readonly bind: string;
  readonly outcome: Extract<
    ToolOutcome<TInput>,
    { kind: "needs_choice" | "needs_confirmation" }
  >;
  readonly continuation: PauseRecord<TInput>["continuation"];
}

export type OpenPauseResult =
  | { readonly kind: "opened"; readonly pause: PublicPause }
  /** One open interaction per conversation. The caller decides: replace or refuse. */
  | { readonly kind: "already_open"; readonly current: PublicPause };

export type RevisePauseResult = OpenPauseResult | { readonly kind: "gone" };

export interface AssistantKit {
  /**
   * Store the pause. Called from inside the tool wrapper, before the turn
   * returns, so a claim arriving immediately after the response finds it.
   */
  open<TInput>(input: OpenPauseInput<TInput>): Promise<OpenPauseResult>;

  /** Read-only. Safe to call on every document read. */
  peek(scope: PauseScope): Promise<PublicPause | null>;

  /**
   * Consume one (interactionId, revision) exactly once. Concurrent callers:
   * one gets `claimed`, the rest get `gone`.
   */
  claim<TInput>(
    input: PauseScope & {
      readonly interactionId: string;
      readonly revision: number;
      readonly answer: Answer;
    },
  ): Promise<ClaimResult<TInput>>;

  /**
   * Turn a claim into the exact provider payload. Pure: no I/O, no clock.
   * `output` is what the paused tool should have returned had the human
   * answered inline — the model sees a normal tool result.
   */
  resume<TInput>(
    claimed: Extract<ClaimResult<TInput>, { kind: "claimed" }>,
    output: unknown,
  ): ResumeInput;

  /** Resolve `optionId` on the server. The client never sends an entity id. */
  entityIdFor<TInput>(
    record: PauseRecord<TInput>,
    optionId: string,
  ): string | undefined;

  /**
   * Raise the revision when the subject of the decision changes. `gone` when
   * there is no open pause under that id any more — the caller opens a fresh
   * one rather than reviving an expired decision.
   */
  revise<TInput>(
    input: PauseScope & {
      readonly interactionId: string;
      readonly next: Omit<OpenPauseInput<TInput>, "conversationId" | "bind">;
    },
  ): Promise<RevisePauseResult>;

  abandon(
    input: PauseScope & { readonly interactionId: string },
  ): Promise<{ readonly kind: "cancelled" | "gone" }>;

  /**
   * Make a claimed pause answerable again, at the same revision.
   *
   * For the case where the answer was accepted but the action it authorised
   * had no effect — a validation failure, a conflict. The caller asserts the
   * absence of effect; the kit cannot know it. Do not call this after a write
   * that may have committed: the domain's idempotency key, not this, is what
   * makes a retry safe.
   */
  release(
    input: PauseScope & { readonly interactionId: string },
  ): Promise<{ readonly kind: "released" | "gone" }>;

  readonly document: {
    read(scope: PauseScope): Promise<ChatDocument>;
    write(conversationId: string, write: DocumentWrite): Promise<void>;
  };
}

/** Wired by the consumer in its composition root. */
export { createAssistantKit } from "./create-kit.js";
