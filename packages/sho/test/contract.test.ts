import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import type {
  ActionName,
  CommandV2,
  Context,
  FocusEntry,
  Need,
  Ref,
  ResultV2,
  RunOptions,
} from "../src/contract.ts";

const contractPath = fileURLToPath(
  new URL("../src/contract.ts", import.meta.url),
);
const source = await readFile(contractPath, "utf8");
const emitted = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.NodeNext,
    target: ts.ScriptTarget.ES2023,
    verbatimModuleSyntax: true,
    isolatedModules: true,
  },
}).outputText;

describe("@showzy/sho/contract", () => {
  it("compiles to a module that imports nothing", () => {
    expect(ts.preProcessFile(emitted).importedFiles).toEqual([]);
    expect(emitted).not.toMatch(/onnxruntime|node:|require\(/);
  });

  it("declares nothing but type exports", () => {
    const statements = source
      .split("\n")
      .filter((line) => /^\s*(import|export)\b/.test(line));
    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements)
      expect(statement.trimStart().startsWith("export type ")).toBe(true);
  });

  it("types a Шо result the host reads", () => {
    const need: Need = { path: "text", reason: "language", blocking: false };
    const contact: Ref = {
      text: "050 334 12 90",
      status: "unchecked",
      by: "phone",
      value: "0503341290",
    };
    const command: CommandV2 = {
      text: "thanks a lot that was helpful",
      action: "none" as ActionName,
      kind: "none",
      effect: "none",
      confirm: "none",
      params: { customer: contact },
      needs: [need],
      ready: true,
      refPrevious: {},
      catalogued: false,
      confidence: { action: 0, margin: 0, certainty: 0, spans: 1 },
    };
    const result: ResultV2 = {
      schema: "sho-result/2",
      raw: "Thanks a lot, that was helpful!",
      text: command.text,
      commands: [command],
      first: command,
      segments: [command.text],
      tooMany: false,
      context: null,
    };
    expect(result.first.needs[0]?.reason).toBe("language");
  });

  it("types the run options a host passes", () => {
    const focus: FocusEntry = {
      type: "order",
      id: "o-1",
      name: "12",
      how: "created",
      turns: 0,
    };
    const context: Context = { version: 2, customers: [] };
    const options: RunOptions = { focus: [focus], context: null };
    expect(context.version).toBe(2);
    expect(options.focus?.[0]?.type).toBe("order");
  });
});
