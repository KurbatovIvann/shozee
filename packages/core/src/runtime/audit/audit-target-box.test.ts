import { describe, expect, it } from "vitest";

import { CoreInvariantError } from "../../errors/index.js";
import {
  createAuditTargetBox,
  rejectNonHandlerAuditTarget,
} from "./audit-target-box.js";

describe("the resolved audit target is set once per invocation", () => {
  it("holds nothing until the handler records an id", () => {
    const box = createAuditTargetBox("orders.confirm");
    expect(box.resolvedId()).toBeUndefined();

    box.record("order-1");
    expect(box.resolvedId()).toBe("order-1");
  });

  it("refuses a second id and keeps the first", () => {
    const box = createAuditTargetBox("orders.confirm");
    box.record("order-1");

    expect(() => {
      box.record("order-2");
    }).toThrow(CoreInvariantError);
    expect(box.resolvedId()).toBe("order-1");
  });

  it("gives every invocation its own box", () => {
    const first = createAuditTargetBox("orders.confirm");
    const second = createAuditTargetBox("orders.confirm");
    first.record("order-1");

    expect(second.resolvedId()).toBeUndefined();
  });

  it("refuses a target recorded outside the handler", () => {
    for (const phase of ["authorization preflight", "preview"] as const) {
      const reject = rejectNonHandlerAuditTarget("orders.confirm", phase);
      expect(() => {
        reject("order-1");
      }).toThrow(new RegExp(phase));
    }
  });
});
