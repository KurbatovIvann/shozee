import { CoreInvariantError } from "@showzy/core/errors";

export function previewCompanyScope(
  companyId: string | null,
  actionName: string,
): string {
  if (companyId === null) {
    throw new CoreInvariantError(
      `${actionName} preview ran without a company scope`,
    );
  }
  return companyId;
}
