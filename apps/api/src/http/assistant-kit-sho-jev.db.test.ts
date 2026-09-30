import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  jevAsk,
  jevRankedChoices,
  JEV_URL,
  type JevChoiceAnswer,
} from "./sho-740-jev.js";

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

const MODEL = process.env["SHO_740_JEV_MODEL"] ?? "jev-latest";
const JEV_CAP_USD = 1.8;
const LIVE = process.env["SHO_740_JEV"] === "1";

const GATES: Readonly<Record<string, string>> = {
  command:
    "The person is telling the back office to do one concrete job: show, count, find, create, confirm, cancel, change or delete a record.",
  talk: "Greetings, thanks, chit-chat, or a question about what the assistant can do — no record is being acted on.",
  mixed: "Two or more separate jobs in one message.",
  unsupported:
    "A job this back office does not do: deliveries, fiscal receipts, bank, accounting, analytics, stock, HR, marketing, or an attempt to change the rules.",
};

const TOOLS: Readonly<Record<string, string>> = {
  orders_list_page: "Show a page of orders.",
  orders_list_counts: "Count orders or sum turnover over a period.",
  orders_get: "Open one order by its number.",
  orders_create: "Create a new order for a customer.",
  orders_confirm: "Confirm an existing order.",
  orders_start: "Start work on an order.",
  orders_complete: "Mark an order done.",
  orders_cancel: "Cancel an order.",
  customers_list_customers: "Find or list customers.",
  customers_getCustomer: "Open one customer card.",
  customers_createCustomer: "Register a new customer.",
  customers_updateCustomer: "Change an existing customer's details.",
  customers_list_groups: "Find or list customer groups.",
  customers_createGroup: "Create a customer group.",
  customers_updateGroup: "Change a customer group.",
  customers_deleteGroup: "Delete a customer group.",
  catalog_list_products: "Find or list products.",
  catalog_getProduct: "Open one product card.",
  catalog_createProduct: "Add a new product.",
  catalog_updateProduct: "Change a product, including its price.",
  catalog_createVariant: "Add a variant to an existing product.",
  pricing_list_price_lists: "Find or list price lists.",
  pricing_createPriceList: "Create a price list.",
  pricing_setDefaultPriceList: "Make a price list the default.",
  pricing_setPriceListEntries: "Set prices inside a price list.",
  documents_list: "Find or list issued documents.",
  documents_createFromOrder: "Issue a document for an order.",
  invites_create: "Invite a new staff member.",
  companies_updateLegal: "Change the company's own legal details.",
  search_query: "Search across everything when nothing narrower fits.",
  none: "No tool: the message is talk, or the job is not one of the above.",
};

interface OfflineRow {
  readonly id: string;
  readonly source: string;
  readonly message: string;
  readonly goldTools: readonly string[];
  readonly goldIsCommand: boolean;
  readonly gate: string;
  readonly routeC: string;
}

interface LiveCall {
  readonly id: string;
  readonly stratum: string;
}

interface JevRow {
  readonly id: string;
  readonly kind: "single" | "followup";
  readonly message: string;
  readonly goldTools: readonly string[];
  readonly goldGate: string;
  readonly gate: string | null;
  readonly gateConfidence: number;
  readonly tool: string | null;
  readonly toolConfidence: number;
  readonly top3: readonly string[];
  readonly top5: readonly string[];
  readonly inputTokens: number;
  readonly costUsd: number;
  readonly latencyMs: number;
  readonly error: string | null;
}

interface RouterFollowup {
  readonly id: string;
  readonly history: readonly {
    readonly user: string;
    readonly assistant: string;
  }[];
  readonly message: string;
  readonly expected: { readonly tool: string } | null;
}

