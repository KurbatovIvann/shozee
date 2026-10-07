import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { expect, inject, it } from "vitest";

const sessionIdLabel = "org.testcontainers.session-id";

it("never shares a reaper session with another process", async () => {
  expect(process.env["TESTCONTAINERS_RYUK_TEST_LABEL"]).toBe("true");

  const harness = inject("dbHarness");
  const container = await new PostgreSqlContainer("postgres:17-alpine").start();

  try {
    expect(harness.reaperSessionId).toMatch(/^[0-9a-f]+$/);
    expect(container.getLabels()[sessionIdLabel]).toMatch(/^[0-9a-f]+$/);
    expect(container.getLabels()[sessionIdLabel]).not.toBe(
      harness.reaperSessionId,
    );
  } finally {
    await container.stop();
  }
}, 180_000);
