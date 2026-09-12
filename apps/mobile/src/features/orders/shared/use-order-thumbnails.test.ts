import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(
  new URL("./use-order-thumbnails.ts", import.meta.url),
  "utf8",
);

describe("useOrderThumbnails signing rendition", () => {
  it("signs the list rendition instead of the full-size original", () => {
    expect(SOURCE).toContain(
      'export const ORDER_THUMBNAIL_RENDITION = "thumb"',
    );
    expect(SOURCE).toContain("rendition: ORDER_THUMBNAIL_RENDITION,");
  });
});
