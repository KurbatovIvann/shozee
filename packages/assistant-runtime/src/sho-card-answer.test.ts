import type { ModelMessage } from "@showzy/assistant-kit";
import { shoCommandSchema, type ShoCommand } from "@showzy/sho-protocol";
import type { AssistantPause } from "@showzy/validation/assistant-chat";
import { describe, expect, it, vi } from "vitest";

import { matchAssistantPauseAnswer } from "./assistant-pause-match.js";
import {
  runShoCardAnswer,
  shoCardAnswerFor,
  shoMayReadCard,
} from "./sho-card-answer.js";
import { shoLogOptions } from "./sho-focus.js";
import type { ShoEngine, ShoPlan, ShoTurnRequest } from "./sho-turn.js";

const NOW = new Date("2026-10-03T08:00:00.000Z");

interface Said {
  readonly text: string;
  readonly action: string;
  readonly pickText?: string;
  readonly kind?: string;
  readonly effect?: string;
  readonly confirm?: string;
  readonly needs?: readonly {
    readonly path: string;
    readonly reason: string;
    readonly blocking: boolean;
  }[];
}

const UI_INTENT_KINDS: Readonly<Record<string, string>> = {
  "ui.pick": "ui",
  "ui.confirm": "ui",
  "ui.refine": "read-modifier",
};

function commandOf(said: Said): ShoCommand {
  return shoCommandSchema.parse({
    text: said.text,
    action: said.action,
    kind: said.kind ?? UI_INTENT_KINDS[said.action] ?? "read",
    effect: said.effect ?? "ui",
    confirm: said.confirm ?? "none",
    params:
      said.pickText === undefined ? {} : { pick_text: { text: said.pickText } },
    needs: said.needs ?? [],
    ready: true,
    catalogued: false,
    confidence: { action: 0.99, margin: 0.8, certainty: 0.9, spans: 0.9 },
    refPrevious: {},
  });
}

function routedToTheCard(
  command: ShoCommand,
  pause: AssistantPause,
  text: string,
): { readonly kind: string } | null {
  const read = matchAssistantPauseAnswer(pause, text);
  return shoMayReadCard(read) ? shoCardAnswerFor(command, pause, text) : read;
}

function choiceCard(
  subject: string,
  labels: readonly string[],
): AssistantPause {
  return {
    kind: "choice",
    interactionId: "11111111-1111-4111-8111-111111111111",
    revision: 1,
    status: "open",
    prompt: {
      subject,
      options: labels.map((label, index) => ({
        optionId: `opt-${String(index + 1)}`,
        label,
        kind: "record",
      })),
      optionsTruncated: false,
      nearest: false,
    },
    expiresAt: "2026-10-03T09:00:00.000Z",
  };
}

function previewCard(level: "card" | "strong"): AssistantPause {
  return {
    kind: "confirmation",
    interactionId: "22222222-2222-4222-8222-222222222222",
    revision: 1,
    status: "open",
    prompt: {
      summary: "Створити замовлення?",
      preview: { title: "Нове замовлення", lines: [], notes: [] },
      also: [],
      level,
    },
    expiresAt: "2026-10-03T09:00:00.000Z",
  };
}

