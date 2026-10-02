import { afterEach, describe, expect, it } from "vitest";

import type { ShoContextUpload, ShoEngine, ShoParseJob } from "./engine.ts";
import { createShoPool, shoSlotOf, type ShoWorkerLoss } from "./pool.ts";

const WORKER_URL = new URL("../test/worker.fixture.ts", import.meta.url);

const NOW = { year: 2026, month: 10, day: 2, hour: 11, minute: 0 };

const uploadOf = (key: string, fingerprint = "fp-1"): ShoContextUpload => ({
  key,
  fingerprint,
  revision: "rev-1",
  context: { version: 2 },
  phrases: [`phrase for ${key}`],
  uploadBytes: 64,
});

const jobOf = (
  key: string,
  text: string,
  overrides: Partial<ShoParseJob> = {},
): ShoParseJob => ({
  key,
  fingerprint: "fp-1",
  text,
  now: NOW,
  previous: null,
  debug: false,
  deadlineMs: 5_000,
  ...overrides,
});

function keyForSlot(slot: number, size: number): string {
  for (let at = 0; at < 500; at += 1) {
    const key = `company${String(at)}:scope1`;
    if (shoSlotOf(key, size) === slot) return key;
  }
  return "company0:scope1";
}

describe("apps/sho worker pool", () => {
  let pools: ShoEngine[] = [];
  const losses: [number, ShoWorkerLoss][] = [];

  const open = async (
    size: number,
    queueLimit?: number,
  ): Promise<ShoEngine> => {
    const pool = await createShoPool({
      size,
      workerUrl: WORKER_URL,
      ...(queueLimit === undefined ? {} : { queueLimit }),
      onLoss: (slot, loss) => losses.push([slot, loss]),
    });
    pools.push(pool);
    return pool;
  };

  const untilStored = async (pool: ShoEngine, key: string): Promise<void> => {
    for (let tick = 0; tick < 200; tick += 1) {
      const stored = await pool.store(uploadOf(key));
      if (stored.kind === "stored") return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect.unreachable(`worker for ${key} never came back`);
  };

  afterEach(async () => {
    await Promise.all(pools.map((pool) => pool.dispose()));
    pools = [];
    losses.length = 0;
  });

  it("parses through a worker and reports the pooled size", async () => {
    const pool = await open(2);
    const key = keyForSlot(0, 2);
    expect(pool.workers).toBe(2);
    expect(pool.stamp.id).toBe("fixture");

    await expect(pool.store(uploadOf(key))).resolves.toEqual({
      kind: "stored",
    });
    const ran = await pool.run(jobOf(key, "дай каву"));
    expect(ran.kind).toBe("ok");
    if (ran.kind !== "ok") return;
    expect(ran.contextRevision).toBe("rev-1");
    expect(ran.result.raw).toBe("дай каву");
  });

  it("answers context_required until the key's own worker holds it", async () => {
    const pool = await open(2);
    const key = keyForSlot(1, 2);
    await expect(pool.run(jobOf(key, "дай каву"))).resolves.toEqual({
      kind: "context_required",
    });
    await pool.store(uploadOf(key));
    await expect(
      pool.run(jobOf(key, "x", { fingerprint: "fp-2" })),
    ).resolves.toEqual({ kind: "context_required" });
    await expect(pool.phrases(key)).resolves.toEqual([`phrase for ${key}`]);
    await expect(pool.phrases(keyForSlot(0, 2))).resolves.toBeNull();
  });

  it("keeps one context key on one worker and spreads other keys", async () => {
    const pool = await open(2);
    const here = keyForSlot(0, 2);
    const there = keyForSlot(1, 2);
    await pool.store(uploadOf(here));
    await pool.store(uploadOf(there));

    const threads = await Promise.all(
      [here, here, here, there].map(async (key) => {
        const ran = await pool.run(jobOf(key, "дай каву"));
        return ran.kind === "ok" ? ran.result.text : "none";
      }),
    );
    expect(new Set(threads.slice(0, 3)).size).toBe(1);
    expect(threads[3]).not.toBe(threads[0]);
  });

  it("answers busy once the sticky worker's queue is full", async () => {
    const pool = await open(1, 1);
    const key = keyForSlot(0, 1);
    await pool.store(uploadOf(key));

    const hanging = pool.run(jobOf(key, "hang", { deadlineMs: 400 }));
    await expect(pool.run(jobOf(key, "дай каву"))).resolves.toEqual({
      kind: "busy",
    });
    await expect(hanging).resolves.toEqual({ kind: "deadline" });
  });

  it("replaces a crashed worker and answers its waiting requests busy", async () => {
    const pool = await open(1, 4);
    const key = keyForSlot(0, 1);
    await pool.store(uploadOf(key));

    const crashing = pool.run(jobOf(key, "crash"));
    const queued = pool.run(jobOf(key, "дай каву"));
    await expect(crashing).resolves.toEqual({ kind: "busy" });
    await expect(queued).resolves.toEqual({ kind: "busy" });
    expect(losses).toContainEqual([0, "crashed"]);

    await untilStored(pool, key);
    const ran = await pool.run(jobOf(key, "дай каву"));
    expect(ran.kind).toBe("ok");
  });

  it("terminates a worker a run hangs in and serves the replacement", async () => {
    const pool = await open(1);
    const key = keyForSlot(0, 1);
    await pool.store(uploadOf(key));

    const before = await pool.run(jobOf(key, "дай каву"));
    await expect(
      pool.run(jobOf(key, "hang", { deadlineMs: 300 })),
    ).resolves.toEqual({ kind: "deadline" });
    expect(losses).toEqual([[0, "hung"]]);

    await untilStored(pool, key);
    const after = await pool.run(jobOf(key, "дай каву"));
    expect(after.kind).toBe("ok");
    if (before.kind !== "ok" || after.kind !== "ok") return;
    expect(after.result.text).not.toBe(before.result.text);
  });

  it("reports a worker failure and an input refusal apart", async () => {
    const pool = await open(1);
    const key = keyForSlot(0, 1);
    await pool.store(uploadOf(key));
    await expect(pool.run(jobOf(key, "boom"))).resolves.toEqual({
      kind: "failed",
      message: "boom",
    });
    await expect(pool.run(jobOf(key, "bad"))).resolves.toEqual({
      kind: "input",
    });
  });

  it("answers busy after dispose instead of waking a dead worker", async () => {
    const pool = await open(1);
    const key = keyForSlot(0, 1);
    await pool.dispose();
    await expect(pool.run(jobOf(key, "дай каву"))).resolves.toEqual({
      kind: "busy",
    });
    await expect(pool.phrases(key)).resolves.toBeNull();
  });

  it("spreads keys over every slot it was given", () => {
    const slots = new Set<number>();
    for (let at = 0; at < 200; at += 1) {
      slots.add(shoSlotOf(`company${String(at)}:scope1`, 4));
    }
    expect(slots).toEqual(new Set([0, 1, 2, 3]));
  });
});
