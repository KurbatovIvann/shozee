import type { EvalExpectation } from "./expectation.js";

export interface EvalUserTurn {
  readonly text: string;
}

export type EvalFixtureKind = "proof";

/** Live HTTP stream vs T1 test-only host (ADR-0037). Do not retarget POST /assistant/chat. */
export type EvalAssistantHost = "live" | "new";

export interface EvalScenario {
  readonly id: string;
  readonly description: string;
  readonly fixture: EvalFixtureKind;
  readonly turns: readonly EvalUserTurn[];
  readonly expectation: EvalExpectation;
  /** MODEL_SPEAKS uses the new host; other corpora stay on the live stream. */
  readonly host?: EvalAssistantHost;
}
