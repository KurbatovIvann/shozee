/**
 * The queue's persistence policy (db.md §6, ADR-0039), proven against the
 * compose file itself.
 *
 * An accepted assistant turn is a BullMQ job, so the Redis that holds BullMQ is
 * not rebuildable. The development form of that policy is the `redis` service
 * in `docker-compose.yml`. This reads the service's image and command from the
 * file and runs exactly them, so a compose edit that drops AOF — or a command
 * Redis does not accept — turns this red instead of silently shipping a queue
 * that forgets on restart.
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

function composeText(): string {
  return readFileSync(new URL("../../../docker-compose.yml", import.meta.url), {
    encoding: "utf8",
  }).replaceAll("\r\n", "\n");
}

/** The `redis:` service block, up to the next top-level service or section. */
function redisService(compose: string): string {
  const match = /^ {2}redis:\n((?: {4}.*\n|\s*\n)*)/m.exec(compose);
  if (match?.[1] === undefined) {
    throw new Error("docker-compose.yml has no redis service");
  }
  return match[1];
}

function redisImage(service: string): string {
  const match = /^ {4}image:\s*(\S+)\s*$/m.exec(service);
  if (match?.[1] === undefined) {
    throw new Error("the redis service has no image");
  }
  return match[1];
}

function redisCommand(service: string): string[] {
  const match = /^ {4}command:\s*(\[.*\])\s*$/m.exec(service);
  if (match?.[1] === undefined) {
    throw new Error("the redis service has no command");
  }
  const parsed: unknown = JSON.parse(match[1]);
  if (
    !Array.isArray(parsed) ||
    !parsed.every((part): part is string => typeof part === "string")
  ) {
    throw new Error("the redis command is not a list of strings");
  }
  return parsed;
}

async function configGet(redis: Redis, name: string): Promise<unknown> {
  const reply = await redis.call("CONFIG", "GET", name);
  return Array.isArray(reply) ? reply[1] : undefined;
}

const compose = composeText();
const service = redisService(compose);

describe("compose redis persistence (static)", () => {
  it("keeps its data on a named volume at /data", () => {
    expect(service).toMatch(/^ {6}- redis-data:\/data\s*$/m);
    expect(compose).toMatch(/^volumes:\n(?: {2}\S+:\n)*? {2}redis-data:\s*$/m);
  });

  it("asks for AOF with an fsync every second", () => {
    const command = redisCommand(service);
    expect(command[0]).toBe("redis-server");
    expect(command.join(" ")).toContain("--appendonly yes");
    expect(command.join(" ")).toContain("--appendfsync everysec");
  });
});

describe("compose redis persistence (running)", () => {
  let container: StartedTestContainer;
  let redis: Redis;

  beforeAll(async () => {
    container = await new GenericContainer(redisImage(service))
      .withCommand(redisCommand(service))
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

  it("writes its append-only file under /data, where the volume is mounted", async () => {
    await expect(configGet(redis, "dir")).resolves.toBe("/data");
  });
});
