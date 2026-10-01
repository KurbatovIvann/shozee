import { CoreInvariantError } from "@showzy/core/errors";

export function previewCompanyScope(
  companyId: string | null,
  contract: { readonly name: string },
): string {
  if (companyId === null) {
    throw new CoreInvariantError(
      `${contract.name} preview ran without a company scope`,
    );
  }
  return companyId;
}
