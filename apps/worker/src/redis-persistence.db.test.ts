import { readFileSync } from "node:fs";

import { Redis } from "ioredis";
import {
  GenericContainer,
  Wait,
  type StartedTestContainer,
} from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REDIS_PORT = 6379;
const SHARED_SERVICE = "redis";

function composeText(): string {
  return readFileSync(new URL("../../../docker-compose.yml", import.meta.url), {
    encoding: "utf8",
  }).replaceAll("\r\n", "\n");
}

function composeServiceNames(compose: string): string[] {
  const services = /^services:\n((?: {2}\S.*\n| {3,}.*\n|\s*\n)*)/m.exec(
    compose,
  );
  if (services?.[1] === undefined) {
    throw new Error("docker-compose.yml has no services section");
  }
  return [...services[1].matchAll(/^ {2}(\S+):\s*$/gm)].map((match) => {
    const name = match[1];
    if (name === undefined) {
      throw new Error("a service block has no name");
    }
    return name;
  });
}

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

function serviceCommand(service: string, name: string): string[] {
  const command = blockList(service, "command");
  if (command === undefined) {
    throw new Error(`the ${name} service has no command`);
  }
  return command;
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

function runningService(service: string, command: string[]) {
  const running: { container?: StartedTestContainer; redis?: Redis } = {};

  beforeAll(async () => {
    const container = await new GenericContainer(serviceImage(service))
      .withCommand(command)
      .withExposedPorts(REDIS_PORT)
      .withWaitStrategy(Wait.forLogMessage("Ready to accept connections"))
      .start();
    running.container = container;
    const redis = new Redis({
      host: container.getHost(),
      port: container.getMappedPort(REDIS_PORT),
      lazyConnect: true,
    });
    running.redis = redis;
    await redis.connect();
  });

  afterAll(async () => {
    await running.redis?.quit();
    await running.container?.stop();
  });

  return (name: string): Promise<unknown> => {
    if (running.redis === undefined) {
      throw new Error("the redis container did not start");
    }
    return configGet(running.redis, name);
  };
}

const compose = composeText();
const shared = composeService(compose, SHARED_SERVICE);
const sharedCommand = serviceCommand(shared, SHARED_SERVICE);

describe("compose redis services", () => {
  it("declares exactly one redis service", () => {
    expect(
      composeServiceNames(compose).filter((name) => name.includes("redis")),
    ).toEqual([SHARED_SERVICE]);
  });

  it("declares no queue redis volume", () => {
    expect(compose).not.toContain("redis-queue");
  });
});

describe("compose shared redis (static)", () => {
  it("has no volume to persist into", () => {
    expect(blockList(shared, "volumes")).toBeUndefined();
  });

  it("asks for no snapshots and no append-only file", () => {
    expect(sharedCommand[0]).toBe("redis-server");
    expect(flagValue(sharedCommand, "--save")).toBe("");
    expect(flagValue(sharedCommand, "--appendonly")).toBe("no");
  });

  it("is published on loopback only", () => {
    expect(blockList(shared, "ports")).toEqual(["127.0.0.1:6379:6379"]);
  });
});

describe("compose shared redis (running)", () => {
  const config = runningService(shared, sharedCommand);

  it("takes no RDB snapshots (CONFIG GET save is empty)", async () => {
    await expect(config("save")).resolves.toBe("");
  });

  it("writes no append-only file (CONFIG GET appendonly)", async () => {
    await expect(config("appendonly")).resolves.toBe("no");
  });
});
