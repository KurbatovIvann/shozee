import type { ActionPreviewLine } from "@showzy/core/errors";

export const PREVIEW_CHANGES_LABEL = "Зміни";
export const PREVIEW_NO_CHANGES = "немає змін";

export function changeLines(
  lines: readonly ActionPreviewLine[],
): ActionPreviewLine[] {
  return lines.length === 0
    ? [{ label: PREVIEW_CHANGES_LABEL, value: PREVIEW_NO_CHANGES }]
    : [...lines];
}
