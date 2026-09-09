/**
 * The public surface. Signatures only — no implementation in this commit.
 *
 * Scope, stated so it can be checked rather than remembered. The kit does
 * not: call a model, mount HTTP, own storage, render UI, hold a tool
 * registry, run a queue, or name a domain concept. A domain word appearing
 * anywhere in `src` is the failure signal — `no-domain.test.ts` enforces it.
 */
import type { ChatDocument, DocumentWrite } from "./document.js";
import type { KitDeps } from "./ports.js";
import type {
  Answer,
  ClaimResult,
  PauseRecord,
  PublicPause,
  ResumeInput,
} from "./pause.js";
import type { ToolOutcome } from "./outcome.js";

export interface OpenPauseInput<TInput> {
  readonly conversationId: string;
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

export interface AssistantKit {
  /**
   * Store the pause. Called from inside the tool wrapper, before the turn
   * returns, so a claim arriving immediately after the response finds it.
   */
  open<TInput>(input: OpenPauseInput<TInput>): Promise<OpenPauseResult>;

  /** Read-only. Safe to call on every document read. */
  peek(conversationId: string): Promise<PublicPause | null>;

  /**
   * Consume one (interactionId, revision) exactly once. Concurrent callers:
   * one gets `claimed`, the rest get `gone`.
   */
  claim<TInput>(input: {
    readonly conversationId: string;
    readonly interactionId: string;
    readonly revision: number;
    readonly answer: Answer;
  }): Promise<ClaimResult<TInput>>;

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

  /** Raise the revision when the subject of the decision changes. */
  revise<TInput>(input: {
    readonly conversationId: string;
    readonly interactionId: string;
    readonly next: Omit<OpenPauseInput<TInput>, "conversationId">;
  }): Promise<OpenPauseResult>;

  abandon(input: {
    readonly conversationId: string;
    readonly interactionId: string;
  }): Promise<{ readonly kind: "cancelled" | "gone" }>;

  readonly document: {
    read(conversationId: string): Promise<ChatDocument>;
    write(conversationId: string, write: DocumentWrite): Promise<void>;
  };
}

/** Wired by the consumer in its composition root. */
export declare function createAssistantKit(deps: KitDeps): AssistantKit;
