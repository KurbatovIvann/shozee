import type { EvalExpectation } from "./expectation.js";

export interface EvalUserTurn {
  readonly text: string;
}

export type EvalFixtureKind = "proof";

export interface EvalScenario {
  readonly id: string;
  readonly description: string;
  readonly fixture: EvalFixtureKind;
  readonly turns: readonly EvalUserTurn[];
  readonly expectation: EvalExpectation;
}
