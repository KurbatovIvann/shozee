import { describe, expect, it } from "vitest";

import { sharedDocumentsCopy } from "./documents.js";
import { leafAt, leafPaths } from "./leaf-paths.js";

describe("shared documents copy", () => {
  it("keeps uk/en key parity across the wholesale tree", () => {
    const uk = sharedDocumentsCopy("uk");
    const en = sharedDocumentsCopy("en");
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

  it("owns list, form, share, and signing trees", () => {
    const shared = sharedDocumentsCopy("uk");
    expect("title" in shared).toBe(true);
    expect("filters" in shared).toBe(true);
    expect("types" in shared).toBe(true);
    expect("empty" in shared).toBe(true);
    expect("options" in shared).toBe(true);
    expect("optionsGet" in shared).toBe(true);
    expect("generation" in shared).toBe(true);
    expect("confirm" in shared).toBe(true);
    expect("handover" in shared).toBe(true);
    expect("toast" in shared).toBe(true);
    expect("mutation" in shared).toBe(true);
    expect("form" in shared).toBe(true);
    expect("shared" in shared).toBe(true);
    expect("signing" in shared).toBe(true);
    expect("errors" in shared.form).toBe(true);
    expect("banners" in shared.signing).toBe(true);
  });

  it("keeps document-form chrome overrides, not the generic chrome verbs", () => {
    const uk = sharedDocumentsCopy("uk");
    const en = sharedDocumentsCopy("en");
    expect(en.form.submitCreate).toBe("Create");
    expect(uk.form.submitCreate).toBe("Створити");
    expect(en.form.submitCreateLoading).toBe("Creating…");
    expect(uk.form.submitCreateLoading).toBe("Створення…");
    expect(en.form.errors.validation).toBe(
      "Could not create the document. Check the seller legal details, customer, and counterparty.",
    );
    expect(uk.form.errors.validation).toBe(
      "Не вдалося створити документ. Перевірте реквізити продавця, клієнта та контрагента.",
    );
  });
});
