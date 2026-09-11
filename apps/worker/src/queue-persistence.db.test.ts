/**
 * The Redis persistence policy (db.md §6, ADR-0039), proven against the compose
 * file itself.
 *
 * Two Redis instances, on purpose. The queue Redis holds accepted assistant
 * turns, so it persists with AOF and never evicts. The shared Redis holds
 * better-auth secondary storage — plaintext OTP codes among it — plus rate
 * limits, confirmation challenges and pauses, and must not persist.
 *
 * This reads both services from `docker-compose.yml` and runs the queue
 * service's exact image and command, so a compose edit that drops AOF or
 * `noeviction`, a command Redis refuses, or persistence creeping onto the
 * shared Redis turns this red.
 */
import { readFileSync } from "node:fs";

import { Redis } from "ioredis";
import {
  GenericContainer,
  Wait,
  type StartedTestContainer,
} from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REDIS_PORT = 6379;
const QUEUE_SERVICE = "redis-queue";
const SHARED_SERVICE = "redis";

function composeText(): string {
  return readFileSync(new URL("../../../docker-compose.yml", import.meta.url), {
    encoding: "utf8",
  }).replaceAll("\r\n", "\n");
}

/**
 * A top-level service block, up to the next service or section, with its
 * comment lines removed so prose cannot satisfy or break an assertion.
 */
function composeService(compose: string, name: string): string {
  const match = new RegExp(
    `^ {2}${name}:\\n((?: {4}.*\\n|\\s*\\n)*)`,
    "m",
  ).exec(compose);
  if (match?.[1] === undefined) {
    throw new Error(`docker-compose.yml has no ${name} service`);
  }
  return match[1].replace(/^ *#.*\n/gm, "");
}

function serviceImage(service: string): string {
  const match = /^ {4}image:\s*(\S+)\s*$/m.exec(service);
  if (match?.[1] === undefined) {
    throw new Error("the service has no image");
  }
  return match[1];
}

/** A block sequence under `key:` (`command`, `ports`, `volumes`), unquoted. */
function blockList(service: string, key: string): string[] | undefined {
  const match = new RegExp(`^ {4}${key}:\\n((?: {6}- .*\\n)+)`, "m").exec(
    service,
  );
  if (match?.[1] === undefined) {
    return undefined;
  }
  return match[1]
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) =>
      line
        .replace(/^ {6}- /, "")
        .trim()
        .replace(/^"(.*)"$/, "$1"),
    );
}

function flagValue(
  command: readonly string[],
  flag: string,
): string | undefined {
  const index = command.indexOf(flag);
  return index === -1 ? undefined : command[index + 1];
}

async function configGet(redis: Redis, name: string): Promise<unknown> {
  const reply = await redis.call("CONFIG", "GET", name);
  return Array.isArray(reply) ? reply[1] : undefined;
}

const compose = composeText();
const queue = composeService(compose, QUEUE_SERVICE);
const shared = composeService(compose, SHARED_SERVICE);

const queueCommand = blockList(queue, "command");
if (queueCommand === undefined) {
  throw new Error(`the ${QUEUE_SERVICE} service has no command`);
}

describe("compose queue redis (static)", () => {
  it("keeps its data on its own named volume at /data", () => {
    expect(blockList(queue, "volumes")).toEqual(["redis-queue-data:/data"]);
    expect(compose).toMatch(
      /^volumes:\n(?: {2}\S+:\n)*? {2}redis-queue-data:\s*$/m,
    );
  });

  it("asks for AOF with an fsync every second, and never evicts", () => {
    expect(queueCommand[0]).toBe("redis-server");
    expect(flagValue(queueCommand, "--appendonly")).toBe("yes");
    expect(flagValue(queueCommand, "--appendfsync")).toBe("everysec");
    expect(flagValue(queueCommand, "--maxmemory-policy")).toBe("noeviction");
  });

  it("is published on loopback only", () => {
    expect(blockList(queue, "ports")).toEqual(["127.0.0.1:6380:6379"]);
  });
});

describe("compose shared redis (static)", () => {
  it("does not persist: no volume and no persistence command", () => {
    expect(blockList(shared, "volumes")).toBeUndefined();
    expect(blockList(shared, "command")).toBeUndefined();
    expect(shared).not.toMatch(/appendonly|appendfsync/);
  });

  it("is published on loopback only", () => {
    expect(blockList(shared, "ports")).toEqual(["127.0.0.1:6379:6379"]);
  });
});

describe("compose queue redis (running)", () => {
  let container: StartedTestContainer;
  let redis: Redis;

  beforeAll(async () => {
    container = await new GenericContainer(serviceImage(queue))
      .withCommand(queueCommand)
      .withExposedPorts(REDIS_PORT)
      .withWaitStrategy(Wait.forLogMessage("Ready to accept connections"))
      .start();
    redis = new Redis({
      host: container.getHost(),
      port: container.getMappedPort(REDIS_PORT),
      lazyConnect: true,
    });
    await redis.connect();
  });

  afterAll(async () => {
    await redis.quit();
    await container.stop();
  });

  it("runs with appendonly yes (CONFIG GET appendonly)", async () => {
    await expect(configGet(redis, "appendonly")).resolves.toBe("yes");
  });

  it("runs with appendfsync everysec", async () => {
    await expect(configGet(redis, "appendfsync")).resolves.toBe("everysec");
  });

  it("never evicts (CONFIG GET maxmemory-policy)", async () => {
    await expect(configGet(redis, "maxmemory-policy")).resolves.toBe(
      "noeviction",
    );
  });

  it("writes its append-only file under /data, where the volume is mounted", async () => {
    await expect(configGet(redis, "dir")).resolves.toBe("/data");
  });
});
