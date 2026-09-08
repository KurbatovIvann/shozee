import type { EvalExpectation } from "./expectation.js";

export interface EvalUserTurn {
  readonly text: string;
}

export type EvalFixtureKind = "proof";

/** Live host is `runStaffAssistantHostTurn` (ADR-0037 / SHO-524). */
export type EvalAssistantHost = "live" | "new";

export interface EvalScenario {
  readonly id: string;
  readonly description: string;
  readonly fixture: EvalFixtureKind;
  readonly turns: readonly EvalUserTurn[];
  readonly expectation: EvalExpectation;
  /** Both values drive `runStaffAssistantHostTurn` (SHO-524). */
  readonly host?: EvalAssistantHost;
}
