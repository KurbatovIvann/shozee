import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  filterStaffAiTools,
  staffAssistantSystemPrompt,
  staffAssistantTools,
  staffAssistantTurnContextAddendum,
  STAFF_ASSISTANT_TOOL_SEARCH_NAME,
  type ActionToolExecute,
} from "@showzy/ai";
import { loadServerConfig } from "@showzy/config";
import { contractModules } from "@showzy/contract";
import type { AnyActionContract } from "@showzy/core";
import { beforeAll, describe, expect, it } from "vitest";

import {
  sho740AnthropicTools,
  sho740Ask,
  type Sho740AnthropicTool,
  type Sho740Message,
  type Sho740ToolShape,
} from "./sho-740-anthropic.js";
import { Sho740Ledger, type Sho740Usage } from "./sho-740-spend.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHO_740 = join(
  HERE,
  "..",
  "..",
  "..",
  "..",
  "docs",
  "research",
  "sho-740",
);

const MODEL = "claude-haiku-4-5";
const CLAUDE_CAP_USD = 4;
const CALL_HEADROOM_USD = 0.05;

const MODE = process.env["SHO_740_LIVE"] ?? "";
const ESTIMATE = MODE === "estimate";
const LIVE = MODE === "1";

interface OfflineRow {
  readonly id: string;
  readonly source: string;
  readonly message: string;
  readonly goldTools: readonly string[];
  readonly goldIsCommand: boolean;
  readonly action: string | null;
  readonly tool: string | null;
  readonly confidence: number;
  readonly blockingNeeds: number;
  readonly routeC: string;
  readonly gate: string;
  readonly shortlist: Readonly<Record<string, boolean>>;
}

function lines(path: string): readonly string[] {
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
}

function offline(): readonly OfflineRow[] {
  return lines(join(SHO_740, "offline.jsonl")).map(
    (line) => JSON.parse(line) as OfflineRow,
  );
}

function everyNth<T>(rows: readonly T[], take: number): readonly T[] {
  if (rows.length <= take || take <= 0) {
    return rows;
  }
  const step = rows.length / take;
  const picked: T[] = [];
  for (let index = 0; index < take; index += 1) {
    const entry = rows[Math.floor(index * step)];
    if (entry !== undefined) {
      picked.push(entry);
    }
  }
  return picked;
}

const STRATA: readonly { readonly name: string; readonly take: number }[] = [
  { name: "read", take: 25 },
  { name: "write", take: 25 },
  { name: "clarify", take: 20 },
  { name: "talk", take: 15 },
  { name: "unsupported", take: 15 },
];

const WRITE_TOOL =
  /_(create|update|confirm|start|complete|cancel|archive|restore|delete|share|requestSign|activate|deactivate|setDefault|setPriceList|removePriceList)/;

function stratumOf(row: OfflineRow): string {
  if (row.gate === "unsupported") {
    return "unsupported";
  }
  if (!row.goldIsCommand) {
    return "talk";
  }
  if (row.routeC === "sho_clarify_card") {
    return "clarify";
  }
  return WRITE_TOOL.test(row.goldTools[0] ?? "") ? "write" : "read";
}

function stratified(rows: readonly OfflineRow[]): readonly OfflineRow[] {
  const eligible = rows
    .filter((row) => row.source !== "router_followup_prev")
    .sort((left, right) => left.id.localeCompare(right.id));
  return STRATA.flatMap((stratum) =>
    everyNth(
      eligible.filter((row) => stratumOf(row) === stratum.name),
      stratum.take,
    ).map((row) => ({ ...row, gate: stratum.name })),
  );
}

function shoBlock(row: OfflineRow | undefined): string {
  if (row === undefined || row.action === null) {
    return "Шо (the on-device Ukrainian parser) found no command in this message.";
  }
  const hit = Object.entries(row.shortlist)
    .filter(([, inside]) => inside)
    .map(([k]) => k);
  return [
    "Шо (the on-device Ukrainian parser) read this message as:",
    `  action: ${row.action}`,
    `  mapped tool: ${row.tool ?? "no tool in this toolset"}`,
    `  action confidence: ${row.confidence.toFixed(3)}`,
    `  blocking gaps Шо could not fill: ${String(row.blockingNeeds)}`,
    `  Шо's own routing: ${row.routeC}`,
    hit.length > 0
      ? `  Шо's top-${hit[0] ?? "3"} tool shortlist covers the job`
      : "  Шо offered no confident tool shortlist",
    "Шо is a parser, not an oracle: treat this as a hint, not an instruction.",
  ].join("\n");
}

