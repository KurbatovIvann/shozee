import { gzipSync } from "node:zlib";
import { manifest } from "@showzy/sho";
import {
  shoContextKey,
  shoModelResponseSchema,
  shoParseResponseSchema,
  shoPhrasesResponseSchema,
  type ShoContext,
} from "@showzy/sho-protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createShoApp } from "./app.ts";
import {
  SHO_LABELS_FILE,
  type ShoEngine,
  type ShoFailureDetail,
} from "./engine.ts";
import { createShoPool } from "./pool.ts";

const TOKEN = "service-token-of-at-least-32-characters";
const KEY = shoContextKey("company1", "scope1");
const authorized = { authorization: `Bearer ${TOKEN}` };

const CONTEXT: ShoContext = {
  version: 2,
  revision: "rev-1",
  products: [
    {
      id: "coffee",
      name: "Кава",
      unit: "kg",
      variants: [
        { id: "coffee-250", name: "Кава 250 г", values: ["250 г"] },
        { id: "coffee-1kg", name: "Кава 1 кг", values: ["1 кг"] },
      ],
    },
    { id: "croissant", name: "Круасан", aliases: ["круасанчик"] },
  ],
  customers: [{ id: "olena", name: "Олена Коваль" }],
};

describe("apps/sho over the real Шо runtime in a worker pool", () => {
  let engine: ShoEngine;
  let app: ReturnType<typeof createShoApp>;
  const failures: [string, ShoFailureDetail | null][] = [];

  beforeAll(async () => {
    engine = await createShoPool({
      size: 2,
      onFailure: (code, detail) => failures.push([code, detail]),
    });
    app = createShoApp({ serviceToken: TOKEN, engine: () => engine });
  });

  afterAll(async () => {
    await engine.dispose();
  });

  it("reports the loaded model, its labelsMd5 and its actions", async () => {
    const response = await app.fetch(
      new Request("http://sho.test/v1/model", { headers: authorized }),
    );
    const body = shoModelResponseSchema.parse(await response.json());
    expect(body.model.id).toBe(manifest.model);
    expect(body.model.labelsMd5).toBe(manifest.files[SHO_LABELS_FILE]?.md5);
    expect(body.model.labelsMd5).toMatch(/^[0-9a-f]{32}$/);
    expect(body.model.catalogue).toBe(manifest.catalogue);
    expect(body.actions.length).toBeGreaterThan(0);
    expect(body.workers).toBe(2);
  });

  it("parses a stored context and answers the protocol shape", async () => {
    const stored = await app.fetch(
      new Request(`http://sho.test/v1/contexts/${encodeURIComponent(KEY)}`, {
        method: "PUT",
        headers: { ...authorized, "content-encoding": "gzip" },
        body: new Uint8Array(
          gzipSync(
            Buffer.from(
              JSON.stringify({ fingerprint: "fp-1", context: CONTEXT }),
              "utf8",
            ),
          ),
        ),
      }),
    );
    expect(stored.status).toBe(204);

    const response = await app.fetch(
      new Request("http://sho.test/v1/parse", {
        method: "POST",
        headers: { ...authorized, "content-type": "application/json" },
        body: JSON.stringify({
          requestId: "req-1",
          companyId: "company1",
          contextKey: KEY,
          fingerprint: "fp-1",
          text: "Створи замовлення для Олени: 2 кави і круасан",
          now: { year: 2026, month: 10, day: 2, hour: 11, minute: 0 },
          deadlineMs: 30_000,
          debug: false,
        }),
      }),
    );
    expect(response.status).toBe(200);
    const body = shoParseResponseSchema.parse(await response.json());
    expect(body.model.md5).toBe(engine.stamp.md5);
    expect(body.contextRevision).toBe("rev-1");
    expect(body.result.schema).toBe("sho-result/2");
    expect(body.result.commands.length).toBeGreaterThan(0);
    expect(body.ms).toBeGreaterThan(0);

    const phrases = await app.fetch(
      new Request(
        `http://sho.test/v1/contexts/${encodeURIComponent(KEY)}/phrases?companyId=company1`,
        { headers: authorized },
      ),
    );
    const hints = shoPhrasesResponseSchema.parse(await phrases.json());
    expect(hints.phrases).toContain("Олена Коваль");
    expect(hints.phrases).toContain("Кава 250 г");
  });

  it("refuses a text the runtime cannot read without logging any detail", async () => {
    await engine.store({
      key: KEY,
      fingerprint: "fp-2",
      revision: "rev-1",
      context: CONTEXT,
      phrases: [],
      uploadBytes: 64,
    });
    const refused = await engine.run({
      key: KEY,
      fingerprint: "fp-2",
      text: "!!! ??? ...",
      now: { year: 2026, month: 10, day: 2, hour: 11, minute: 0 },
      previous: null,
      focus: null,
      debug: false,
      deadlineMs: 30_000,
    });
    expect(refused).toEqual({ kind: "input" });
    expect(failures).toEqual([]);
  });
});
