export const SPAN_MAX_TOKENS = 3;
export const SPAN_CANDIDATES_MAX = 80;

const EDGE_PUNCTUATION = /^[\s"'«»“”(),.:;!?]+|[\s"'«»“”(),.:;!?]+$/gu;
const CLAUSE_BREAK = /[,.:;!?]$/u;
const NUMBER = /\d+(?:[.,]\d+)?/gu;

const NUMBER_WORDS: Readonly<Record<string, string>> = {
  один: "1",
  одну: "1",
  одне: "1",
  два: "2",
  дві: "2",
  пару: "2",
  три: "3",
  чотири: "4",
  "п'ять": "5",
  шість: "6",
  сім: "7",
  вісім: "8",
  "дев'ять": "9",
  десять: "10",
};

export function normalizeSpan(span: string): string {
  return span
    .replaceAll(EDGE_PUNCTUATION, "")
    .replaceAll(/\s+/gu, " ")
    .toLowerCase();
}

export function spanCandidates(message: string): readonly string[] {
  const tokens = message.split(/\s+/u).filter((token) => token !== "");
  const spans = new Set<string>();
  for (let start = 0; start < tokens.length; start += 1) {
    for (
      let length = 1;
      length <= SPAN_MAX_TOKENS && start + length <= tokens.length;
      length += 1
    ) {
      const slice = tokens.slice(start, start + length);
      const span = normalizeSpan(slice.join(" "));
      if (span !== "" && !/^\d+(?:[.,]\d+)?$/u.test(span)) {
        spans.add(span);
      }
      if (CLAUSE_BREAK.test(slice.at(-1) ?? "")) {
        break;
      }
    }
  }
  return [...spans].slice(0, SPAN_CANDIDATES_MAX);
}

export function numberCandidates(message: string): readonly string[] {
  const numbers = new Set<string>(message.match(NUMBER) ?? []);
  for (const token of message.toLowerCase().split(/\s+/u)) {
    const value = NUMBER_WORDS[normalizeSpan(token)];
    if (value !== undefined) {
      numbers.add(value);
    }
  }
  return [...numbers];
}

const ORDER_FILLER_WORDS: ReadonlySet<string> = new Set([
  "створи",
  "створити",
  "зроби",
  "зробити",
  "оформи",
  "оформити",
  "запиши",
  "записати",
  "замов",
  "прийми",
  "додай",
  "нове",
  "новий",
  "замовлення",
  "замовленя",
  "клієнт",
  "клієнта",
  "клієнту",
  "клієнтка",
  "клієнтки",
  "клієнтці",
  "покупець",
  "для",
  "на",
  "від",
  "і",
  "й",
  "та",
  "а",
  "ще",
  "також",
  "плюс",
  "шт",
  "штук",
  "штуки",
  "штуку",
  "будь",
  "ласка",
  "плз",
  "create",
  "make",
  "add",
  "place",
  "new",
  "an",
  "a",
  "the",
  "order",
  "for",
  "and",
  "with",
  "of",
  "please",
  "customer",
  "pcs",
]);

export function unconsumedWords(
  message: string,
  consumedSpans: readonly string[],
): readonly string[] {
  const consumed = new Set(consumedSpans.flatMap((span) => span.split(" ")));
  return message
    .split(/\s+/u)
    .map(normalizeSpan)
    .filter(
      (word) =>
        word !== "" &&
        !/^[\d.,×x*-]+$/u.test(word) &&
        !(word in NUMBER_WORDS) &&
        !ORDER_FILLER_WORDS.has(word) &&
        !consumed.has(word),
    );
}
