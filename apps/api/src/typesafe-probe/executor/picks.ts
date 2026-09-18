import type { JudgmentProvider, JudgmentText } from "@showzy/ai";

import { mean, num, pct, share } from "../probe.js";

export const PICK_NONE = "none";
export const PICK_AMBIGUOUS = "ambiguous";

export interface PickCase {
  readonly id: string;
  readonly group: "customer" | "product" | "customer group" | "context";
  readonly state: { readonly [key: string]: JudgmentText };
  readonly instructions: string;
  readonly options: readonly string[];
  readonly expected: readonly string[];
}

const RESOLVE_INSTRUCTIONS = (kind: string): string =>
  `\`mention\` is how a staff member referred to a ${kind} in a Ukrainian message; it may be inflected, shortened, misspelled or transliterated. Which stored record is it? Choose \`${PICK_AMBIGUOUS}\` when two or more records fit equally well. Choose \`${PICK_NONE}\` when no record fits.`;

const resolve = (
  group: "customer" | "product" | "customer group",
  id: string,
  mention: string,
  options: readonly string[],
  ...expected: string[]
): PickCase => ({
  id,
  group,
  state: { mention },
  instructions: RESOLVE_INSTRUCTIONS(group),
  options: [...options, PICK_AMBIGUOUS],
  expected,
});

const context = (
  id: string,
  history: readonly string[],
  message: string,
  what: string,
  options: readonly string[],
  ...expected: string[]
): PickCase => ({
  id,
  group: "context",
  state: { history: [...history], message },
  instructions: `\`history\` is the conversation so far, oldest first; \`message\` is the staff member's new message. Which option is ${what} that \`message\` refers to? Choose \`${PICK_NONE}\` when it refers to none of them.`,
  options,
  expected,
});

export const PICK_CASES: readonly PickCase[] = [
  resolve(
    "customer",
    "genitive-full-name",
    "олени петренко",
    ["Олена Петренко", "Олена Петрук", "Олег Петренко", "Олеся Петренко"],
    "Олена Петренко",
  ),
  resolve(
    "customer",
    "accusative-full-name",
    "ігоря шевчука",
    ["Ігор Шевчук", "Ігор Шевченко", "Ірина Шевчук"],
    "Ігор Шевчук",
  ),
  resolve(
    "customer",
    "accusative-female",
    "марію коваль",
    ["Марія Коваль", "Марина Коваль", "Марія Ковальчук"],
    "Марія Коваль",
  ),
  resolve(
    "customer",
    "surname-only",
    "коваленка",
    ["Андрій Коваленко", "Петро Коваль", "Іван Ковальчук"],
    "Андрій Коваленко",
  ),
  resolve(
    "customer",
    "surname-two-matches",
    "коваленка",
    ["Андрій Коваленко", "Ольга Коваленко", "Іван Ковальчук"],
    PICK_AMBIGUOUS,
  ),
  resolve(
    "customer",
    "diminutive",
    "олі",
    ["Ольга Бондар", "Олена Петренко", "Олег Гук"],
    "Ольга Бондар",
  ),
  resolve(
    "customer",
    "diminutive-gendered",
    "саша білий",
    ["Олександр Білий", "Олександра Біла", "Сашко Чорний"],
    "Олександр Білий",
  ),
  resolve(
    "customer",
    "company",
    "тов ромашка",
    ["ТОВ Ромашка", "ФОП Ромашко О.В.", "ТОВ Ромашка Плюс"],
    "ТОВ Ромашка",
  ),
  resolve(
    "customer",
    "transliterated",
    "anna",
    ["Анна Лисенко", "Ганна Мороз", "Антон Лис"],
    "Анна Лисенко",
  ),
  resolve(
    "customer",
    "no-record",
    "бондаренко",
    ["Оксана Бондар", "Ігор Бондарчук", "Олена Петренко"],
    PICK_NONE,
  ),
  resolve(
    "customer",
    "surname-shared",
    "петренка",
    ["Олена Петренко", "Петро Петренко"],
    PICK_AMBIGUOUS,
  ),
  resolve(
    "customer",
    "near-surname",
    "гриценка",
    ["Віктор Гриценко", "Віктор Грищенко"],
    "Віктор Гриценко",
  ),
  resolve(
    "product",
    "exact-beats-variant",
    "капучино",
    ["Капучино", "Капучино велике", "Лате"],
    "Капучино",
  ),
  resolve(
    "product",
    "two-variants",
    "чізкейків",
    ["Чізкейк класичний", "Чізкейк шоколадний", "Тірамісу"],
    PICK_AMBIGUOUS,
  ),
  resolve(
    "product",
    "plural-genitive",
    "круасанів",
    ["Круасан", "Круасан з шоколадом", "Багет"],
    "Круасан",
  ),
  resolve(
    "product",
    "misspelled",
    "капучіно",
    ["Капучино", "Какао", "Кава фільтр"],
    "Капучино",
  ),
  resolve(
    "product",
    "latin-for-cyrillic",
    "flat white",
    ["Флет вайт", "Лате", "Американо"],
    "Флет вайт",
  ),
  resolve(
    "product",
    "plural-short",
    "рафи",
    ["Раф", "Раф лавандовий", "Рафаелло"],
    "Раф",
  ),
  resolve(
    "product",
    "only-one-fits",
    "тістечко",
    ["Тістечко картопля", "Еклер", "Макарон"],
    "Тістечко картопля",
  ),
  resolve(
    "product",
    "product-no-record",
    "матча",
    ["Лате", "Капучино", "Еспресо"],
    PICK_NONE,
  ),
  resolve(
    "product",
    "exact-beats-longer",
    "американо",
    ["Американо", "Американо з молоком"],
    "Американо",
  ),
  resolve(
    "product",
    "generic-word",
    "кави",
    ["Кава в зернах 1 кг", "Кава мелена 250 г", "Капучино"],
    PICK_AMBIGUOUS,
  ),
  resolve(
    "customer group",
    "genitive-plural",
    "оптовиків",
    ["Оптовики", "Роздріб", "VIP"],
    "Оптовики",
  ),
  resolve(
    "customer group",
    "cyrillic-for-latin",
    "віп",
    ["VIP", "Постійні", "Оптовики"],
    "VIP",
  ),
  resolve(
    "customer group",
    "shortened",
    "постійні",
    ["Постійні клієнти", "Нові клієнти"],
    "Постійні клієнти",
  ),
  context(
    "pronoun-order",
    ["assistant: Створено замовлення 1101 для Олени Петренко."],
    "Підтверди його",
    "the order number",
    ["1101"],
    "1101",
  ),
  context(
    "ordinal-order",
    ["assistant: Знайдено замовлення: 1042 (нове), 1043 (підтверджене)."],
    "Скасуй друге",
    "the order number",
    ["1042", "1043"],
    "1043",
  ),
  context(
    "order-among-numbers",
    [
      "user: Покажи замовлення 1050",
      "assistant: Замовлення 1050: 3 лате, сума 195 грн.",
    ],
    "Випиши по ньому рахунок",
    "the order number",
    ["1050", "3", "195"],
    "1050",
  ),
  context(
    "newest-order",
    ["assistant: Замовлення 1080 скасовано. Замовлення 1081 створено."],
    "Підтверди нове",
    "the order number",
    ["1080", "1081"],
    "1081",
  ),
  context(
    "count-is-not-an-order",
    ["assistant: У вас 5 нових замовлень сьогодні."],
    "Підтверди його",
    "the order number",
    ["5"],
    PICK_NONE,
  ),
  context(
    "pronoun-customer",
    [
      "assistant: Клієнта Оксана Бондар створено.",
      "assistant: Групу Оптовики створено.",
    ],
    "Зроби для неї замовлення: 2 лате",
    "the customer",
    ["Оксана Бондар", "Оптовики"],
    "Оксана Бондар",
  ),
  context(
    "topic-switch",
    ["assistant: Створено замовлення 1101 для Олени Петренко.", "user: Дякую"],
    "А тепер підтверди замовлення 1099",
    "the order number",
    ["1101", "1099"],
    "1099",
  ),
];

