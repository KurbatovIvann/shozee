import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { chipCapsule, chipPressed } from "./chip-capsule";
import { lightTheme } from "../../theme/light";

const actionChip = readFileSync(
  new URL("./action-chip.tsx", import.meta.url),
  "utf8",
);
const choiceField = readFileSync(
  new URL("./choice-field.tsx", import.meta.url),
  "utf8",
);

describe("chipCapsule", () => {
  it("gives every chip a tappable capsule from theme tokens", () => {
    const capsule = chipCapsule({
      theme: lightTheme,
      paddingHorizontal: lightTheme.spacing.md,
      shrink: false,
    });
    expect(capsule.minHeight).toBe(lightTheme.hitTarget.min);
    expect(capsule.justifyContent).toBe("center");
    expect(capsule.borderRadius).toBe(lightTheme.radii.full);
    expect(capsule.backgroundColor).toBe(lightTheme.colors.card);
    expect(capsule.paddingHorizontal).toBe(lightTheme.spacing.md);
  });

  it("holds its width in a scrolling row and gives it up in a wrapping one", () => {
    const strip = chipCapsule({
      theme: lightTheme,
      paddingHorizontal: lightTheme.spacing.md,
      shrink: false,
    });
    const wrapped = chipCapsule({
      theme: lightTheme,
      paddingHorizontal: lightTheme.spacing.md,
      shrink: true,
    });
    expect(strip.flexShrink).toBe(0);
    expect(wrapped.flexShrink).toBe(1);
  });

  it("dims a pressed chip by the shared opacity", () => {
    expect(chipPressed(lightTheme)).toEqual({
      opacity: lightTheme.pressedOpacity,
    });
  });

  it("is the one source both chip surfaces read", () => {
    expect(actionChip).toContain("chipCapsule(");
    expect(actionChip).toContain("chipPressed(");
    expect(choiceField).toContain("chipCapsule(");
    expect(choiceField).toContain("chipPressed(");
    expect(actionChip).not.toContain("theme.radii.full");
    expect(choiceField).not.toContain("theme.radii.full");
  });
});
