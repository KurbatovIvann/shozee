import { CoreInvariantError } from "@showzy/core/errors";

const CURRENCY_SUFFIX: Readonly<Record<string, string>> = { UAH: "грн" };

function groupThousands(whole: string): string {
  const parts: string[] = [];
  let remaining = whole;
  while (remaining.length > 3) {
    parts.unshift(remaining.slice(-3));
    remaining = remaining.slice(0, -3);
  }
  parts.unshift(remaining);
  return parts.join(" ");
}

export function formatMinorUnits(
  minor: string,
  fractionDigits: number,
): string {
  const negative = minor.startsWith("-");
  const digits = negative ? minor.slice(1) : minor;
  if (digits.length === 0 || !/^[0-9]+$/.test(digits)) {
    throw new CoreInvariantError(`illegal minor-unit string "${minor}"`);
  }
  const padded = digits.padStart(fractionDigits + 1, "0");
  const whole = padded.slice(0, -fractionDigits);
  const frac = padded.slice(-fractionDigits);
  const grouped = groupThousands(whole);
  const sign = negative ? "-" : "";
  return `${sign}${grouped},${frac}`;
}

export function formatMoneyMinor(minor: string, currency: string): string {
  const suffix = CURRENCY_SUFFIX[currency] ?? currency;
  return `${formatMinorUnits(minor, 2)} ${suffix}`;
}

export function formatMoneyUah(minor: string): string {
  return formatMoneyMinor(minor, "UAH");
}

export function formatQuantityMilli(milli: string): string {
  if (!/^[1-9][0-9]*$/.test(milli)) {
    throw new CoreInvariantError(`illegal quantity_milli string "${milli}"`);
  }
  const padded = milli.padStart(4, "0");
  const whole = padded.slice(0, -3);
  const frac = padded.slice(-3).replace(/0+$/, "");
  return frac.length === 0
    ? groupThousands(whole)
    : `${groupThousands(whole)},${frac}`;
}
