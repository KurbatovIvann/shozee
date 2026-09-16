import { loadServerConfig } from "@showzy/config";
import { pino, type Logger } from "pino";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { bootWorker } from "./boot.js";
import { JOB_DRAIN_TIMEOUT_MS } from "./policy.js";

const world = vi.hoisted(() => {
  interface Latch {
    readonly opened: Promise<void>;
    open(): void;
  }

  function latch(): Latch {
    let open: () => void = () => undefined;
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });
    return {
      opened,
      open() {
        open();
      },
    };
  }

  interface RunningJob {
    readonly started: Latch;
    readonly draining: Latch;
    readonly mayFinish: Latch;
    outcome?: Promise<string>;
  }

  const state = {
    bootError: new Error("boot step refused"),
    failBootAt: undefined as "probe" | "ping" | "listen" | undefined,
    failRelease: new Set<string>(),
    released: [] as string[],
    workedWithDrainTimeoutMs: [] as number[],
    job: undefined as RunningJob | undefined,
  };

  function use(resource: string): void {
    if (state.released.includes(resource)) {
      throw new Error(`${resource} used after it was closed`);
    }
  }

  function release(resource: string): void {
    state.released.push(resource);
    if (state.failRelease.has(resource)) {
      throw new Error(`${resource} close failed`);
    }
  }

  function refuseBootAt(step: "probe" | "ping" | "listen"): Promise<void> {
    return state.failBootAt === step
      ? Promise.reject(state.bootError)
      : Promise.resolve();
  }

  const redis = {
    ping(): Promise<void> {
      use("redis");
      return refuseBootAt("ping");
    },
    quit(): Promise<void> {
      release("redis");
      return Promise.resolve();
    },
  };

  const pool = {
    query(): Promise<void> {
      use("db");
      return Promise.resolve();
    },
    end(): Promise<void> {
      release("db");
      return Promise.resolve();
    },
  };

  const storage = {
    probe(): Promise<void> {
      use("storage");
      return refuseBootAt("probe");
    },
    close(): void {
      release("storage");
    },
  };

  async function runJob(job: RunningJob): Promise<string> {
    job.started.open();
    await job.mayFinish.opened;
    try {
      await redis.ping();
      await pool.query();
      await storage.probe();
      return "completed";
    } catch (error) {
      return error instanceof Error ? error.message : "failed";
    }
  }

  const jobRunner = {
    port: {},
    work(options: { readonly drainTimeoutMs: number }): Promise<void> {
      state.workedWithDrainTimeoutMs.push(options.drainTimeoutMs);
      if (state.job !== undefined) {
        state.job.outcome = runJob(state.job);
      }
      return Promise.resolve();
    },
    async close(): Promise<void> {
      if (state.job?.outcome !== undefined) {
        state.job.draining.open();
        await state.job.outcome;
      }
      release("jobs");
    },
  };

  const listener = {
    async start(): Promise<void> {
      if (state.job !== undefined) {
        await state.job.started.opened;
      }
      await refuseBootAt("listen");
    },
    stop(): Promise<void> {
      release("listen");
      return Promise.resolve();
    },
  };

  class FakeRedis {
    ping(): Promise<void> {
      return redis.ping();
    }

    quit(): Promise<void> {
      return redis.quit();
    }
  }

  function reset(): void {
    state.bootError = new Error("boot step refused");
    state.failBootAt = undefined;
    state.failRelease = new Set();
    state.released = [];
    state.workedWithDrainTimeoutMs = [];
    state.job = undefined;
  }

  return {
    state,
    storage,
    pool,
    jobRunner,
    listener,
    FakeRedis,
    latch,
    reset,
  };
});

vi.mock("@showzy/files/storage", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  configureFilesObjectStore: () => undefined,
  probeFilesObjectStore: () => world.storage.probe(),
  closeFilesObjectStore: () => {
    world.storage.close();
  },
}));

vi.mock("@showzy/db", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createDbClient: () => ({ db: {}, pool: world.pool }),
}));

vi.mock("@showzy/jobs", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  openJobRunner: () => Promise.resolve(world.jobRunner),
}));

vi.mock("ioredis", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  Redis: world.FakeRedis,
}));

vi.mock("./listen.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createOutboxListener: () => world.listener,
}));

const silent = pino({ enabled: false });

const DEPENDENCY_ORDER = ["jobs", "listen", "storage", "redis", "db"];

function workerConfig() {
  return loadServerConfig({
    NODE_ENV: "test",
    DATABASE_URL: "postgres://worker:worker@127.0.0.1:5432/worker",
    REDIS_URL: "redis://127.0.0.1:6379",
    S3_ENDPOINT: "http://127.0.0.1:3900",
    S3_ACCESS_KEY_ID: "showzy-local",
    S3_SECRET_ACCESS_KEY: "showzy-local-secret",
    S3_FORCE_PATH_STYLE: "true",
    S3_BUCKET: "showzy",
    BETTER_AUTH_SECRET: "dev-only-secret-change-me-0000000000",
    BETTER_AUTH_URL: "http://localhost:3000",
    IP_HMAC_SECRET: "dev-only-ip-hmac-secret-change-me-00",
  });
}

