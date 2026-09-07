import { describe, expect, it } from "vitest";

import { sharedCustomersCopy, type SharedCustomersCopy } from "./customers.js";
import { leafAt, leafPaths } from "./leaf-paths.js";

const FORM_TREES = [
  "form",
  "groupForm",
  "counterpartyForm",
  "inviteForm",
] as const;

function isFormPath(path: string): boolean {
  return FORM_TREES.some(
    (tree) => path === tree || path.startsWith(`${tree}.`),
  );
}

function listPaths(copy: SharedCustomersCopy): string[] {
  return leafPaths(copy).filter((path) => !isFormPath(path));
}

describe("shared customers copy", () => {
  it("keeps uk/en key parity across the wholesale tree", () => {
    const uk = sharedCustomersCopy("uk");
    const en = sharedCustomersCopy("en");
    expect(leafPaths(uk)).toEqual(leafPaths(en));
    for (const path of leafPaths(uk)) {
      const ukValue = leafAt(uk, path);
      const enValue = leafAt(en, path);
      expect(typeof ukValue, path).toBe("string");
      expect(typeof enValue, path).toBe("string");
      expect(String(ukValue).length, path).toBeGreaterThan(0);
      expect(String(enValue).length, path).toBeGreaterThan(0);
    }
  });

  it("keeps uk/en key parity on the list subtree", () => {
    const uk = sharedCustomersCopy("uk");
    const en = sharedCustomersCopy("en");
    expect(listPaths(uk)).toEqual(listPaths(en));
    expect(listPaths(uk).length).toBeGreaterThan(0);
  });

  it("keeps uk/en key parity on each form subtree", () => {
    const uk = sharedCustomersCopy("uk");
    const en = sharedCustomersCopy("en");
    for (const tree of FORM_TREES) {
      expect(leafPaths(uk[tree]), tree).toEqual(leafPaths(en[tree]));
    }
  });

  it("owns list plus the four form trees", () => {
    const shared = sharedCustomersCopy("uk");
    expect("title" in shared).toBe(true);
    expect("tabs" in shared).toBe(true);
    expect("empty" in shared).toBe(true);
    expect("confirm" in shared).toBe(true);
    for (const tree of FORM_TREES) {
      expect(tree in shared).toBe(true);
      expect("errors" in shared[tree]).toBe(true);
    }
  });
});
