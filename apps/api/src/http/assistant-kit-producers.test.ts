/**
 * A declared capability with nothing that produces it.
 *
 * This is a recurring shape here, not bad luck. The previous assistant carried a
 * generic `needs_choice` path in `execute.ts` that nothing produced — it was one
 * of the reasons that path was replaced. The shared surface registry carried a
 * `hydratable` flag whose only reader had been deleted. And this rewrite shipped
 * two more: `replace_card`, implemented in the kit and produced by nobody, and
 * the `confirmation` interaction, registered and rendered end to end with no
 * server path that opens one. `replace_card` is gone (SHO-551): what it
 * promised became a rule the writer enforces on every append, so there is no
 * second kind left for a producer to forget. The confirmation is opened by
 * core's own challenge since SHO-553. The list below is empty for now, and it is
 * where the next such debt gets its name.
 *
 * A registry makes declaring cheap and wiring separate, so the gap between them
 * is invisible until something tries to use it. This closes the gap by making it
 * fail: a kind with no producer must be named here with the ticket that will
 * wire it, or the suite goes red.
 *
 * The repo already had this idea. `assistant-surfaces.source.test.ts` asserted a
 * shared export had "a production caller" (SHO-461), written after the same
 * class of defect. It was removed with the caller it guarded and the idea was
 * not carried over. It is carried over here.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { assistantInteractionTypes } from "./assistant-interactions.js";

const httpDir = path.dirname(fileURLToPath(import.meta.url));
const kitSrc = path.resolve(httpDir, "../../../../packages/assistant-kit/src");

/**
 * Kinds that are declared and not yet produced, each with the ticket that will
 * wire it. An entry is a debt with a name and a date, which is the whole
 * difference between this and the silence it replaces.
 *
 * Removing a kind from this list without wiring it turns the suite red.
 */
const UNWIRED: Readonly<Record<string, string>> = {};

function sourcesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourcesUnder(full));
      continue;
    }
    if (entry.endsWith(".ts") && !entry.includes(".test.")) {
      out.push(full);
    }
  }
  return out;
}

function producedIn(files: readonly string[], literal: string): boolean {
  const produces = new RegExp(
    `kind:\\s*"${literal}"|["']${literal}["']\\s*as const`,
  );
  return files.some((file) => produces.test(readFileSync(file, "utf8")));
}

describe("every declared kind has something that produces it", () => {
  /**
   * The kinds a deployment says it can ask about. Each needs a tool outcome
   * somewhere that opens one, or the card can never appear.
   */
  it("interaction kinds are opened by something, or named as unwired", () => {
    const files = sourcesUnder(httpDir);
    const unwired: string[] = [];

    for (const kind of Object.keys(assistantInteractionTypes)) {
      const opens = new RegExp(`interaction:\\s*"${kind}"`);
      const produced = files.some((file) =>
        opens.test(readFileSync(file, "utf8")),
      );
      if (!produced) {
        unwired.push(kind);
      }
    }

    expect(unwired.toSorted()).toEqual(
      Object.keys(UNWIRED)
        .filter((kind) => kind in assistantInteractionTypes)
        .toSorted(),
    );
    for (const kind of unwired) {
      expect(
        UNWIRED[kind],
        `${kind} must name the ticket that wires it`,
      ).toMatch(/^SHO-\d+$/);
    }
  });

  /**
   * The ways a turn may change the stored document. There is one: "the same
   * card id is an update" is a rule of `append`, not a second kind a producer
   * has to remember to choose — that second kind was produced by nobody, and a
   * record showed twice (SHO-551). A new kind here needs a producer too.
   */
  it("document write kinds are produced by something, or named as unwired", () => {
    const declaration = readFileSync(path.join(kitSrc, "document.ts"), "utf8");
    const kinds = [
      ...declaration.matchAll(/readonly kind:\s*"([a-z_]+)"/g),
    ].map((match) => match[1] ?? "");
    expect(kinds.toSorted()).toEqual(["append"]);

    const files = sourcesUnder(kitSrc).filter(
      (file) => !file.endsWith(`${path.sep}document.ts`),
    );
    const unwired = kinds.filter((kind) => !producedIn(files, kind));

    expect(unwired.toSorted()).toEqual(
      Object.keys(UNWIRED)
        .filter((kind) => kinds.includes(kind))
        .toSorted(),
    );
  });

  /**
   * The list itself can rot. An entry naming something that no longer exists is
   * the same dead configuration this file was written to catch, so it is caught
   * here rather than left to be read as a real debt.
   */
  it("carries no entry that is neither a real kind nor a named ticket", () => {
    const declaration = readFileSync(path.join(kitSrc, "document.ts"), "utf8");
    const known = new Set([
      ...Object.keys(assistantInteractionTypes),
      ...[...declaration.matchAll(/readonly kind:\s*"([a-z_]+)"/g)].map(
        (match) => match[1] ?? "",
      ),
    ]);

    for (const [kind, ticket] of Object.entries(UNWIRED)) {
      expect(known.has(kind), `${kind} is not a kind anything declares`).toBe(
        true,
      );
      expect(ticket, kind).toMatch(/^SHO-\d+$/);
    }
  });
});
