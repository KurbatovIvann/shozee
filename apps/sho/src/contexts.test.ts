import { compileContext } from "@showzy/sho";
import { describe, expect, it } from "vitest";

import {
  createShoContextCache,
  shoContextPhrases,
  type ShoContextEntry,
} from "./contexts.ts";

const compiled = compileContext({ version: 2 });

const entry = (fingerprint: string, uploadBytes: number): ShoContextEntry => ({
  fingerprint,
  revision: null,
  compiled,
  phrases: [],
  uploadBytes,
});

describe("compiled-context cache", () => {
  it("returns an entry only for its own fingerprint", () => {
    const cache = createShoContextCache();
    cache.put("a:1", entry("fp-1", 10));
    expect(cache.fresh("a:1", "fp-1")?.fingerprint).toBe("fp-1");
    expect(cache.fresh("a:1", "fp-2")).toBeNull();
    expect(cache.fresh("b:1", "fp-1")).toBeNull();
    expect(cache.read("a:1")?.fingerprint).toBe("fp-1");
  });

  it("replaces an entry under the same key without double counting bytes", () => {
    const cache = createShoContextCache();
    cache.put("a:1", entry("fp-1", 100));
    cache.put("a:1", entry("fp-2", 40));
    expect(cache.uploadBytes).toBe(40);
    expect(cache.keys).toEqual(["a:1"]);
    expect(cache.fresh("a:1", "fp-1")).toBeNull();
  });

  it("evicts the least recently used key once over the upload-byte budget", () => {
    const cache = createShoContextCache(100);
    cache.put("a:1", entry("fp", 40));
    cache.put("b:1", entry("fp", 40));
    expect(cache.fresh("a:1", "fp")).not.toBeNull();
    cache.put("c:1", entry("fp", 40));
    expect(cache.keys).toEqual(["a:1", "c:1"]);
    expect(cache.uploadBytes).toBe(80);
  });

  it("bumps recency on a plain read, not only on a fingerprint hit", () => {
    const cache = createShoContextCache(100);
    cache.put("a:1", entry("fp", 40));
    cache.put("b:1", entry("fp", 40));
    expect(cache.read("a:1")).not.toBeNull();
    cache.put("c:1", entry("fp", 40));
    expect(cache.keys).toEqual(["a:1", "c:1"]);
  });

  it("keeps a stale key hot, because its re-upload follows the 409", () => {
    const cache = createShoContextCache(100);
    cache.put("a:1", entry("fp-1", 40));
    cache.put("b:1", entry("fp-1", 40));
    expect(cache.fresh("a:1", "fp-2")).toBeNull();
    cache.put("c:1", entry("fp-1", 40));
    expect(cache.keys).toEqual(["a:1", "c:1"]);
  });

  it("keeps one entry even when it alone is over the budget", () => {
    const cache = createShoContextCache(10);
    cache.put("a:1", entry("fp", 4000));
    expect(cache.keys).toEqual(["a:1"]);
  });
});

describe("speech-hint phrases", () => {
  it("names products, variants and customers once each", () => {
    expect(
      shoContextPhrases({
        version: 2,
        products: [
          {
            id: "p",
            name: "Кава",
            variants: [
              { id: "v1", name: "Кава 250 г" },
              { id: "v2", name: "Кава" },
            ],
          },
        ],
        customers: [{ id: "c", name: "Олена" }],
        groups: [{ id: "g", name: "Опт" }],
      }),
    ).toEqual(["Кава", "Кава 250 г", "Олена"]);
  });
});
