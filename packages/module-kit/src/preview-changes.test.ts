import { describe, expect, it } from "vitest";

import {
  changeLines,
  PREVIEW_CHANGES_LABEL,
  PREVIEW_NO_CHANGES,
} from "./preview-changes.js";

describe("changeLines", () => {
  it("cards one placeholder line when the update changes nothing", () => {
    expect(changeLines([])).toEqual([
      { label: PREVIEW_CHANGES_LABEL, value: PREVIEW_NO_CHANGES },
    ]);
  });

  it("keeps the lines an update does name", () => {
    expect(changeLines([{ label: "Назва", value: "A → B" }])).toEqual([
      { label: "Назва", value: "A → B" },
    ]);
  });
});
