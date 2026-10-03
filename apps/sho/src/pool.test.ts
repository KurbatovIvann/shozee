import { afterEach, describe, expect, it } from "vitest";

import { SHO_CONTEXT_CACHE_UPLOAD_BYTES } from "./contexts.ts";
import type { ShoContextUpload, ShoEngine, ShoParseJob } from "./engine.ts";
import {
  SHO_WORKER_CACHE_FLOOR_BYTES,
  createShoPool,
  shoSlotOf,
  shoWorkerCacheBytes,
  type ShoWorkerLoss,
} from "./pool.ts";

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
  focus: null,
  debug: false,
  deadlineMs: 5_000,
  ...overrides,
});

function keyForSlot(slot: number, size: number, scope = "scope1"): string {
  for (let at = 0; at < 500; at += 1) {
    const key = `company${String(at)}:${scope}`;
    if (shoSlotOf(key, size) === slot) return key;
  }
  return `company0:${scope}`;
}

describe("apps/sho worker pool", () => {
  let pools: ShoEngine[] = [];
  const losses: [number, ShoWorkerLoss][] = [];

  const open = async (
    size: number,
    extra: Parameters<typeof createShoPool>[0] = {},
  ): Promise<ShoEngine> => {
    const pool = await createShoPool({
      size,
      workerUrl: WORKER_URL,
      ...extra,
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
    delete process.env.SHO_FIXTURE_EXIT;
    await Promise.all(pools.map((pool) => pool.dispose()));
    pools = [];
    losses.length = 0;
  });

  it("parses through a worker and reports the pooled size", async () => {
    const pool = await open(2);
    const key = keyForSlot(0, 2);
    expect(pool.workers).toBe(2);
    expect(pool.ready).toBe(true);
    expect(pool.stamp.id).toBe("fixture");

    await expect(pool.store(uploadOf(key))).resolves.toEqual({
      kind: "stored",
    });
    const ran = await pool.run(jobOf(key, "дай каву"));
    expect(ran.kind).toBe("parsed");
    if (ran.kind !== "parsed") return;
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
    await expect(pool.phrases(key)).resolves.toEqual({
      kind: "phrases",
      phrases: [`phrase for ${key}`],
    });
    await expect(pool.phrases(keyForSlot(0, 2))).resolves.toEqual({
      kind: "phrases",
      phrases: null,
    });
  });

  it("sends every scope of one company to that company's worker", async () => {
    const pool = await open(2);
    const company = keyForSlot(0, 2).split(":")[0] ?? "company0";
    const other = keyForSlot(1, 2).split(":")[0] ?? "company1";
    for (const scope of ["a1", "b2", "c3"]) {
      expect(shoSlotOf(`${company}:${scope}`, 2)).toBe(
        shoSlotOf(`${company}:scope1`, 2),
      );
    }
    await pool.store(uploadOf(`${company}:a1`));
    await pool.store(uploadOf(`${company}:b2`));
    await pool.store(uploadOf(`${other}:a1`));
    const threads = await Promise.all(
      [`${company}:a1`, `${company}:b2`, `${other}:a1`].map(async (key) => {
        const ran = await pool.run(jobOf(key, "дай каву"));
        return ran.kind === "parsed" ? ran.result.text : "none";
      }),
    );
    expect(threads[0]).toBe(threads[1]);
    expect(threads[2]).not.toBe(threads[0]);
  });

  it("answers busy once the sticky worker's queue is full", async () => {
    const pool = await open(1, { queueLimit: 1 });
    const key = keyForSlot(0, 1);
    await pool.store(uploadOf(key));

    const slow = pool.run(jobOf(key, "slow"));
    await expect(pool.run(jobOf(key, "дай каву"))).resolves.toEqual({
      kind: "busy",
    });
    expect((await slow).kind).toBe("parsed");
  });

  it("drops a queued job on its deadline without killing a healthy worker", async () => {
    const pool = await open(1, { queueLimit: 4 });
    const key = keyForSlot(0, 1);
    await pool.store(uploadOf(key));

    const slow = pool.run(jobOf(key, "slow"));
    const queued = pool.run(jobOf(key, "дай каву", { deadlineMs: 20 }));
    await expect(queued).resolves.toEqual({ kind: "deadline" });
    expect(losses).toEqual([]);
    expect((await slow).kind).toBe("parsed");
    expect(pool.ready).toBe(true);

    const after = await pool.run(jobOf(key, "дай каву"));
    expect(after.kind).toBe("parsed");
  });

  it("spends one deadline across the wait and the run", async () => {
    const pool = await open(1, { queueLimit: 4 });
    const key = keyForSlot(0, 1);
    await pool.store(uploadOf(key));

    const held = pool.run(jobOf(key, "slow"));
    const started = performance.now();
    const queued = await pool.run(jobOf(key, "slow", { deadlineMs: 260 }));
    const spent = performance.now() - started;
    expect(queued).toEqual({ kind: "deadline" });
    expect(spent).toBeLessThan(400);
    expect(losses).toEqual([]);
    expect((await held).kind).toBe("parsed");
  });

  it("answers 504 for a run past its deadline and keeps that worker", async () => {
    const pool = await open(1);
    const key = keyForSlot(0, 1);
    await pool.store(uploadOf(key));

    const before = await pool.run(jobOf(key, "дай каву"));
    await expect(
      pool.run(jobOf(key, "slow", { deadlineMs: 20 })),
    ).resolves.toEqual({ kind: "deadline" });
    expect(losses).toEqual([]);

    const after = await pool.run(jobOf(key, "дай каву"));
    expect(after.kind).toBe("parsed");
    if (before.kind !== "parsed" || after.kind !== "parsed") return;
    expect(after.result.text).toBe(before.result.text);
  });

  it("terminates a worker only past the hang threshold", async () => {
    const pool = await open(1, { hangMs: 120 });
    const key = keyForSlot(0, 1);
    await pool.store(uploadOf(key));

    const before = await pool.run(jobOf(key, "дай каву"));
    await expect(
      pool.run(jobOf(key, "hang", { deadlineMs: 20 })),
    ).resolves.toEqual({ kind: "deadline" });
    for (let tick = 0; tick < 100 && losses.length === 0; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(losses).toEqual([[0, "hung"]]);

    await untilStored(pool, key);
    const after = await pool.run(jobOf(key, "дай каву"));
    expect(after.kind).toBe("parsed");
    if (before.kind !== "parsed" || after.kind !== "parsed") return;
    expect(after.result.text).not.toBe(before.result.text);
  });

  it("replaces a crashed worker and answers its waiting requests busy", async () => {
    const pool = await open(1, { queueLimit: 4, respawnBackoffMs: 1 });
    const key = keyForSlot(0, 1);
    await pool.store(uploadOf(key));

    const crashing = pool.run(jobOf(key, "crash"));
    const queued = pool.run(jobOf(key, "дай каву"));
    await expect(crashing).resolves.toEqual({ kind: "busy" });
    await expect(queued).resolves.toEqual({ kind: "busy" });
    expect(losses).toContainEqual([0, "crashed"]);

    await untilStored(pool, key);
    const ran = await pool.run(jobOf(key, "дай каву"));
    expect(ran.kind).toBe("parsed");
  });

  it("fails startup when a worker exits before it reports ready", async () => {
    process.env.SHO_FIXTURE_EXIT = "1";
    await expect(
      createShoPool({ size: 1, workerUrl: WORKER_URL }),
    ).rejects.toThrow("sho worker run failed");
  });

  it("stops respawning after the failure cap and reports not ready", async () => {
    const pool = await open(1, {
      queueLimit: 4,
      respawnBackoffMs: 1,
      respawnLimit: 3,
    });
    const key = keyForSlot(0, 1);
    await pool.store(uploadOf(key));

    process.env.SHO_FIXTURE_EXIT = "1";
    await pool.run(jobOf(key, "crash"));
    for (let tick = 0; tick < 200 && pool.ready; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    for (let tick = 0; tick < 200 && losses.length < 4; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(pool.ready).toBe(false);
    expect(losses).toHaveLength(4);
    await expect(pool.run(jobOf(key, "дай каву"))).resolves.toEqual({
      kind: "busy",
    });
  });

  it("reports a worker failure and an input refusal apart", async () => {
    const failures: [string, unknown][] = [];
    const pool = await open(1, {
      onFailure: (code, detail) => failures.push([code, detail]),
    });
    const key = keyForSlot(0, 1);
    await pool.store(uploadOf(key));
    await expect(pool.run(jobOf(key, "boom"))).resolves.toEqual({
      kind: "failed",
      code: "boom",
    });
    expect(failures).toEqual([
      ["boom", { frames: "at fixture (worker.fixture.ts:1:1)" }],
    ]);
    await expect(pool.run(jobOf(key, "bad"))).resolves.toEqual({
      kind: "input",
    });
  });

  it("splits the total context cache budget and never goes under one upload", async () => {
    const pool = await open(4);
    expect(shoWorkerCacheBytes(4)).toBe(
      Math.floor(SHO_CONTEXT_CACHE_UPLOAD_BYTES / 4),
    );
    expect(shoWorkerCacheBytes(4096)).toBe(SHO_WORKER_CACHE_FLOOR_BYTES);
    const ran = await pool.run(jobOf(keyForSlot(0, 4), "budget"));
    expect(ran.kind).toBe("parsed");
    if (ran.kind !== "parsed") return;
    expect(ran.result.raw).toBe(String(shoWorkerCacheBytes(4)));
  });

  it("answers busy after dispose instead of waking a dead worker", async () => {
    const pool = await open(1);
    const key = keyForSlot(0, 1);
    await pool.dispose();
    expect(pool.ready).toBe(false);
    await expect(pool.run(jobOf(key, "дай каву"))).resolves.toEqual({
      kind: "busy",
    });
    await expect(pool.phrases(key)).resolves.toEqual({ kind: "busy" });
  });

  it("spreads companies over every slot it was given", () => {
    const slots = new Set<number>();
    for (let at = 0; at < 200; at += 1) {
      slots.add(shoSlotOf(`company${String(at)}:scope1`, 4));
    }
    expect(slots).toEqual(new Set([0, 1, 2, 3]));
  });
});
