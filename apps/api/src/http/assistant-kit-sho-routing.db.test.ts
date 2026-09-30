import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createTestKit, type TestKit } from "@showzy/core/testing";
import { devShoBakeryCompanyId, seedDevShoBakery } from "@showzy/db/seed";
import { products, productVariants } from "@showzy/db/schema/catalog";
import { companyCustomers, customerGroups } from "@showzy/db/schema/customers";
import { priceLists } from "@showzy/db/schema/pricing";
import {
  compileContext,
  loadSho,
  parseFocus,
  type CompiledContext,
  type FocusEntry,
  type ResultV2,
  type Sho,
} from "@showzy/sho";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  sho740IsWrite,
  sho740RouteC,
  sho740RouteD,
  sho740Shortlist,
  sho740ToolOf,
  SHO_740_FLOOR,
  type Sho740Gate,
  type Sho740Route,
  type Sho740Signal,
} from "./sho-740-arms.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHO_734 = join(
  HERE,
  "..",
  "..",
  "..",
  "..",
  "docs",
  "research",
  "sho-734",
);
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

const FLOORS = [0.9, 0.95, 0.98, 0.99];
const SHORTLIST_K = [3, 5, 8];

interface GoldCommand {
  readonly action: string;
  readonly params: Readonly<Record<string, unknown>>;
}

interface Selected {
  readonly id: string;
  readonly set: string;
  readonly trained: false | "unguarded";
  readonly labelled: boolean;
  readonly raw: string;
  readonly asrError: boolean;
  readonly receivedAt: string | null;
  readonly commands: readonly GoldCommand[];
}

interface RouterSingle {
  readonly id: string;
  readonly corpus: string;
  readonly message: string;
  readonly gate?: readonly string[];
  readonly tools?: readonly string[];
  readonly attack?: boolean;
  readonly trait?: string;
  readonly expected?: { readonly tool: string } | null;
  readonly alsoOk?: readonly { readonly tool: string }[];
}

interface FollowupCall {
  readonly tool: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly output: unknown;
}

interface RouterFollowup {
  readonly id: string;
  readonly corpus: string;
  readonly history: readonly {
    readonly user: string;
    readonly assistant: string;
    readonly call?: FollowupCall;
  }[];
  readonly message: string;
  readonly needsHistory: boolean;
  readonly expected: { readonly tool: string } | null;
}

function lines(path: string): readonly string[] {
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
}

function kyivNow(at: Date): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
} {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Kyiv",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const value = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
  };
}

function signalOf(result: ResultV2): Sho740Signal {
  const command = result.commands[0];
  return {
    tooMany: result.tooMany || result.commands.length > 1,
    action: command?.action ?? null,
    actionConfidence: command?.confidence.action ?? 0,
    marginConfidence: command?.confidence.margin ?? 0,
    spanConfidence: command?.confidence.spans ?? 0,
    blockingNeeds: (command?.needs ?? []).filter((need) => need.blocking)
      .length,
  };
}

function goldToolsOf(row: Selected): readonly string[] {
  return row.commands.flatMap((command) => {
    const tool = sho740ToolOf(command.action);
    return tool === null ? [] : [tool];
  });
}

function pct(part: number, whole: number): string {
  return whole === 0 ? "n/a" : `${((part / whole) * 100).toFixed(1)}%`;
}

function quantile(values: readonly number[], q: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(q * sorted.length) - 1),
  );
  return sorted[index] ?? 0;
}

function tally(
  values: readonly string[],
): readonly (readonly [string, number])[] {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts].sort((left, right) => right[1] - left[1]);
}

const FOCUS_TYPES: Readonly<Record<string, FocusEntry["type"]>> = {
  customers_list_customers: "customer",
  customers_createCustomer: "customer",
  customers_list_groups: "group",
  customers_createGroup: "group",
  catalog_list_products: "product",
  catalog_createProduct: "product",
  pricing_list_price_lists: "price_list",
  pricing_createPriceList: "price_list",
  orders_list_page: "order",
  orders_get: "order",
  orders_create: "order",
};

function recordsOf(output: unknown): readonly { id: string; name: string }[] {
  if (typeof output !== "object" || output === null) {
    return [];
  }
  const rows = (output as { rows?: unknown }).rows;
  if (!Array.isArray(rows)) {
    return [];
  }
  return rows.flatMap((row: unknown) => {
    if (typeof row !== "object" || row === null) {
      return [];
    }
    const record = row as { id?: unknown; name?: unknown; number?: unknown };
    const name =
      typeof record.name === "string"
        ? record.name
        : typeof record.number === "number"
          ? String(record.number)
          : null;
    if (name === null) {
      return [];
    }
    return [{ id: typeof record.id === "string" ? record.id : "", name }];
  });
}