function boot(logger: Logger = silent) {
  return bootWorker(workerConfig(), {
    logger,
    pollIntervalMs: 60_000,
  });
}

function capturingLogger(lines: string[]): Logger {
  return pino(
    {},
    {
      write(chunk: string) {
        lines.push(chunk);
      },
    },
  );
}

function releaseFailuresLogged(lines: readonly string[]): readonly string[] {
  return lines.flatMap((line) => {
    const logged =
      /"err":\{[^\n]*"message":"([^"]+)"[^\n]*"msg":"worker release failed"/.exec(
        line,
      );
    return logged?.[1] === undefined ? [] : [logged[1]];
  });
}

function arrangeRunningJob() {
  const job = {
    started: world.latch(),
    draining: world.latch(),
    mayFinish: world.latch(),
  };
  world.state.job = job;
  return job;
}

beforeEach(() => {
  world.reset();
});

describe("bootWorker teardown after a failed boot", () => {
  it("drains a running job before closing the dependencies it uses when the listener fails to start", async () => {
    world.state.failBootAt = "listen";
    const job = arrangeRunningJob();

    const booting = boot();
    const settled = booting.then(
      () => undefined,
      (error: unknown) => error,
    );
    await job.draining.opened;

    expect(world.state.released).toEqual([]);

    job.mayFinish.open();

    expect(await settled).toBe(world.state.bootError);
    expect(await world.state.job?.outcome).toBe("completed");
    expect(world.state.released).toEqual(DEPENDENCY_ORDER);
  });

  it("releases only what an early failure acquired, each once", async () => {
    world.state.failBootAt = "ping";

    await expect(boot()).rejects.toBe(world.state.bootError);

    expect(world.state.workedWithDrainTimeoutMs).toEqual([]);
    expect(world.state.released).toEqual(["jobs", "storage", "redis", "db"]);
  });

  it("closes only the object store when its probe fails", async () => {
    world.state.failBootAt = "probe";

    await expect(boot()).rejects.toBe(world.state.bootError);

    expect(world.state.released).toEqual(["storage"]);
  });

  it("keeps the boot error, still attempts every release and logs each cleanup failure", async () => {
    world.state.failBootAt = "listen";
    world.state.failRelease = new Set(["jobs", "redis"]);
    const lines: string[] = [];

    await expect(boot(capturingLogger(lines))).rejects.toBe(
      world.state.bootError,
    );

    expect(world.state.released).toEqual(DEPENDENCY_ORDER);
    expect(releaseFailuresLogged(lines)).toEqual([
      "jobs close failed",
      "redis close failed",
    ]);
    expect(lines.join("\n")).not.toContain("showzy-local-secret");
  });

  it("logs a cleanup failure when the first boot step fails", async () => {
    world.state.failBootAt = "probe";
    world.state.failRelease = new Set(["storage"]);
    const lines: string[] = [];

    await expect(boot(capturingLogger(lines))).rejects.toBe(
      world.state.bootError,
    );

    expect(releaseFailuresLogged(lines)).toEqual(["storage close failed"]);
  });
});

describe("BootedWorker.close", () => {
  it("drains the job runner within the bounded drain before closing the dependencies", async () => {
    const job = arrangeRunningJob();
    const booted = await boot();
    await job.started.opened;

    expect(world.state.workedWithDrainTimeoutMs).toEqual([
      JOB_DRAIN_TIMEOUT_MS,
    ]);

    const closing = booted.close();
    await job.draining.opened;
    expect(world.state.released).toEqual([]);

    job.mayFinish.open();
    await closing;

    expect(await world.state.job?.outcome).toBe("completed");
    expect(world.state.released).toEqual(DEPENDENCY_ORDER);
  });

  it("attempts every release and rethrows a single failure as itself", async () => {
    const lines: string[] = [];
    const booted = await boot(capturingLogger(lines));
    world.state.failRelease = new Set(["jobs"]);

    const failure = await booted.close().then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).not.toBeInstanceOf(AggregateError);
    expect(failure).toEqual(new Error("jobs close failed"));
    expect(world.state.released).toEqual(DEPENDENCY_ORDER);
    expect(releaseFailuresLogged(lines)).toEqual(["jobs close failed"]);
  });

  it("reports every failure as one AggregateError when several releases fail", async () => {
    const lines: string[] = [];
    const booted = await boot(capturingLogger(lines));
    world.state.failRelease = new Set(["jobs", "storage", "db"]);

    const failure = await booted.close().then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure instanceof AggregateError ? failure.errors : []).toEqual([
      new Error("jobs close failed"),
      new Error("storage close failed"),
      new Error("db close failed"),
    ]);
    expect(world.state.released).toEqual(DEPENDENCY_ORDER);
    expect(releaseFailuresLogged(lines)).toEqual([
      "jobs close failed",
      "storage close failed",
      "db close failed",
    ]);
  });
});
