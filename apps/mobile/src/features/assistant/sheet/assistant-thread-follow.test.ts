import { describe, expect, it } from "vitest";

import {
  ASSISTANT_THREAD_START,
  assistantThreadFollow,
  type AssistantThreadEdges,
} from "./assistant-thread-follow";

function rows(...ids: string[]) {
  return ids.map((id) => ({ id }));
}

/** Feeds each list of rows through in order, as successive size changes. */
function follow(...steps: readonly (readonly { id: string }[])[]): boolean[] {
  let edges: AssistantThreadEdges = ASSISTANT_THREAD_START;
  return steps.map((step) => {
    const next = assistantThreadFollow(edges, step);
    edges = next.edges;
    return next.scrollToEnd;
  });
}

describe("assistantThreadFollow", () => {
  it("follows the first load down to the end", () => {
    expect(follow(rows("m3", "m4"))).toEqual([true]);
  });

  it("stays where the person is when an older page arrives above, through the layout passes after it", () => {
    expect(
      follow(
        rows("m3", "m4"),
        rows("m1", "m2", "m3", "m4"),
        rows("m1", "m2", "m3", "m4"),
      ),
    ).toEqual([true, false, false]);
  });

  it("follows again once something arrives at the end", () => {
    expect(
      follow(
        rows("m3", "m4"),
        rows("m1", "m2", "m3", "m4"),
        rows("m1", "m2", "m3", "m4", "wait"),
      ),
    ).toEqual([true, false, true]);
  });

  it("follows a row at the end that grows after it arrived", () => {
    expect(follow(rows("m3", "m4"), rows("m3", "m4"))).toEqual([true, true]);
  });

  it("follows a thread that was replaced by a newer window", () => {
    expect(
      follow(rows("m1", "m2", "m3", "m4"), rows("m8", "m9", "m10")),
    ).toEqual([true, true]);
  });
});
