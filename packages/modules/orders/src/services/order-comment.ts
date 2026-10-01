export function normalizeOrderComment(
  comment: string | null | undefined,
): string | null {
  if (comment === undefined || comment === null) {
    return null;
  }
  const trimmed = comment.trim();
  return trimmed.length === 0 ? null : trimmed;
}
