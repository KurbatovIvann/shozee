import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  conformanceDir,
  manifest,
  modelDir,
  requirementsOf,
  type Bundle,
  type CompiledContext,
  type Requirements,
} from "../src/index.ts";
import {
  CONTACT_LABELS,
  decodeFocusVector,
  decodeVector,
  pinned,
  readContactVectors,
  readFocusVectors,
  readVectors,
  vectorBundle,
  vectorContext,
  vectorRequirements,
  type FocusVector,
  type Vector,
  type VectorInput,
} from "./vectors.ts";

const vectors: Vector[] = await readVectors(conformanceDir);
const focusVectors: FocusVector[] = await readFocusVectors(conformanceDir);

describe("Шо v3 conformance vectors", () => {
  let bundle: Bundle;

  beforeAll(async () => {
    bundle = await vectorBundle(
      conformanceDir,
      join(modelDir, "tokenizer.json"),
    );
  });

  it("are all there and name only v3 actions", () => {
    expect(vectors.length).toBe(521);
    expect(new Set(vectors.map((vector) => vector.id)).size).toBe(
      vectors.length,
    );
    const actions = new Set<string>(bundle.actions);
    for (const vector of vectors) {
      const inputs: readonly VectorInput[] = Array.isArray(vector.input)
        ? vector.input
        : [vector.input];
      for (const input of inputs)
        expect(actions.has(input.action), vector.id).toBe(true);
    }
  });

  it("include every hand-written D70 case", async () => {
    const cases = (
      await readFile(join(conformanceDir, "cases-d70.jsonl"), "utf8")
    )
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line): unknown => JSON.parse(line));
    const ids = new Set(vectors.map((vector) => vector.id));
    for (const row of cases) {
      const id: unknown =
        typeof row === "object" && row !== null ? Reflect.get(row, "id") : null;
      expect(typeof id === "string" && ids.has(id), String(id)).toBe(true);
    }
  });

  it("are written for a catalogue the vendored model grew from", async () => {
    expect(manifest.conformance["labels.json"]?.md5).toBeDefined();
    const labels: unknown = JSON.parse(
      await readFile(join(modelDir, "labels.json"), "utf8"),
    );
    const actions: unknown = Reflect.get(Object(labels), "actions");
    expect(Array.isArray(actions)).toBe(true);
    expect(actions).toEqual(expect.arrayContaining([...bundle.actions]));
  });

  it("decode to exactly the expected commands", async () => {
    const requirements: Requirements = await vectorRequirements(conformanceDir);
    const failures: string[] = [];
    const contexts = new Map<string | null, CompiledContext | null>();
    for (const vector of vectors) {
      let context = contexts.get(vector.context);
      if (context === undefined) {
        context = await vectorContext(conformanceDir, vector.context);
        contexts.set(vector.context, context);
      }
      const commands = decodeVector(
        bundle,
        vector,
        context,
        undefined,
        vector.requirements === undefined ? {} : requirements,
      ).map(pinned);
      const got = Array.isArray(vector.input) ? commands : commands[0];
      try {
        expect(got).toEqual(vector.expect);
      } catch {
        failures.push(vector.id);
      }
    }
    console.log(
      `Шо v3 conformance: ${String(vectors.length - failures.length)} of ${String(vectors.length)} vectors`,
    );
    expect(failures).toEqual([]);
  });

  it("require of each action exactly what the served catalogue requires", async () => {
    const [catalogue, shipped] = await Promise.all([
      vectorRequirements(conformanceDir),
      requirementsOf(),
    ]);
    const actions = [
      ...new Set([...Object.keys(catalogue), ...Object.keys(shipped)]),
    ].sort();
    const divergent = actions.filter(
      (action) =>
        JSON.stringify(catalogue[action]) !== JSON.stringify(shipped[action]),
    );
    expect(divergent).toEqual([]);
    expect(actions).toContain("customers.getCustomer");
    expect(shipped["customers.getCustomer"]?.oneOf).toEqual([
      "customer",
      "phone",
      "email",
    ]);
  });

  it("need one of customer, phone or email for d72-read-one", async () => {
    const vector = vectors.find((candidate) => candidate.id === "d72-read-one");
    if (vector === undefined) throw new Error("d72-read-one vector is missing");
    const command = decodeVector(
      bundle,
      vector,
      null,
      undefined,
      await requirementsOf(),
    )[0];
    expect(command?.needs).toEqual([
      { path: "customer|phone|email", reason: "missing", blocking: true },
    ]);
  });

  it("decode the D88-D92 focus vectors to exactly the expected commands", async () => {
    expect(focusVectors.length).toBe(46);
    expect(new Set(focusVectors.map((vector) => vector.id)).size).toBe(
      focusVectors.length,
    );
    const failures: string[] = [];
    const contexts = new Map<string | null, CompiledContext | null>();
    for (const vector of focusVectors) {
      let context = contexts.get(vector.context);
      if (context === undefined) {
        context = await vectorContext(conformanceDir, vector.context);
        contexts.set(vector.context, context);
      }
      try {
        expect(pinned(decodeFocusVector(bundle, vector, context))).toEqual(
          vector.expect,
        );
      } catch {
        failures.push(vector.id);
      }
    }
    console.log(
      `Шо v3 focus: ${String(focusVectors.length - failures.length)} of ${String(focusVectors.length)} vectors`,
    );
    expect(failures).toEqual([]);
  });

  it("decode the D94 contact vectors against the v3.5 contact labels", async () => {
    const contacts = await readContactVectors(conformanceDir);
    expect(contacts.length).toBe(13);
    const target = await vectorBundle(
      conformanceDir,
      join(modelDir, "tokenizer.json"),
      CONTACT_LABELS,
    );
    const requirements: Requirements = await vectorRequirements(conformanceDir);
    const failures: string[] = [];
    const contexts = new Map<string | null, CompiledContext | null>();
    for (const vector of contacts) {
      let context = contexts.get(vector.context);
      if (context === undefined) {
        context = await vectorContext(conformanceDir, vector.context);
        contexts.set(vector.context, context);
      }
      try {
        expect(
          decodeVector(target, vector, context, undefined, requirements).map(
            pinned,
          )[0],
        ).toEqual(vector.expect);
      } catch {
        failures.push(vector.id);
      }
    }
    expect(failures).toEqual([]);
  });
});
