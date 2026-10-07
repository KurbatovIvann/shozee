import { UNLINKED_CUSTOMER_NAME_SNAPSHOT } from "@showzy/contract";

export function localizeCustomerNameSnapshot(
  nameSnapshot: string,
  fallback: string,
): string {
  if (nameSnapshot === UNLINKED_CUSTOMER_NAME_SNAPSHOT) {
    return fallback;
  }
  return nameSnapshot;
}