export interface PickRow {
  readonly caseId: string;
  readonly group: PickCase["group"];
  readonly expected: readonly string[];
  readonly got: string;
  readonly confidence: number;
  readonly correct: boolean;
  readonly inputTokens: number;
}

export async function runPickProbe(
  provider: JudgmentProvider,
  cases: readonly PickCase[],
): Promise<PickRow[]> {
  const rows: PickRow[] = [];
  for (const pickCase of cases) {
    const criteria: Record<string, JudgmentText | null> = {};
    for (const option of pickCase.options) {
      criteria[option] = null;
    }
    criteria[PICK_NONE] = "None of the options.";
    const result = await provider.ask({
      state: pickCase.state,
      questions: {
        pick: { type: "choice", instructions: pickCase.instructions, criteria },
      },
    });
    const base = {
      caseId: pickCase.id,
      group: pickCase.group,
      expected: pickCase.expected,
    };
    rows.push(
      result.ok
        ? {
            ...base,
            got: result.answers.pick.choice,
            confidence: result.answers.pick.confidence,
            correct: pickCase.expected.includes(result.answers.pick.choice),
            inputTokens: result.usage.inputTokens,
          }
        : {
            ...base,
            got: `refused: ${result.reason}`,
            confidence: 0,
            correct: false,
            inputTokens: 0,
          },
    );
  }
  return rows;
}

export function renderPickMarkdown(
  model: string,
  rows: readonly PickRow[],
): string {
  const groups = [...new Set(rows.map((row) => row.group))];
  const line = (label: string, subset: readonly PickRow[]): string =>
    `| ${label} | ${String(subset.length)} | ${pct(share(subset.map((row) => row.correct)))} | ${num(mean(subset.filter((row) => row.correct).map((row) => row.confidence)))} / ${num(mean(subset.filter((row) => !row.correct).map((row) => row.confidence)))} |`;
  return [
    `Model \`${model}\`, ${String(rows.length)} requests, ${String(rows.reduce((sum, row) => sum + row.inputTokens, 0))} input tokens.`,
    "",
    "| Group | n | Correct | Confidence ok / wrong |",
    "| --- | --- | --- | --- |",
    line("all", rows),
    ...groups.map((group) =>
      line(
        group,
        rows.filter((row) => row.group === group),
      ),
    ),
    "",
    "Misses:",
    "",
    "| Case | Expected | Got | Confidence |",
    "| --- | --- | --- | --- |",
    ...rows
      .filter((row) => !row.correct)
      .map(
        (row) =>
          `| ${row.caseId} | ${row.expected.join(" / ")} | ${row.got} | ${num(row.confidence)} |`,
      ),
  ].join("\n");
}