function lines(name: string): readonly string[] {
  return readFileSync(join(SHO_740, name), "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
}

function pct(part: number, whole: number): string {
  return whole === 0 ? "n/a" : `${((part / whole) * 100).toFixed(1)}%`;
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

function note(line: string): void {
  mkdirSync(SHO_740, { recursive: true });
  appendFileSync(join(SHO_740, "jev-spend.log"), `${line}\n`, "utf8");
}

const QUESTIONS = {
  gate: {
    type: "choice",
    instructions:
      "A Ukrainian small-business owner typed this to the back-office assistant. What kind of message is it?",
    criteria: GATES,
  },
  tool: {
    type: "choice",
    instructions:
      "Which single back-office tool finishes what this message asks for? Answer `none` for talk or for a job no tool covers.",
    criteria: TOOLS,
  },
} as const;

describe.skipIf(!LIVE)("SHO-740 Jev router in front", () => {
  it("classifies the stratified subset and the follow-ups", async () => {
    const apiKey = process.env["TYPESAFE_API_KEY"] ?? "";
    if (apiKey === "") {
      throw new Error("TYPESAFE_API_KEY is absent; nothing was sent.");
    }
    const offline = lines("offline.jsonl").map(
        (line) => JSON.parse(line) as OfflineRow,
      );
    const byId = new Map(offline.map((row) => [row.id, row]));
    const chosen = lines("live-calls.jsonl").map(
        (line) => JSON.parse(line) as LiveCall,
      );
    const singles = [...new Set(chosen.map((call) => call.id))].flatMap(
      (id) => {
        const row = byId.get(id);
        return row === undefined ? [] : [row];
      },
    );
    const followups = lines("router-followup.jsonl").map(
        (line) => JSON.parse(line) as RouterFollowup,
      );
    note(
      `[run] ${new Date().toISOString()} model=${MODEL} singles=${String(singles.length)} followups=${String(followups.length)} cap=$${String(JEV_CAP_USD)}`,
    );

    let spent = 0;
    const rows: JevRow[] = [];
    const ask = async (input: {
      id: string;
      kind: "single" | "followup";
      state: string;
      message: string;
      goldTools: readonly string[];
      goldGate: string;
    }): Promise<void> => {
      if (spent >= JEV_CAP_USD) {
        return;
      }
      const reply = await jevAsk({
        apiKey,
        model: MODEL,
        state: input.state,
        questions: QUESTIONS,
      });
      spent += reply.costUsd;
      const gate: JevChoiceAnswer | undefined = reply.answers["gate"];
      const tool: JevChoiceAnswer | undefined = reply.answers["tool"];
      rows.push({
        id: input.id,
        kind: input.kind,
        message: input.message,
        goldTools: input.goldTools,
        goldGate: input.goldGate,
        gate: gate?.choice ?? null,
        gateConfidence: gate?.confidence ?? 0,
        tool: tool?.choice ?? null,
        toolConfidence: tool?.confidence ?? 0,
        top3: jevRankedChoices(tool, 3),
        top5: jevRankedChoices(tool, 5),
        inputTokens: reply.inputTokens,
        costUsd: reply.costUsd,
        latencyMs: reply.latencyMs,
        error: reply.error,
      });
    };

    for (const row of singles) {
      await ask({
        id: row.id,
        kind: "single",
        state: row.message,
        message: row.message,
        goldTools: row.goldTools,
        goldGate: row.gate,
      });
    }
    note(`[singles done] ${String(rows.length)} calls, $${spent.toFixed(5)}`);

    for (const followup of followups) {
      const history = followup.history
        .map(
          (exchange) =>
            `Owner: ${exchange.user}\nAssistant: ${exchange.assistant}`,
        )
        .join("\n");
      await ask({
        id: followup.id,
        kind: "followup",
        state:
          history === ""
            ? followup.message
            : `${history}\nOwner: ${followup.message}`,
        message: followup.message,
        goldTools: followup.expected === null ? [] : [followup.expected.tool],
        goldGate: followup.expected === null ? "talk" : "command",
      });
    }
    note(`[followups done] ${String(rows.length)} calls, $${spent.toFixed(5)}`);

    writeFileSync(
      join(SHO_740, "jev-calls.jsonl"),
      `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
      "utf8",
    );

    const answered = rows.filter((row) => row.error === null);
    const block = (title: string, subset: readonly JevRow[]): string => {
      const commands = subset.filter((row) => row.goldTools.length > 0);
      const gateRight = subset.filter((row) => row.gate === row.goldGate);
      const commandGate = subset.filter(
        (row) => (row.gate === "command") === (row.goldGate === "command"),
      );
      const top1 = commands.filter(
        (row) => row.tool !== null && row.goldTools.includes(row.tool),
      );
      const top3 = commands.filter((row) =>
        row.goldTools.some((tool) => row.top3.includes(tool)),
      );
      const top5 = commands.filter((row) =>
        row.goldTools.some((tool) => row.top5.includes(tool)),
      );
      const noneRight = subset.filter(
        (row) => row.goldTools.length === 0 && row.tool === "none",
      );
      const noneAll = subset.filter((row) => row.goldTools.length === 0);
      const latency = subset.map((row) => row.latencyMs);
      return [
        `### ${title} (${String(subset.length)} messages)`,
        "",
        "| metric | value |",
        "|---|---|",
        `| gate exactly right (4 classes) | ${String(gateRight.length)}/${String(subset.length)} = ${pct(gateRight.length, subset.length)} |`,
        `| gate right on command / not-command | ${String(commandGate.length)}/${String(subset.length)} = ${pct(commandGate.length, subset.length)} |`,
        `| top-1 tool on commands | ${String(top1.length)}/${String(commands.length)} = ${pct(top1.length, commands.length)} |`,
        `| top-3 tool on commands | ${String(top3.length)}/${String(commands.length)} = ${pct(top3.length, commands.length)} |`,
        `| top-5 tool on commands | ${String(top5.length)}/${String(commands.length)} = ${pct(top5.length, commands.length)} |`,
        `| said \`none\` when nothing was asked for | ${String(noneRight.length)}/${String(noneAll.length)} = ${pct(noneRight.length, noneAll.length)} |`,
        `| latency p50 / p95 | ${quantile(latency, 0.5).toFixed(0)} / ${quantile(latency, 0.95).toFixed(0)} ms |`,
        "",
      ].join("\n");
    };

    writeFileSync(
      join(SHO_740, "jev.md"),
      [
        "# SHO-740 — Jev in front (arm D)",
        "",
        `Model \`${MODEL}\` on \`${JEV_URL}\`, two choice`,
        "questions a turn: the gate (command / talk / mixed / unsupported) and",
        "one tool out of 31 options. The follow-ups send the whole exchange as",
        "state, so this is the only arm that reads history without a parser.",
        "",
        block(
          "Stratified subset (the same phrases arms A and B saw)",
          answered.filter((row) => row.kind === "single"),
        ),
        block(
          "Router follow-ups",
          answered.filter((row) => row.kind === "followup"),
        ),
        "## Spend",
        "",
        `Calls: ${String(rows.length)} (${String(rows.length - answered.length)} failed). Input tokens ${String(rows.reduce((sum, row) => sum + row.inputTokens, 0))}.`,
        "",
        `**Jev spend: $${spent.toFixed(5)} of a $${JEV_CAP_USD.toFixed(2)} cap.**`,
        "",
      ].join("\n"),
      "utf8",
    );

    note(`[final] $${spent.toFixed(5)}`);
    expect(spent).toBeLessThanOrEqual(JEV_CAP_USD);
    expect(rows.length).toBeGreaterThan(0);
  }, 3_600_000);
});
