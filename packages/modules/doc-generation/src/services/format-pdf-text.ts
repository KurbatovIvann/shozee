import { CoreInvariantError } from "@showzy/core/errors";

/** `YYYY-MM-DD` → `DD.MM.YYYY` from the stored Kyiv calendar day. */
export function formatIssuedOn(issuedOn: string): string {
  const parts = issuedOn.split("-");
  const year = parts[0];
  const month = parts[1];
  const day = parts[2];
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    year.length !== 4 ||
    month.length !== 2 ||
    day.length !== 2
  ) {
    throw new CoreInvariantError(`issuedOn is not YYYY-MM-DD: ${issuedOn}`);
  }
  return `${day}.${month}.${year}`;
}
