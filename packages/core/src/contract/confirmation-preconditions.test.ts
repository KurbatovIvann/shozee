import { describe, expect, it } from "vitest";

import {
  CONFIRMABLE_RISKS,
  isConfirmableRisk,
} from "./confirmation-preconditions.js";
import { ACTION_RISKS } from "./types.js";
import type { ActionRisk } from "./types.js";

const RISK_IS_CONFIRMABLE: Record<ActionRisk, boolean> = {
  read: false,
  draft: false,
  write: true,
  high: true,
};

describe("confirmable risks", () => {
  it("classifies every risk the contract can declare", () => {
    expect([...ACTION_RISKS].sort()).toEqual(
      Object.keys(RISK_IS_CONFIRMABLE).sort(),
    );
  });

  it("holds exactly the risks a person can be asked to confirm", () => {
    expect([...CONFIRMABLE_RISKS].sort()).toEqual(
      ACTION_RISKS.filter((risk) => RISK_IS_CONFIRMABLE[risk]).sort(),
    );
  });

  it("guards each risk the same way the set lists it", () => {
    for (const risk of ACTION_RISKS) {
      expect(isConfirmableRisk(risk)).toBe(RISK_IS_CONFIRMABLE[risk]);
    }
  });
});
