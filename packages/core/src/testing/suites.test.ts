import { describe, expect, it } from "vitest";
import { z } from "zod";

import { schemaCarriesUuidField } from "./suites.js";

function endlessLazy(): z.ZodType {
  return z.lazy(() => z.object({ name: z.string(), child: endlessLazy() }));
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

  it("terminates on a lazy getter that returns a fresh schema each call", () => {
    expect(schemaCarriesUuidField(endlessLazy())).toBe(false);
  });
});