const SHO_740_ANSWERS: readonly {
  readonly phrase: string;
  readonly action: string;
  readonly pickText?: string;
  readonly card: AssistantPause;
  readonly answer: unknown;
  readonly hints?: true;
}[] = [
  {
    phrase: "65 гривень",
    action: "ui.pick",
    card: choiceCard("Яка ціна у товару Лате?", ["65 гривень", "70 гривень"]),
    answer: { optionId: "opt-1" },
  },
  {
    phrase: "Постійні",
    action: "ui.pick",
    card: choiceCard("Як назвати групу?", ["Постійні", "Нові"]),
    answer: { optionId: "opt-1" },
  },
  {
    phrase: "Зимовий",
    action: "ui.pick",
    card: choiceCard("Яка назва прайсу?", ["Літній", "Зимовий"]),
    answer: { optionId: "opt-2" },
  },
  {
    phrase: "Андрій Коваль, 0501112233",
    action: "ui.refine",
    card: choiceCard("Якого клієнта взяти?", [
      "Андрій Коваль, 0501112233",
      "Андрій Коваль, 0632223344",
    ]),
    answer: { optionId: "opt-1" },
  },
  {
    phrase: "Петренко",
    action: "ui.pick",
    card: choiceCard("Знайшов двох клієнтів", [
      "Олена Петренко",
      "Олена Петрів",
    ]),
    answer: { optionId: "opt-1" },
  },
  {
    phrase: "120",
    action: "ui.pick",
    card: choiceCard("Яка ціна у товару Медовик?", ["120 грн", "150 грн"]),
    answer: null,
    hints: true,
  },
  {
    phrase: "дев'яносто п'ять гривень",
    action: "ui.pick",
    card: choiceCard("Скільки коштує Штрудель яблучний?", [
      "дев'яносто п'ять гривень",
      "сто гривень",
    ]),
    answer: { optionId: "opt-1" },
  },
  {
    phrase: "Корпоративні",
    action: "ui.pick",
    card: choiceCard("Як її назвати?", ["Роздрібні", "Корпоративні"]),
    answer: { optionId: "opt-2" },
  },
  {
    phrase: "Дмитро Остапчук 0667778899",
    action: "ui.refine",
    card: choiceCard("Кого записати?", [
      "Дмитро Остапчук 0667778899",
      "Дмитро Остапчук 0501110022",
    ]),
    answer: { optionId: "opt-1" },
  },
  {
    phrase: "0987654321",
    action: "ui.refine",
    card: choiceCard("Який у неї номер?", ["0987654321", "0501112233"]),
    answer: null,
    hints: true,
  },
  {
    phrase: "той що Гуменюк",
    action: "ui.pick",
    pickText: "Гуменюк",
    card: choiceCard("Є два клієнти", ["Степан Гуменюк", "Степан Гуменний"]),
    answer: null,
    hints: true,
  },
  {
    phrase: "другій",
    action: "ui.pick",
    card: choiceCard("Знайшов двох", ["Леся Приходько", "Леся Присяжнюк"]),
    answer: { optionId: "opt-2" },
  },
  {
    phrase: "для Зоряни Білик",
    action: "ui.pick",
    pickText: "Зоряни Білик",
    card: choiceCard("Для якого клієнта оформити?", [
      "Зоряна Білик",
      "Зоряна Біленко",
    ]),
    answer: { optionId: "opt-1" },
  },
];

const ABANDONED_QUESTION = "Ладно, потім з цим. Покажи нові замовлення";

