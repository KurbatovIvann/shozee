import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { loadServerConfig } from "@showzy/config";
import { createTestKit, type TestKit } from "@showzy/core/testing";
import { CoreInvariantError } from "@showzy/core/errors";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bootApi } from "./boot.js";
import { registeredJobs } from "./registry.js";

let kit: TestKit;
let bucketHead: Server;

beforeAll(async () => {
  kit = await createTestKit();
  bucketHead = createServer((_request, response) => {
    response.writeHead(200);
    response.end();
  });
  await new Promise<void>((resolve) => {
    bucketHead.listen(0, "127.0.0.1", resolve);
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    bucketHead.close(() => {
      resolve();
    });
  });
  await kit.db.close();
});

function apiConfig() {
  const databaseUrl = kit.db.runtime.pool.options.connectionString ?? "";
  const { port } = bucketHead.address() as AddressInfo;
  return loadServerConfig({
    NODE_ENV: "test",
    DATABASE_URL: databaseUrl,
    REDIS_URL: "redis://127.0.0.1:1",
    REDIS_QUEUE_URL: "redis://127.0.0.1:1",
    S3_ENDPOINT: `http://127.0.0.1:${String(port)}`,
    S3_ACCESS_KEY_ID: "showzy-local",
    S3_SECRET_ACCESS_KEY: "showzy-local-secret",
    S3_FORCE_PATH_STYLE: "true",
    S3_BUCKET: "showzy",
    BETTER_AUTH_SECRET: "dev-only-secret-change-me-0000000000",
    BETTER_AUTH_URL: "http://localhost:3000",
    IP_HMAC_SECRET: "dev-only-ip-hmac-secret-change-me-00",
  });
}

describe("bootApi against the job runner (SHO-682)", () => {
  it("fails fast when the worker has not provisioned the declared job queues, and creates none", async () => {
    expect(registeredJobs.length).toBeGreaterThan(0);

    await expect(bootApi(apiConfig())).rejects.toBeInstanceOf(
      CoreInvariantError,
    );

    const queues = await kit.db.admin.query<{ name: string }>(
      "SELECT name FROM pgboss.queue WHERE name = ANY($1)",
      [registeredJobs.map(({ name }) => name)],
    );
    expect(queues.rows).toEqual([]);
  });
});
