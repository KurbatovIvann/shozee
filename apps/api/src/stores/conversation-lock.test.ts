import { describe, expect, it } from "vitest";

import { createMemoryConversationLock } from "./conversation-lock.js";

describe("createMemoryConversationLock", () => {
  it("serializes overlapping work on the same conversation", async () => {
    const lock = createMemoryConversationLock();
    const order: number[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = lock.withLock(
      "11111111-1111-4111-8111-111111111111",
      async () => {
        order.push(1);
        await firstGate;
        order.push(2);
        return "a";
      },
    );
    const second = lock.withLock(
      "11111111-1111-4111-8111-111111111111",
      async () => {
        order.push(3);
        return "b";
      },
    );
    await Promise.resolve();
    expect(order).toEqual([1]);
    releaseFirst();
    expect(await first).toBe("a");
    expect(await second).toBe("b");
    expect(order).toEqual([1, 2, 3]);
  });

  it("does not serialize different conversations", async () => {
    const lock = createMemoryConversationLock();
    let releaseA!: () => void;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const started: string[] = [];
    const a = lock.withLock(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      async () => {
        started.push("a");
        await gateA;
        return 1;
      },
    );
    const b = lock.withLock(
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      async () => {
        started.push("b");
        return 2;
      },
    );
    await Promise.resolve();
    expect(started).toEqual(["a", "b"]);
    releaseA();
    expect(await a).toBe(1);
    expect(await b).toBe(2);
  });
});