describe("a Шо ui answer resolves against the open card", () => {
  it.each(SHO_740_ANSWERS)(
    "routes «$phrase» to the open card, not to the model",
    ({ phrase, action, pickText, card, answer, hints }) => {
      const match = routedToTheCard(
        commandOf({
          text: phrase,
          action,
          ...(pickText === undefined ? {} : { pickText }),
        }),
        card,
        phrase,
      );
      expect(match).not.toBeNull();
      if (hints === true) {
        expect(match?.kind).toBe("hint");
        return;
      }
      expect(match).toEqual({ kind: "answer", answer });
    },
  );

  it("leaves the abandoned-question trap to the server matcher", async () => {
    expect(
      await runShoCardAnswer({
        text: ABANDONED_QUESTION,
        sessionId: "session-1",
        now: NOW,
        history: [],
        pause: previewCard("card"),
        engine: engineReturning(
          {
            kind: "fallback",
            reason: "ui_answer",
            command: commandOf({
              text: ABANDONED_QUESTION,
              action: "ui.confirm",
            }),
          },
          () => undefined,
        ),
      }),
    ).toBeNull();
  });

  it("leaves a ui.refine to the server matcher: the parse merges it into the card's own command", () => {
    expect(
      shoCardAnswerFor(
        commandOf({ text: "0987654321", action: "ui.refine" }),
        choiceCard("Який у неї номер?", ["0987654321", "0501112233"]),
        "0987654321",
      ),
    ).toBeNull();
  });

  it("leaves a bare «так і скасуй» to the server matcher: a leftover is unread words", () => {
    expect(
      shoCardAnswerFor(
        commandOf({
          text: "так і скасуй",
          action: "ui.confirm",
          needs: [{ path: "text", reason: "unparsed", blocking: false }],
        }),
        previewCard("card"),
        "так і скасуй",
      ),
    ).toBeNull();
  });

  it("leaves a pick whose words the parse did not all read to the server matcher", () => {
    expect(
      shoCardAnswerFor(
        commandOf({
          text: "Так, Петренко",
          action: "ui.pick",
          needs: [{ path: "text", reason: "ignored", blocking: false }],
        }),
        choiceCard("Знайшов двох клієнтів", ["Олена Петренко", "Олена Петрів"]),
        "Так, Петренко",
      ),
    ).toBeNull();
  });

  it("confirms a preview card with the approval a typed «так» gives", () => {
    expect(
      shoCardAnswerFor(
        commandOf({ text: "ну давай роби", action: "ui.confirm" }),
        previewCard("card"),
        "ну давай роби",
      ),
    ).toEqual({ kind: "answer", answer: { approved: true } });
  });

  it("sends a strong preview back to its own button, as a typed «так» is", () => {
    const match = shoCardAnswerFor(
      commandOf({ text: "ну давай роби", action: "ui.confirm" }),
      previewCard("strong"),
      "ну давай роби",
    );
    expect(match?.kind).toBe("hint");
  });

  it("leaves a pick on a preview card to the server matcher", () => {
    expect(
      shoCardAnswerFor(
        commandOf({ text: "65 гривень", action: "ui.pick" }),
        previewCard("card"),
        "65 гривень",
      ),
    ).toBeNull();
  });

  it("leaves a confident command said while the card is open to the server matcher", () => {
    expect(
      shoCardAnswerFor(
        commandOf({
          text: "покажи нові замовлення",
          action: "orders.list",
          kind: "read",
          effect: "read",
        }),
        choiceCard("Знайшов двох", ["Олена Петренко", "Олена Петрів"]),
        "покажи нові замовлення",
      ),
    ).toBeNull();
  });

  it("leaves a pick that fits no option to the server matcher", () => {
    expect(
      shoCardAnswerFor(
        commandOf({ text: "Савченко", action: "ui.pick" }),
        choiceCard("Знайшов двох", ["Олена Петренко", "Олена Петрів"]),
        "Савченко",
      ),
    ).toBeNull();
  });
});

function pausedTurn(command: ShoCommand): readonly ModelMessage[] {
  return [
    { role: "user", content: "онови ціну" },
    {
      role: "assistant",
      providerOptions: shoLogOptions({
        command,
        sessionId: "session-1",
        at: "2026-10-03T07:59:00.000Z",
      }),
      content: [
        {
          type: "tool-call",
          toolCallId: "sho-1-catalog_updateProduct-c1",
          toolName: "catalog_updateProduct",
          input: {},
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "sho-1-catalog_updateProduct-c1",
          toolName: "catalog_updateProduct",
          output: { type: "json", value: { status: "paused" } },
        },
      ],
    },
  ];
}

function engineReturning(
  plan: ShoPlan,
  seen: (request: ShoTurnRequest) => void,
): ShoEngine {
  return {
    plan: (request) => {
      seen(request);
      return Promise.resolve(plan);
    },
  };
}