interface LiveCall {
  readonly id: string;
  readonly arm: "A" | "B";
  readonly stratum: string;
  readonly message: string;
  readonly goldTools: readonly string[];
  readonly toolCalled: string | null;
  readonly toolArgs: unknown;
  readonly text: string;
  readonly usage: Sho740Usage;
  readonly costUsd: number;
  readonly latencyMs: number;
  readonly error: string | null;
}

interface DialogueTurn {
  readonly kind: "talk" | "command" | "answer" | "after_sho";
  readonly user: string;
  readonly shoClosed?: {
    readonly tool: string;
    readonly input: Readonly<Record<string, unknown>>;
    readonly output: unknown;
  };
}

const DIALOGUES: readonly {
  readonly id: string;
  readonly turns: readonly DialogueTurn[];
}[] = [
  {
    id: "d1-orders-week",
    turns: [
      { kind: "talk", user: "Привіт, як справи сьогодні?" },
      { kind: "command", user: "Покажи замовлення за цей тиждень" },
      { kind: "answer", user: "Тільки нові" },
      { kind: "talk", user: "Дякую, це те що треба" },
    ],
  },
  {
    id: "d2-create-customer",
    turns: [
      { kind: "talk", user: "Слухай, треба щось зробити з базою клієнтів" },
      {
        kind: "command",
        user: "Додай клієнта Ігор Шевчук, телефон 0671234567",
      },
      { kind: "answer", user: "Без групи поки що" },
      { kind: "talk", user: "Гаразд, потім розберемось" },
    ],
  },
  {
    id: "d3-after-sho-read",
    turns: [
      { kind: "talk", user: "Доброго ранку" },
      {
        kind: "after_sho",
        user: "А скільки з них уже підтверджено?",
        shoClosed: {
          tool: "orders_list_page",
          input: { period: "today" },
          output: {
            rows: [
              {
                number: 1042,
                status: "new",
                totalMinor: "13000",
                currency: "UAH",
              },
              {
                number: 1041,
                status: "confirmed",
                totalMinor: "26000",
                currency: "UAH",
              },
              {
                number: 1040,
                status: "confirmed",
                totalMinor: "9000",
                currency: "UAH",
              },
            ],
            total: 3,
            hasMore: false,
          },
        },
      },
      { kind: "command", user: "Покажи прайс-листи" },
      { kind: "talk", user: "Ок, зрозуміло" },
    ],
  },
  {
    id: "d4-price-question",
    turns: [
      { kind: "talk", user: "У нас скоро свята, треба підготуватись" },
      { kind: "command", user: "Покажи прайс-листи" },
      { kind: "answer", user: "Зимовий" },
      { kind: "talk", user: "Добре, дякую" },
    ],
  },
  {
    id: "d5-order-create",
    turns: [
      { kind: "talk", user: "Телефонувала Катя Самбука" },
      { kind: "command", user: "Оформи їй два торти шоколадні великі" },
      { kind: "answer", user: "Підтверджую" },
      { kind: "talk", user: "Все, закриваємо" },
    ],
  },
];

function shoHistory(
  turn: DialogueTurn,
  index: number,
): readonly Sho740Message[] {
  const closed = turn.shoClosed;
  if (closed === undefined) {
    return [];
  }
  const id = `sho-${String(index)}-${closed.tool}`;
  return [
    {
      role: "assistant",
      content: [
        { type: "tool_use", id, name: closed.tool, input: closed.input },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: id,
          content: JSON.stringify(closed.output),
        },
      ],
    },
  ];
}

interface DialogueRow {
  readonly dialogue: string;
  readonly arm: "A" | "B" | "C";
  readonly turn: number;
  readonly kind: string;
  readonly user: string;
  readonly toolCalled: string | null;
  readonly text: string;
  readonly referredToShoResult: boolean | null;
  readonly usage: Sho740Usage;
  readonly costUsd: number;
  readonly latencyMs: number;
  readonly error: string | null;
}

