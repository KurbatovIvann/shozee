import { StaffAssistantNotConfiguredError } from "@showzy/ai";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_EVAL_RUNS,
  EvalRunsConfigError,
  evalRunsFromInjectedFlag,
  parseEvalRuns,
  requireStaffAssistantApiKey,
} from "./config.js";

const AI_UNSET = {
  anthropicApiKey: undefined,
  model: "claude-sonnet-4-6",
  gateModel: "claude-haiku-4-5",
};

describe("parseEvalRuns", () => {
  it("defaults to 3 when argv has no --runs", () => {
    expect(parseEvalRuns(["node", "vitest"])).toBe(DEFAULT_EVAL_RUNS);
    expect(DEFAULT_EVAL_RUNS).toBe(3);
  });

  it("reads --runs=N and --runs N", () => {
    expect(parseEvalRuns(["--runs=1"])).toBe(1);
    expect(parseEvalRuns(["--runs", "2"])).toBe(2);
  });

  it("rejects a non-integer or out-of-range value", () => {
    expect(() => parseEvalRuns(["--runs=0"])).toThrow(EvalRunsConfigError);
    expect(() => parseEvalRuns(["--runs=21"])).toThrow(EvalRunsConfigError);
    expect(() => parseEvalRuns(["--runs=abc"])).toThrow(EvalRunsConfigError);
    expect(() => parseEvalRuns(["--runs"])).toThrow(EvalRunsConfigError);
  });
});

describe("evalRunsFromInjectedFlag", () => {
  it("defaults when the CLI did not pass --runs", () => {
    expect(evalRunsFromInjectedFlag(undefined)).toBe(DEFAULT_EVAL_RUNS);
  });

  it("parses the injected flag and rejects empty", () => {
    expect(evalRunsFromInjectedFlag("1")).toBe(1);
    expect(() => evalRunsFromInjectedFlag("")).toThrow(EvalRunsConfigError);
    expect(() => evalRunsFromInjectedFlag("03")).toThrow(EvalRunsConfigError);
  });
});

describe("requireStaffAssistantApiKey", () => {
  it("throws a typed error with no key material in the stack", () => {
    try {
      requireStaffAssistantApiKey(AI_UNSET);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(StaffAssistantNotConfiguredError);
      expect(error).toMatchObject({
        name: "StaffAssistantNotConfiguredError",
        code: "AI_NOT_CONFIGURED",
        message: "Staff assistant is not configured.",
      });
      const stack = error instanceof Error ? (error.stack ?? "") : "";
      expect(stack).not.toContain("sk-ant");
      expect(stack).not.toContain("ANTHROPIC_API_KEY");
      expect(error instanceof Error ? error.message : "").not.toContain(
        "sk-ant",
      );
    }
  });

  it("returns the configured key", () => {
    expect(
      requireStaffAssistantApiKey({
        anthropicApiKey: "sk-ant-test-not-a-real-key",
        model: "claude-sonnet-4-6",
        gateModel: "claude-haiku-4-5",
      }),
    ).toBe("sk-ant-test-not-a-real-key");
  });
});