describe("the open card is the parse's previous command (D93)", () => {
  const opened = shoCommandSchema.parse({
    text: "онови ціну на лате",
    action: "catalog.updateProduct",
    kind: "write",
    effect: "write",
    confirm: "card",
    params: {},
    needs: [],
    ready: true,
    catalogued: true,
    confidence: { action: 0.99, margin: 0.8, certainty: 0.9, spans: 0.9 },
    refPrevious: {},
  });

  it("passes the open card's own command, which a write never is otherwise", async () => {
    const seen = vi.fn<(request: ShoTurnRequest) => void>();
    const match = await runShoCardAnswer({
      text: "65 гривень",
      sessionId: "session-1",
      now: NOW,
      history: pausedTurn(opened),
      pause: choiceCard("Яка ціна?", ["65 гривень", "70 гривень"]),
      engine: engineReturning(
        {
          kind: "fallback",
          reason: "ui_answer",
          command: commandOf({ text: "65 гривень", action: "ui.pick" }),
        },
        seen,
      ),
    });
    expect(match).toEqual({ kind: "answer", answer: { optionId: "opt-1" } });
    expect(seen.mock.calls[0]?.[0].previous).toEqual({
      command: opened,
      at: "2026-10-03T07:59:00.000Z",
    });
  });

  it("passes no previous when a later turn opened the card the person is answering", async () => {
    const seen = vi.fn<(request: ShoTurnRequest) => void>();
    const abandoned = [
      ...pausedTurn(opened),
      { role: "user" as const, content: "покажи клієнтів" },
      {
        role: "assistant" as const,
        content: [
          {
            type: "tool-call" as const,
            toolCallId: "toolu_llm",
            toolName: "customers_list_customers",
            input: {},
          },
        ],
      },
      {
        role: "tool" as const,
        content: [
          {
            type: "tool-result" as const,
            toolCallId: "toolu_llm",
            toolName: "customers_list_customers",
            output: { type: "json" as const, value: { status: "paused" } },
          },
        ],
      },
    ];
    await runShoCardAnswer({
      text: "Петренко",
      sessionId: "session-1",
      now: NOW,
      history: abandoned,
      pause: choiceCard("Знайшов двох", ["Олена Петренко", "Олена Петрів"]),
      engine: engineReturning({ kind: "fallback", reason: "ui_answer" }, seen),
    });
    expect(seen.mock.calls[0]?.[0].previous).toBeUndefined();
  });

  it("passes no previous when the latest Шо turn is not the open card", async () => {
    const seen = vi.fn<(request: ShoTurnRequest) => void>();
    const settled = pausedTurn(opened).map((message) =>
      message.role === "tool"
        ? {
            ...message,
            content: [
              {
                type: "tool-result" as const,
                toolCallId: "sho-1-catalog_updateProduct-c1",
                toolName: "catalog_updateProduct",
                output: { type: "json" as const, value: { productId: "p-1" } },
              },
            ],
          }
        : message,
    );
    await runShoCardAnswer({
      text: "65 гривень",
      sessionId: "session-1",
      now: NOW,
      history: settled,
      pause: choiceCard("Яка ціна?", ["65 гривень"]),
      engine: engineReturning({ kind: "fallback", reason: "ui_answer" }, seen),
    });
    expect(seen.mock.calls[0]?.[0].previous).toBeUndefined();
  });

  it("refuses an utterance longer than a bare card answer, whatever the parse kept of it", async () => {
    const match = await runShoCardAnswer({
      text: "Так, для Зоряни Білик",
      sessionId: "session-1",
      now: NOW,
      history: pausedTurn(opened),
      pause: previewCard("card"),
      engine: engineReturning(
        {
          kind: "fallback",
          reason: "ui_answer",
          command: commandOf({ text: "Так", action: "ui.confirm" }),
        },
        () => undefined,
      ),
    });
    expect(match).toBeNull();
  });

  it("answers nothing when the parse read no single command", async () => {
    const match = await runShoCardAnswer({
      text: "65 гривень",
      sessionId: "session-1",
      now: NOW,
      history: [],
      pause: choiceCard("Яка ціна?", ["65 гривень"]),
      engine: engineReturning(
        { kind: "fallback", reason: "many_commands" },
        () => undefined,
      ),
    });
    expect(match).toBeNull();
  });
});