function focusOf(row: RouterFollowup): readonly FocusEntry[] {
  const raw: unknown[] = [];
  const turnsBack = row.history.length;
  row.history.forEach((exchange, index) => {
    const call = exchange.call;
    if (call === undefined) {
      return;
    }
    const type = FOCUS_TYPES[call.tool];
    if (type === undefined) {
      return;
    }
    const created = call.tool.includes("create");
    const records = recordsOf(call.output);
    const named =
      records.length > 0
        ? records
        : created
          ? [
              {
                id: "",
                name:
                  typeof call.input["name"] === "string"
                    ? call.input["name"]
                    : "",
              },
            ]
          : [{ id: "", name: "" }];
    for (const record of named) {
      raw.unshift({
        type,
        id: record.id,
        name: record.name,
        how: created ? "created" : "shown",
        turns: turnsBack - index - 1,
        said: true,
      });
    }
  });
  return parseFocus(raw);
}

interface ArmRow {
  readonly id: string;
  readonly source: string;
  readonly message: string;
  readonly goldTools: readonly string[];
  readonly goldIsCommand: boolean;
  readonly action: string | null;
  readonly tool: string | null;
  readonly confidence: number;
  readonly blockingNeeds: number;
  readonly routeC: Sho740Route;
  readonly routeD: Sho740Route;
  readonly gate: Sho740Gate;
  readonly shortlist: Readonly<Record<string, boolean>>;
  readonly latencyMs: number;
}

function armBlock(title: string, rows: readonly ArmRow[]): string {
  const closedC = rows.filter((row) => row.routeC !== "llm");
  const closedD = rows.filter((row) => row.routeD !== "llm");
  const rightC = closedC.filter(
    (row) => row.tool !== null && row.goldTools.includes(row.tool),
  );
  const rightD = closedD.filter(
    (row) => row.tool !== null && row.goldTools.includes(row.tool),
  );
  const writesC = closedC.filter((row) => row.routeC === "sho_write_card");
  const wrongWritesC = writesC.filter(
    (row) => row.tool === null || !row.goldTools.includes(row.tool),
  );
  const writesD = closedD.filter((row) => row.routeD === "sho_write_card");
  const wrongWritesD = writesD.filter(
    (row) => row.tool === null || !row.goldTools.includes(row.tool),
  );
  const latency = rows.map((row) => row.latencyMs);
  return [
    `### ${title} (${String(rows.length)} messages)`,
    "",
    "| metric | arm C (Шо-first) | arm D (oracle gate + Шо) |",
    "|---|---|---|",
    `| closed without the LLM | ${String(closedC.length)} (${pct(closedC.length, rows.length)}) | ${String(closedD.length)} (${pct(closedD.length, rows.length)}) |`,
    `| — answered (read) | ${String(closedC.filter((row) => row.routeC === "sho_read").length)} | ${String(closedD.filter((row) => row.routeD === "sho_read").length)} |`,
    `| — confirmation card (write) | ${String(writesC.length)} | ${String(writesD.length)} |`,
    `| — clarification card | ${String(closedC.filter((row) => row.routeC === "sho_clarify_card").length)} | ${String(closedD.filter((row) => row.routeD === "sho_clarify_card").length)} |`,
    `| routing accuracy of what Шо closed | ${pct(rightC.length, closedC.length)} | ${pct(rightD.length, closedD.length)} |`,
    `| wrong writes | ${String(wrongWritesC.length)} (${pct(wrongWritesC.length, rows.length)} of turns) | ${String(wrongWritesD.length)} (${pct(wrongWritesD.length, rows.length)} of turns) |`,
    `| fell through to the LLM | ${pct(rows.length - closedC.length, rows.length)} | ${pct(rows.length - closedD.length, rows.length)} |`,
    "",
    `Шо latency on this set: p50 ${quantile(latency, 0.5).toFixed(1)} ms, p95 ${quantile(latency, 0.95).toFixed(1)} ms.`,
    "",
  ].join("\n");
}

