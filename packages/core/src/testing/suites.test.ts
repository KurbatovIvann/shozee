import { describe, expect, it } from "vitest";
import { z } from "zod";

import { schemaCarriesUuidField } from "./suites.js";

function endlessLazy(): z.ZodType {
  return z.lazy(() => z.object({ name: z.string(), child: endlessLazy() }));
}

function nestedChain(leaf: z.ZodType, levels: number): z.ZodType {
  let node: z.ZodType = leaf;
  for (let level = 0; level < levels; level += 1) {
    node = z.object({ child: node });
  }
  return node;
}

describe("schemaCarriesUuidField", () => {
  it("finds a uuid under optional, union, array, pipe and record", () => {
    const schema = z.object({
      note: z.string(),
      filter: z
        .object({
          targets: z.array(
            z.union([
              z.object({ label: z.string() }),
              z.object({
                rows: z.record(z.string(), z.string().pipe(z.uuid())),
              }),
            ]),
          ),
        })
        .optional(),
    });
    expect(schemaCarriesUuidField(schema)).toBe(true);
  });

  it("reports no uuid for the same nesting over plain strings", () => {
    const schema = z.object({
      note: z.string(),
      filter: z
        .object({
          targets: z.array(
            z.union([
              z.object({ label: z.string() }),
              z.object({ rows: z.record(z.string(), z.string().min(1)) }),
            ]),
          ),
        })
        .optional(),
    });
    expect(schemaCarriesUuidField(schema)).toBe(false);
  });

  it("matches the guid format and a uuid carried as a string check", () => {
    expect(schemaCarriesUuidField(z.object({ id: z.guid() }))).toBe(true);
    expect(
      schemaCarriesUuidField(z.object({ id: z.string().check(z.uuid()) })),
    ).toBe(true);
    expect(
      schemaCarriesUuidField(
        z.object({ ids: z.array(z.string().check(z.guid())) }),
      ),
    ).toBe(true);
  });

  it("walks a self-referencing lazy schema to its uuid", () => {
    const node: z.ZodType = z.lazy(() =>
      z.object({ id: z.uuid(), child: node.optional() }),
    );
    expect(schemaCarriesUuidField(node)).toBe(true);
  });

  it("throws on a lazy getter that returns a fresh schema each call", () => {
    expect(() => schemaCarriesUuidField(endlessLazy())).toThrow(
      /exhausted its budget/,
    );
  });

  it("throws instead of reporting no uuid when the schema outgrows the budget", () => {
    expect(() => schemaCarriesUuidField(nestedChain(z.string(), 600))).toThrow(
      /exhausted its budget/,
    );
  });

  it("throws instead of reporting no uuid for an unrecognised wrapper type", () => {
    expect(() =>
      schemaCarriesUuidField(z.object({ wrapped: z.custom<string>() })),
    ).toThrow(/unrecognised type "custom"/);
    expect(() =>
      schemaCarriesUuidField(z.object({ mapped: z.transform(String) })),
    ).toThrow(/unrecognised type "transform"/);
  });

  it("walks success and template literal wrappers to their uuid", () => {
    expect(schemaCarriesUuidField(z.object({ ok: z.success(z.uuid()) }))).toBe(
      true,
    );
    expect(
      schemaCarriesUuidField(
        z.object({ tag: z.templateLiteral(["row-", z.uuid()]) }),
      ),
    ).toBe(true);
    expect(
      schemaCarriesUuidField(
        z.object({ tag: z.templateLiteral(["row-", z.string()]) }),
      ),
    ).toBe(false);
  });

  it("detects a uuid in a shared node whichever branch reaches it first", () => {
    const shared = nestedChain(z.object({ id: z.uuid() }), 12);
    const deep = nestedChain(shared, 58);
    expect(schemaCarriesUuidField(z.object({ deep, shared }))).toBe(true);
    expect(schemaCarriesUuidField(z.object({ shared, deep }))).toBe(true);
  });
});
