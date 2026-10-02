import { describe, expect, it } from "vitest";

import {
  CONFIRMABLE_RISKS,
  isConfirmableRisk,
} from "./confirmation-preconditions.js";
import type { ActionRisk } from "./types.js";

const RISK_IS_CONFIRMABLE: Record<ActionRisk, boolean> = {
  read: false,
  draft: false,
  write: true,
  high: true,
};

const EVERY_RISK = [
  "read",
  "draft",
  "write",
  "high",
] as const satisfies readonly ActionRisk[];

describe("confirmable risks", () => {
  it("classifies every risk the contract can declare", () => {
    expect([...EVERY_RISK].sort()).toEqual(
      Object.keys(RISK_IS_CONFIRMABLE).sort(),
    );
  });

  it("holds exactly the risks a person can be asked to confirm", () => {
    expect([...CONFIRMABLE_RISKS].sort()).toEqual(
      EVERY_RISK.filter((risk) => RISK_IS_CONFIRMABLE[risk]).sort(),
    );
  });

  it("guards each risk the same way the set lists it", () => {
    for (const risk of EVERY_RISK) {
      expect(isConfirmableRisk(risk)).toBe(RISK_IS_CONFIRMABLE[risk]);
    }
  });
});