function shortlistBlock(title: string, rows: readonly ArmRow[]): string {
  const answerable = rows.filter((row) => row.goldTools.length > 0);
  return [
    `### ${title}`,
    "",
    `Rows whose gold maps onto a showzy-v2 tool: ${String(answerable.length)} of ${String(rows.length)}.`,
    "",
    "| k | gold tool in Шо's top-k shortlist |",
    "|---|---|",
    ...SHORTLIST_K.map((k) => {
      const hit = answerable.filter((row) => row.shortlist[String(k)] === true);
      return `| ${String(k)} | ${String(hit.length)}/${String(answerable.length)} = ${pct(hit.length, answerable.length)} |`;
    }),
    "",
  ].join("\n");
}

function floorSweep(rows: readonly ArmRow[]): string {
  return [
    "| floor | closed by Шо | right | accuracy | wrong writes |",
    "|---|---|---|---|---|",
    ...FLOORS.map((floor) => {
      const closed = rows.filter(
        (row) =>
          sho740RouteC(
            {
              tooMany: false,
              action: row.action,
              actionConfidence: row.confidence,
              marginConfidence: 1,
              spanConfidence: 1,
              blockingNeeds: row.blockingNeeds,
            },
            floor,
          ) !== "llm" && row.routeC !== "llm",
      );
      const right = closed.filter(
        (row) => row.tool !== null && row.goldTools.includes(row.tool),
      );
      const wrongWrites = closed.filter(
        (row) =>
          row.action !== null &&
          sho740IsWrite(row.action) &&
          row.blockingNeeds === 0 &&
          (row.tool === null || !row.goldTools.includes(row.tool)),
      );
      return `| ${floor.toFixed(2)} | ${String(closed.length)} | ${String(right.length)} | ${pct(right.length, closed.length)} | ${String(wrongWrites.length)} |`;
    }),
    "",
  ].join("\n");
}

function wrongWriteTable(rows: readonly ArmRow[]): string {
  const wrong = rows.filter(
    (row) =>
      row.routeC === "sho_write_card" &&
      (row.tool === null || !row.goldTools.includes(row.tool)),
  );
  return [
    "| row | pass | said | gold | Шо would write | confidence |",
    "|---|---|---|---|---|---|",
    ...wrong.map(
      (row) =>
        `| ${row.id} | ${row.source} | ${row.message.replaceAll("|", "/")} | ${row.goldTools.length === 0 ? "none" : row.goldTools.join(" + ")} | ${row.tool ?? "-"} | ${row.confidence.toFixed(3)} |`,
    ),
    "",
  ].join("\n");
}

const RUN = process.env["SHO_740"] === "1";

