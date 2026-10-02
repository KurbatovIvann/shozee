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

  it("builds a runtime detail out of the thrown cause alone", () => {
    const cause = new TypeError("cannot read properties of null");
    const answer = shoFailureOf(cause);
    expect(answer.reply).toEqual({ kind: "failed", code: "TypeError" });
    expect(answer.detail).toEqual({
      message: "cannot read properties of null",
      stack: cause.stack,
    });
    expect(JSON.stringify(answer)).not.toContain("кави");
  });

  it("caps the message and the stack it hands to the log", () => {
    const answer = shoFailureOf(
      new Error("x".repeat(SHO_FAILURE_DETAIL_LIMIT * 3)),
    );
    expect(answer.detail?.message).toHaveLength(SHO_FAILURE_DETAIL_LIMIT + 1);
    expect(answer.detail?.message.endsWith("…")).toBe(true);
    expect(answer.detail?.stack).toHaveLength(SHO_FAILURE_DETAIL_LIMIT + 1);
  });

  it("names an unknown code for a throw that is not an Error", () => {
    expect(shoFailureOf("plain throw")).toEqual({
      reply: { kind: "failed", code: "unknown" },
      detail: { message: "plain throw", stack: null },
    });
  });
});
