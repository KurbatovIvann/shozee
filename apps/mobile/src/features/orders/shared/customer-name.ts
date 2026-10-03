export const UNLINKED_CUSTOMER_NAME_SNAPSHOT = "unlinked";

export function localizeCustomerNameSnapshot(
  nameSnapshot: string,
  fallback: string,
): string {
  if (nameSnapshot === UNLINKED_CUSTOMER_NAME_SNAPSHOT) {
    return fallback;
  }
  return nameSnapshot;
}