function contracts(): readonly AnyActionContract[] {
  const modules: readonly Readonly<Record<string, AnyActionContract>>[] =
    Object.values(contractModules);
  return modules.flatMap((module) => Object.values(module));
}

function quantile(values: readonly number[], q: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  return (
    sorted[
      Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))
    ] ?? 0
  );
}

const NO_USAGE: Sho740Usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheWriteTokens: 0,
  cacheReadTokens: 0,
};

function note(line: string): void {
  mkdirSync(SHO_740, { recursive: true });
  appendFileSync(join(SHO_740, "live-spend.log"), `${line}\n`, "utf8");
}

describe.skipIf(!ESTIMATE && !LIVE)("SHO-740 Haiku routing, live", () => {
  let anthropicTools: readonly Sho740AnthropicTool[];
  let system: readonly Record<string, unknown>[];
  let apiKey: string;

  beforeAll(() => {
    const config = loadServerConfig();
    const key = config.ai.anthropicApiKey;
    if (key === undefined || key === "") {
      throw new Error("ANTHROPIC_API_KEY is absent; nothing was sent.");
    }
    apiKey = key;
    const execute: ActionToolExecute = () =>
      Promise.reject(new Error("SHO-740 never executes a tool"));
    const toolSet: Readonly<Record<string, Sho740ToolShape>> =
      staffAssistantTools(
        filterStaffAiTools(contracts(), { role: "owner", permissions: [] }),
        execute,
      );
    anthropicTools = sho740AnthropicTools(toolSet, [
      STAFF_ASSISTANT_TOOL_SEARCH_NAME,
    ]);
    system = [
      {
        type: "text",
        text: staffAssistantSystemPrompt,
        cache_control: { type: "ephemeral" },
      },
      {
        type: "text",
        text: staffAssistantTurnContextAddendum({
          now: new Date("2026-09-30T09:00:00.000Z"),
          companyName: "Шо-пекарня",
        }),
      },
    ];
  });

  it("rescores the recorded live calls without spending anything", () => {
    const path = join(SHO_740, "live-calls.jsonl");
    if (!existsSync(path)) {
      return;
    }
    const calls = lines(path).map((line) => JSON.parse(line) as LiveCall);
    const moduleOf = (tool: string | null): string =>
      tool === null ? "-" : (tool.split("_")[0] ?? tool);
    const score = (
      arm: "A" | "B",
      predicate: (row: LiveCall) => boolean,
      over: (row: LiveCall) => boolean = () => true,
    ): string => {
      const rows = calls.filter((row) => row.arm === arm && over(row));
      const hit = rows.filter(predicate).length;
      return rows.length === 0
        ? "n/a"
        : `${String(hit)}/${String(rows.length)} = ${((hit / rows.length) * 100).toFixed(1)}%`;
    };
    const commanded = (row: LiveCall): boolean => row.goldTools.length > 0;
    const exact = (row: LiveCall): boolean =>
      row.toolCalled !== null && row.goldTools.includes(row.toolCalled);
    const sameModule = (row: LiveCall): boolean =>
      row.toolCalled !== null &&
      row.goldTools.some((tool) => moduleOf(tool) === moduleOf(row.toolCalled));
    const wrongWrite = (row: LiveCall): boolean =>
      row.toolCalled !== null &&
      WRITE_TOOL.test(row.toolCalled) &&
      !row.goldTools.includes(row.toolCalled);
    writeFileSync(
      join(SHO_740, "live-scored.md"),
      [
        "# SHO-740 — live calls rescored",
        "",
        "Only the first assistant step was taken, so a legitimate lookup before",
        "a write (`catalog_list_products` before `catalog_createVariant`) scores",
        "as a miss under exact match. The looser columns bound that effect.",
        "",
        "| metric | arm A | arm B |",
        "|---|---|---|",
        `| first tool is the gold tool (commands only) | ${score("A", exact, commanded)} | ${score("B", exact, commanded)} |`,
        `| first tool is in the gold module | ${score("A", sameModule, commanded)} | ${score("B", sameModule, commanded)} |`,
        `| called nothing when nothing was asked for | ${score(
          "A",
          (row) => row.toolCalled === null,
          (row) => !commanded(row),
        )} | ${score(
          "B",
          (row) => row.toolCalled === null,
          (row) => !commanded(row),
        )} |`,
        `| wrong write as the first call | ${score("A", wrongWrite)} | ${score("B", wrongWrite)} |`,
        `| answered in text with no tool (commands only) | ${score("A", (row) => row.toolCalled === null, commanded)} | ${score("B", (row) => row.toolCalled === null, commanded)} |`,
        "",
        "| stratum | A exact | B exact | A module | B module | A wrong write | B wrong write |",
        "|---|---|---|---|---|---|---|",
        ...STRATA.map((stratum) => {
          const inStratum = (row: LiveCall): boolean =>
            row.stratum === stratum.name;
          const both = (row: LiveCall): boolean =>
            inStratum(row) && commanded(row);
          return `| ${stratum.name} | ${score("A", exact, both)} | ${score("B", exact, both)} | ${score("A", sameModule, both)} | ${score("B", sameModule, both)} | ${score("A", wrongWrite, inStratum)} | ${score("B", wrongWrite, inStratum)} |`;
        }),
        "",
      ].join("\n"),
      "utf8",
    );
    expect(calls.length).toBeGreaterThan(0);
  });

  it("reports the prompt and tool surface it would send", () => {
    const toolChars = JSON.stringify(anthropicTools).length;
    const systemChars = JSON.stringify(system).length;
    note(
      `[surface] tools=${String(anthropicTools.length)} toolChars=${String(toolChars)} systemChars=${String(systemChars)}`,
    );
    expect(anthropicTools.length).toBeGreaterThan(5);
  });

  it.skipIf(!LIVE)(
    "arm A vs arm B on a stratified subset, and A/B/C dialogues",
    async () => {
      const ledger = new Sho740Ledger(
        "claude",
        CLAUDE_CAP_USD,
        CALL_HEADROOM_USD,
      );
      note(
        `[run] ${new Date().toISOString()} model=${MODEL} cap=$${String(CLAUDE_CAP_USD)}`,
      );

      const ask = async (
        messages: readonly Sho740Message[],
      ): Promise<{
        toolCalled: string | null;
        toolArgs: unknown;
        text: string;
        usage: Sho740Usage;
        costUsd: number;
        latencyMs: number;
        error: string | null;
      }> => {
        ledger.require();
        const reply = await sho740Ask({
          apiKey,
          model: MODEL,
          system,
          tools: anthropicTools,
          messages,
        });
        const costUsd = ledger.charge(reply.usage);
        return {
          toolCalled: reply.toolCalled,
          toolArgs: reply.toolArgs,
          text: reply.text,
          usage: reply.usage,
          costUsd,
          latencyMs: reply.latencyMs,
          error: reply.error,
        };
      };

      const limit = Number(process.env["SHO_740_LIVE_LIMIT"] ?? "0");
      const all = stratified(offline());
      const subset = limit > 0 ? all.slice(0, limit) : all;
      note(
        `[subset] ${String(subset.length)} phrases of ${String(all.length)}`,
      );

      const calls: LiveCall[] = [];
      for (const row of subset) {
        if (!ledger.canAfford()) {
          note(`[stop] budget reached before ${row.id}`);
          break;
        }
        for (const arm of ["A", "B"] as const) {
          const messages: readonly Sho740Message[] =
            arm === "A"
              ? [{ role: "user", content: row.message }]
              : [
                  {
                    role: "user",
                    content: `${shoBlock(row)}\n\n---\n\n${row.message}`,
                  },
                ];
          const answer = await ask(messages);
          calls.push({
            id: row.id,
            arm,
            stratum: row.gate,
            message: row.message,
            goldTools: row.goldTools,
            ...answer,
          });
        }
        if (calls.length % 40 === 0) {
          note(
            `[spend] ${String(calls.length)} calls, $${ledger.spentUsd.toFixed(4)}`,
          );
        }
      }
      note(
        `[stratified done] ${String(calls.length)} calls, $${ledger.spentUsd.toFixed(4)}`,
      );

      const hints = new Map(offline().map((row) => [row.message, row]));
      const dialogueRows: DialogueRow[] = [];
      for (const dialogue of limit > 0 ? DIALOGUES.slice(0, 1) : DIALOGUES) {
        for (const arm of ["A", "B", "C"] as const) {
          if (!ledger.canAfford()) {
            note(`[stop] budget reached before ${dialogue.id} arm ${arm}`);
            break;
          }
          const history: Sho740Message[] = [];
          for (const [index, turn] of dialogue.turns.entries()) {
            if (!ledger.canAfford()) {
              break;
            }
            history.push(...shoHistory(turn, index));
            const hint = hints.get(turn.user);
            const shoCloses =
              arm === "C" &&
              hint !== undefined &&
              hint.routeC !== "llm" &&
              turn.kind !== "talk";
            if (shoCloses) {
              dialogueRows.push({
                dialogue: dialogue.id,
                arm,
                turn: index,
                kind: turn.kind,
                user: turn.user,
                toolCalled: hint.tool,
                text: "",
                referredToShoResult: null,
                usage: NO_USAGE,
                costUsd: 0,
                latencyMs: 0,
                error: null,
              });
              history.push({ role: "user", content: turn.user });
              history.push({
                role: "assistant",
                content: `[Шо closed this turn: ${hint.tool ?? "unknown"}]`,
              });
              continue;
            }
            const content =
              arm === "A"
                ? turn.user
                : `${shoBlock(hint)}\n\n---\n\n${turn.user}`;
            const answer = await ask([...history, { role: "user", content }]);
            history.push({ role: "user", content: turn.user });
            history.push({
              role: "assistant",
              content:
                answer.text === ""
                  ? `[called ${answer.toolCalled ?? "nothing"}]`
                  : answer.text,
            });
            dialogueRows.push({
              dialogue: dialogue.id,
              arm,
              turn: index,
              kind: turn.kind,
              user: turn.user,
              toolCalled: answer.toolCalled,
              text: answer.text,
              referredToShoResult:
                turn.kind === "after_sho"
                  ? /104[012]|дв[аі]|two|підтвердж/i.test(answer.text)
                  : null,
              usage: answer.usage,
              costUsd: answer.costUsd,
              latencyMs: answer.latencyMs,
              error: answer.error,
            });
          }
        }
      }
      note(
        `[dialogues done] total $${ledger.spentUsd.toFixed(4)} over ${String(ledger.callCount)} calls`,
      );

      writeFileSync(
        join(SHO_740, "live-calls.jsonl"),
        `${calls.map((row) => JSON.stringify(row)).join("\n")}\n`,
        "utf8",
      );
      writeFileSync(
        join(SHO_740, "live-dialogues.jsonl"),
        `${dialogueRows.map((row) => JSON.stringify(row)).join("\n")}\n`,
        "utf8",
      );

      const armRows = (arm: "A" | "B"): readonly LiveCall[] =>
        calls.filter((row) => row.arm === arm);
      const right = (rows: readonly LiveCall[]): number =>
        rows.filter((row) =>
          row.goldTools.length === 0
            ? row.toolCalled === null
            : row.toolCalled !== null && row.goldTools.includes(row.toolCalled),
        ).length;
      const summary = (arm: "A" | "B"): string => {
        const rows = armRows(arm);
        const count = Math.max(1, rows.length);
        const cost = rows.reduce((sum, row) => sum + row.costUsd, 0);
        const input = rows.reduce(
          (sum, row) =>
            sum +
            row.usage.inputTokens +
            row.usage.cacheReadTokens +
            row.usage.cacheWriteTokens,
          0,
        );
        const output = rows.reduce(
          (sum, row) => sum + row.usage.outputTokens,
          0,
        );
        const latency = rows.map((row) => row.latencyMs);
        return `| ${arm} | ${String(rows.length)} | ${String(right(rows))} | ${rows.length === 0 ? "n/a" : `${((right(rows) / rows.length) * 100).toFixed(1)}%`} | ${(input / count).toFixed(0)} | ${(output / count).toFixed(0)} | $${(cost / count).toFixed(5)} | ${quantile(latency, 0.5).toFixed(0)} / ${quantile(latency, 0.95).toFixed(0)} |`;
      };
      const perStratum = (arm: "A" | "B", stratum: string): string => {
        const rows = armRows(arm).filter((row) => row.stratum === stratum);
        return rows.length === 0
          ? "n/a"
          : `${((right(rows) / rows.length) * 100).toFixed(1)}% (${String(rows.length)})`;
      };

      const totals = ledger.totals;
      const afterSho = dialogueRows.filter((row) => row.kind === "after_sho");
      writeFileSync(
        join(SHO_740, "live.md"),
        [
          "# SHO-740 — live Haiku 4.5",
          "",
          `Model \`${MODEL}\`, called directly on \`/v1/messages\` so the usage`,
          "numbers are the provider's own. Tools: the real staff toolset built",
          "from `contractModules` through `staffAssistantTools`; system: the real",
          "`staffAssistantSystemPrompt` plus the turn-context addendum, with one",
          "1.25x cache breakpoint on the system prefix and one on the last tool.",
          "Nothing is executed: the reply's first `tool_use` is the routing answer.",
          "",
          `Tools sent: ${String(anthropicTools.length)}.`,
          "",
          "## Arm A (LLM only) vs arm B (LLM + Шо's parse and shortlist)",
          "",
          "| arm | calls | right tool | accuracy | input tok/turn | output tok/turn | $/turn | latency p50/p95 ms |",
          "|---|---|---|---|---|---|---|---|",
          summary("A"),
          summary("B"),
          "",
          "| stratum | arm A | arm B |",
          "|---|---|---|",
          ...STRATA.map(
            (stratum) =>
              `| ${stratum.name} | ${perStratum("A", stratum.name)} | ${perStratum("B", stratum.name)} |`,
          ),
          "",
          "## Dialogues (4 turns: talk, command, answer to the assistant, talk)",
          "",
          "| arm | turns | turns that cost an LLM call | $/dialogue | p50/p95 ms |",
          "|---|---|---|---|---|",
          ...(["A", "B", "C"] as const).map((arm) => {
            const rows = dialogueRows.filter((row) => row.arm === arm);
            const billed = rows.filter((row) => row.costUsd > 0);
            const dialogues = Math.max(
              1,
              new Set(rows.map((row) => row.dialogue)).size,
            );
            const cost = rows.reduce((sum, row) => sum + row.costUsd, 0);
            return `| ${arm} | ${String(rows.length)} | ${String(billed.length)} | $${(cost / dialogues).toFixed(5)} | ${quantile(
              billed.map((row) => row.latencyMs),
              0.5,
            ).toFixed(0)} / ${quantile(
              billed.map((row) => row.latencyMs),
              0.95,
            ).toFixed(0)} |`;
          }),
          "",
          "### The turn after a Шо-closed turn (synthetic `sho-` tool_use / tool_result)",
          "",
          "| arm | provider accepted the foreign tool_use | used the Шо result | reply |",
          "|---|---|---|---|",
          ...afterSho.map(
            (row) =>
              `| ${row.arm} | ${row.error === null ? "yes" : `no: ${row.error.slice(0, 90)}`} | ${row.referredToShoResult === true ? "yes" : "no"} | ${(row.text === "" ? (row.toolCalled ?? "-") : row.text).replaceAll("|", "/").slice(0, 140)} |`,
          ),
          "",
          "## Spend",
          "",
          `Calls: ${String(ledger.callCount)}. Input ${String(totals.inputTokens)}, output ${String(totals.outputTokens)},`,
          `cache write ${String(totals.cacheWriteTokens)}, cache read ${String(totals.cacheReadTokens)}.`,
          "",
          `**Claude spend: $${ledger.spentUsd.toFixed(4)} of a $${CLAUDE_CAP_USD.toFixed(2)} cap.**`,
          "",
        ].join("\n"),
        "utf8",
      );

      note(`[final] $${ledger.spentUsd.toFixed(4)}`);
      expect(ledger.spentUsd).toBeLessThanOrEqual(CLAUDE_CAP_USD);
      expect(calls.length).toBeGreaterThan(0);
    },
    3_600_000,
  );
});
