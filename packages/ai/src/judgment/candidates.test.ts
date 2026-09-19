import { describe, expect, it } from "vitest";

import { unconsumedWords } from "./candidates.js";

describe("unconsumedWords", () => {
  it("is empty when every word is a filler, a number or inside a taken span", () => {
    expect(
      unconsumedWords(
        "Створи замовлення для Олени Петренко: 2 капучино і 1 круасан, будь ласка",
        ["олени петренко", "капучино", "круасан"],
      ),
    ).toEqual([]);
    expect(
      unconsumedWords("Create an order for Anna Kowalska: two lattes x 2", [
        "anna kowalska",
        "lattes",
        "two",
      ]),
    ).toEqual([]);
    expect(
      unconsumedWords("Наталії Гук дві кави", ["наталії гук", "кави"]),
    ).toEqual([]);
  });

  it("names the words a plan left out", () => {
    expect(
      unconsumedWords("Для Олени Петренко 2 великих капучино", [
        "олени петренко",
        "капучино",
      ]),
    ).toEqual(["великих"]);
    expect(
      unconsumedWords("Для Кава Хаус на Подолі 20 круасанів", [
        "кава хаус",
        "круасанів",
      ]),
    ).toEqual(["подолі"]);
  });
});
