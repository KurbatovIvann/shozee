import { InputError } from "@showzy/sho";
import { describe, expect, it } from "vitest";

import { SHO_FAILURE_DETAIL_LIMIT, shoFailureOf } from "./failure.ts";

const REQUEST = "створи замовлення для олени: 2 кави і круасан";

describe("the failure answer a Шо worker sends back", () => {
  it("carries no detail for an InputError that quotes the request text", () => {
    const quoting = new InputError(
      "text_not_normalised",
      `the text is not normalised (normalised: «${REQUEST}»); pass recognised speech as {raw}`,
    );
    const answer = shoFailureOf(quoting);
    expect(answer).toEqual({ reply: { kind: "input" }, detail: undefined });
    expect(JSON.stringify(answer)).not.toContain("кави");
  });

  it("carries no detail for any other InputError either", () => {
    expect(
      shoFailureOf(
        new InputError("empty_input", "the input is empty after normalisation"),
      ),
    ).toEqual({ reply: { kind: "input" }, detail: undefined });
  });

  it("keeps only the stack frames of a runtime failure, never its message", () => {
    const cause = new TypeError(`cannot read «${REQUEST}» of null`);
    const answer = shoFailureOf(cause);
    expect(answer.reply).toEqual({ kind: "failed", code: "TypeError" });
    expect(JSON.stringify(answer)).not.toContain("кави");
    const frames = answer.detail?.frames ?? "";
    expect(frames).toContain("failure.test.ts");
    for (const line of frames.split("\n")) {
      expect(line.startsWith("at ")).toBe(true);
    }
  });

  it("drops a header-shaped message line that is not a stack frame", () => {
    const cause = new Error(`at ${REQUEST}`);
    expect(shoFailureOf(cause).detail?.frames).not.toContain("кави");
  });

  it("caps the frames it hands to the log at the limit", () => {
    const cause = new Error("deep");
    cause.stack = [
      "Error: deep",
      ...Array.from(
        { length: 400 },
        (_, at) => `    at frame${String(at)} (pipeline.ts:${String(at)}:1)`,
      ),
    ].join("\n");
    const frames = shoFailureOf(cause).detail?.frames ?? "";
    expect(frames.length).toBe(SHO_FAILURE_DETAIL_LIMIT);
    expect(frames.endsWith("…")).toBe(true);
  });

  it("names an unknown code and no frames for a throw that is not an Error", () => {
    expect(shoFailureOf(REQUEST)).toEqual({
      reply: { kind: "failed", code: "unknown" },
      detail: { frames: null },
    });
  });
});
