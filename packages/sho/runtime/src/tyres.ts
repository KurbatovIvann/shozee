// Tyre sizes (D66): «205/55 R16» is a width of 205 mm, a profile of 55 % and a rim of 16 inches. People say the three numbers («205 55 16», «двісті п'ять
// п'ятдесят п'ять шістнадцять», «205 на 55 р16») or a part: the rim («R16», «р шістнадцять», «радіус 16») or the width and profile («205/55»). Tokens are
// `nameTokens` output: numbers in digits, «r» for the rim letter.

const RIM = "r";
// From 60 since D71: motorcycle and scooter tyres («110/70 R17», «120/70 R12»).
const WIDTHS = [60, 395] as const;
const PROFILES = [25, 95] as const;
const RIMS = [8, 24] as const;
const PROFILE_STEP = 5;
const DIGITS = /^[0-9]+$/;
const RIM_WRITTEN = /[rр]\s*[0-9]/iu;

function within(token: string | undefined, [low, high]: readonly [number, number]): boolean {
  return token !== undefined && DIGITS.test(token) && Number(token) >= low && Number(token) <= high;
}

function widthAndProfile(tokens: readonly string[], at: number): boolean {
  return within(tokens[at], WIDTHS) && within(tokens[at + 1], PROFILES) && Number(tokens[at + 1]) % PROFILE_STEP === 0;
}

// Three numbers in a row that read as a tyre size, with no rim letter said («205 55 16»), get it: «205», «55», «r», «16», as «205/55 R16» is written.
export function withRim(tokens: readonly string[]): string[] {
  const out: string[] = [];
  for (let at = 0; at < tokens.length; at++) {
    out.push(tokens[at] ?? "");
    const bare = widthAndProfile(tokens, at) && within(tokens[at + 2], RIMS) && !DIGITS.test(tokens[at + 3] ?? "") && !DIGITS.test(tokens[at - 1] ?? "");
    if (bare) {
      out.push(tokens[at + 1] ?? "", RIM, tokens[at + 2] ?? "");
      at += 2;
    }
  }
  return out;
}

// The parts of a tyre size a variant value names, which name the variant too (D66): «205/55 R16» → «205/55», «R16». Only a value written with its rim
// letter is a tyre size; anything else has none.
export function tyreParts(written: string, tokens: readonly string[]): string[] {
  const [width, profile, rim, size] = tokens;
  if (!RIM_WRITTEN.test(written) || tokens.length !== 4 || width === undefined || profile === undefined || size === undefined || rim !== RIM) return [];
  if (!widthAndProfile(tokens, 0) || !within(size, RIMS)) return [];
  return [`${width}/${profile}`, `R${size}`];
}