describe.skipIf(!RUN)("SHO-740 routing arms, offline", () => {
  let kit: TestKit;
  let sho: Sho;
  let context: CompiledContext;

  beforeAll(async () => {
    kit = await createTestKit();
    await seedDevShoBakery(kit.db.runtime.db);
    sho = await loadSho();
    const db = kit.db.runtime.db;
    const company = devShoBakeryCompanyId;
    const [productRows, variantRows, customerRows, groupRows, listRows] =
      await Promise.all([
        db
          .select({ id: products.id, name: products.name })
          .from(products)
          .where(eq(products.companyId, company)),
        db
          .select({
            id: productVariants.id,
            name: productVariants.name,
            productId: productVariants.productId,
          })
          .from(productVariants)
          .where(eq(productVariants.companyId, company)),
        db
          .select({ id: companyCustomers.id, name: companyCustomers.name })
          .from(companyCustomers)
          .where(eq(companyCustomers.companyId, company)),
        db
          .select({ id: customerGroups.id, name: customerGroups.name })
          .from(customerGroups)
          .where(eq(customerGroups.companyId, company)),
        db
          .select({ id: priceLists.id, name: priceLists.name })
          .from(priceLists)
          .where(eq(priceLists.companyId, company)),
      ]);
    context = compileContext({
      version: 2,
      revision: `sho-740:${company}`,
      products: productRows.map((product) => ({
        id: product.id,
        name: product.name,
        variants: variantRows
          .filter((variant) => variant.productId === product.id)
          .map((variant) => ({ id: variant.id, name: variant.name })),
      })),
      customers: customerRows,
      groups: groupRows,
      priceLists: listRows,
    });
  }, 900_000);

  afterAll(async () => {
    await sho.dispose();
    await kit.db.close();
  });

  it("replays arms C and D over the gold set and the router corpora", async () => {
    const actions = sho.bundle.actions;
    const rows: ArmRow[] = [];

    const record = (input: {
      id: string;
      source: string;
      message: string;
      goldTools: readonly string[];
      goldIsCommand: boolean;
      gate: Sho740Gate;
      result: ResultV2;
      latencyMs: number;
    }): ArmRow => {
      const signal = signalOf(input.result);
      const probabilities = input.result.debug?.first.actionProbabilities ?? [];
      const shortlist: Record<string, boolean> = {};
      for (const k of SHORTLIST_K) {
        const tools = sho740Shortlist(probabilities, actions, k, signal.action);
        shortlist[String(k)] = input.goldTools.some((tool) =>
          tools.includes(tool),
        );
      }
      const row: ArmRow = {
        id: input.id,
        source: input.source,
        message: input.message,
        goldTools: input.goldTools,
        goldIsCommand: input.goldIsCommand,
        action: signal.action,
        tool: signal.action === null ? null : sho740ToolOf(signal.action),
        confidence: signal.actionConfidence,
        blockingNeeds: signal.blockingNeeds,
        routeC: sho740RouteC(signal),
        routeD: sho740RouteD(input.gate, signal),
        gate: input.gate,
        shortlist,
        latencyMs: input.latencyMs,
      };
      rows.push(row);
      return row;
    };

    const run = async (
      raw: string,
      at: Date,
      focus: readonly FocusEntry[] | null,
      previous: ResultV2["commands"][number] | null = null,
    ): Promise<{ result: ResultV2; latencyMs: number }> => {
      const started = performance.now();
      const result = await sho.run(
        { raw },
        {
          context,
          now: kyivNow(at),
          debug: true,
          ...(focus === null ? {} : { focus }),
          ...(previous === null
            ? {}
            : { previous: { command: previous, at: at.getTime() } }),
        },
      );
      return { result, latencyMs: performance.now() - started };
    };

    const gold = lines(join(SHO_734, "utterances.jsonl"))
      .map((line) => JSON.parse(line) as Selected)
      .filter(
      (row) => row.trained === false && row.labelled,
    );
    for (const row of gold) {
      const at =
        row.receivedAt === null ? new Date() : new Date(row.receivedAt);
      const { result, latencyMs } = await run(row.raw, at, null);
      const goldTools = goldToolsOf(row);
      record({
        id: row.id,
        source: "gold_554",
        message: row.raw,
        goldTools,
        goldIsCommand: row.commands.length > 0,
        gate:
          row.commands.length === 0
            ? "talk"
            : row.commands.length > 1
              ? "mixed"
              : goldTools.length === 0
                ? "unsupported"
                : "command",
        result,
        latencyMs,
      });
    }

    const singles = lines(join(SHO_740, "router-single.jsonl")).map(
      (line) => JSON.parse(line) as RouterSingle,
    );
    for (const single of singles) {
      const { result, latencyMs } = await run(single.message, new Date(), null);
      const expectedTool = single.expected?.tool ?? null;
      const listed = (single.tools ?? []).filter((tool) => tool !== "none");
      const goldTools = expectedTool === null ? listed : [expectedTool];
      const gate: Sho740Gate =
        goldTools.length > 1
          ? "mixed"
          : goldTools.length === 1
            ? "command"
            : (single.gate ?? []).includes("out_of_scope") ||
                single.trait === "unsupported" ||
                single.trait === "other_job"
              ? "unsupported"
              : "talk";
      record({
        id: single.id,
        source: `router_${single.corpus}`,
        message: single.message,
        goldTools,
        goldIsCommand: goldTools.length > 0,
        gate,
        result,
        latencyMs,
      });
    }

    const followups = lines(join(SHO_740, "router-followup.jsonl")).map(
      (line) => JSON.parse(line) as RouterFollowup,
    );
    const answerRows: ArmRow[] = [];
    const answerRowsWithPrevious: ArmRow[] = [];
    for (const followup of followups) {
      const focus = focusOf(followup);
      const at = new Date();
      const goldTool = followup.expected?.tool ?? null;
      const said = followup.history.at(-1);
      const previous =
        said === undefined
          ? null
          : ((await run(said.user, at, focus)).result.commands[0] ?? null);
      const bare = await run(followup.message, at, focus);
      const withPrevious = await run(followup.message, at, focus, previous);
      const asAnswer = said !== undefined && /\?\s*$/.test(said.assistant);
      for (const [suffix, pass] of [
        ["", bare],
        ["_prev", withPrevious],
      ] as const) {
        const row = record({
          id: followup.id,
          source: `router_followup${suffix}`,
          message: followup.message,
          goldTools: goldTool === null ? [] : [goldTool],
          goldIsCommand: goldTool !== null,
          gate: goldTool === null ? "talk" : "command",
          result: pass.result,
          latencyMs: pass.latencyMs,
        });
        if (asAnswer) {
          (suffix === "" ? answerRows : answerRowsWithPrevious).push(row);
        }
      }
    }

    const bySource = (prefix: string): readonly ArmRow[] =>
      rows.filter((row) => row.source.startsWith(prefix));

    const confidentOnAnswers = answerRows.filter((row) => row.routeC !== "llm");
    const confidentOnAnswersWithPrevious = answerRowsWithPrevious.filter(
      (row) => row.routeC !== "llm",
    );
    const answerTable = (
      title: string,
      closed: number,
      shown: readonly ArmRow[],
    ): readonly string[] => [
      `### ${title}: Шо closed ${String(closed)} of ${String(shown.length)}`,
      "",
      "| row | assistant asked | person answered | Шо route | action | confidence |",
      "|---|---|---|---|---|---|",
      ...shown.map((row) => {
        const followup = followups.find((entry) => entry.id === row.id);
        const asked = followup?.history.at(-1)?.assistant ?? "";
        return `| ${row.id} | ${asked.replaceAll("|", "/")} | ${row.message.replaceAll("|", "/")} | ${row.routeC} | ${row.action ?? "-"} | ${row.confidence.toFixed(3)} |`;
      }),
      "",
    ];

    mkdirSync(SHO_740, { recursive: true });
    writeFileSync(
      join(SHO_740, "offline.jsonl"),
      `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
      "utf8",
    );
    writeFileSync(
      join(SHO_740, "offline.md"),
      [
        "# SHO-740 — offline replay",
        "",
        `Model ${sho.model.name} (${sho.model.md5.slice(0, 8)}), runtime b1e2b4d (D88-D92).`,
        "Context: the seeded dev bakery. Gate floor for arms C and D:",
        `action ${SHO_740_FLOOR.action.toFixed(2)}, margin ${SHO_740_FLOOR.margin.toFixed(2)}, spans ${SHO_740_FLOOR.spans.toFixed(2)}.`,
        "Arm D's gate is the gold label (talk / command / mixed / unsupported):",
        "a ceiling for any classifier in front, Jev included.",
        "",
        armBlock(
          "Gold 554 (never-trained live + dictation)",
          bySource("gold_554"),
        ),
        armBlock(
          "Router single messages",
          bySource("router_probe").concat(
            bySource("router_calibration"),
            bySource("router_executor"),
          ),
        ),
        armBlock(
          "Router follow-ups, focus only (D88-D90)",
          rows.filter((row) => row.source === "router_followup"),
        ),
        armBlock(
          "Router follow-ups, focus + previous command (D78)",
          rows.filter((row) => row.source === "router_followup_prev"),
        ),
        "## Top-k tool shortlist (arm B's payload)",
        "",
        shortlistBlock("Gold 554", bySource("gold_554")),
        shortlistBlock(
          "Router single messages",
          bySource("router_probe").concat(
            bySource("router_calibration"),
            bySource("router_executor"),
          ),
        ),
        shortlistBlock(
          "Router follow-ups, focus only",
          rows.filter((row) => row.source === "router_followup"),
        ),
        shortlistBlock(
          "Router follow-ups, focus + previous",
          rows.filter((row) => row.source === "router_followup_prev"),
        ),
        "## Confidence floor sweep (arm C, gold 554)",
        "",
        floorSweep(bySource("gold_554")),
        "## Answers to the assistant's own question",
        "",
        `${String(answerRows.length)} follow-ups whose last assistant turn ends in a question and`,
        "whose message is the bare answer. The ticket's bar is zero confident",
        "commands unless the answer is itself a command.",
        "",
        ...answerTable("Focus only", confidentOnAnswers.length, answerRows),
        ...answerTable(
          "Focus + previous command",
          confidentOnAnswersWithPrevious.length,
          answerRowsWithPrevious,
        ),
        "## Wrong writes (arm C would open a confirmation card for the wrong write)",
        "",
        wrongWriteTable(rows),
        "## Шо action distribution on non-commands",
        "",
        "| Шо action | rows |",
        "|---|---|",
        ...tally(
          rows
            .filter((row) => !row.goldIsCommand)
            .map((row) => row.action ?? "-"),
        ).map(([name, count]) => `| ${name} | ${String(count)} |`),
        "",
      ].join("\n"),
      "utf8",
    );

    expect(rows.length).toBe(
      gold.length + singles.length + followups.length * 2,
    );
  }, 3_600_000);
});
