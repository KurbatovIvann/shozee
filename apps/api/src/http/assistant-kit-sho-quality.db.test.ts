import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { KYIV_NAMED_PERIODS } from "@showzy/ai";
import {
  planShoTurn,
  SHO_GATE_FAILURES,
  SHO_WHITELIST,
  type ShoPlan,
  type ShoResult,
} from "@showzy/assistant-runtime";
import { createTestKit, type TestKit } from "@showzy/core/testing";
import { devShoBakeryCompanyId, seedDevShoBakery } from "@showzy/db/seed";
import { products, productVariants } from "@showzy/db/schema/catalog";
import { companyCustomers, customerGroups } from "@showzy/db/schema/customers";
import { priceLists } from "@showzy/db/schema/pricing";
import { compileContext, loadSho, type Sho } from "@showzy/sho";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const RESEARCH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "docs",
  "research",
  "sho-734",
);

const CONFIDENCE_SWEEP = [0.9, 0.95, 0.98, 0.99];

const TICKET_WHITELIST: Readonly<Record<string, string>> = {
  "orders.list": "orders_list_page",
  "orders.get": "orders_get",
  "orders.create": "orders_create",
  "orders.confirm": "orders_confirm",
  "orders.start": "orders_start",
  "orders.complete": "orders_complete",
  "orders.cancel": "orders_cancel",
  "customers.getCustomer": "customers_get",
  "customers.listCustomers": "customers_list",
  "catalog.getProduct": "catalog_get_product",
  "catalog.listProducts": "catalog_list_products",
  "pricing.getPriceList": "pricing_get_price_list",
  "pricing.listPriceLists": "pricing_list_price_lists",
};

interface GoldCommand {
  readonly action: string;
  readonly params: Readonly<Record<string, unknown>>;
}

interface Selected {
  readonly id: string;
  readonly set: string;
  readonly row: string;
  readonly speaker: string;
  readonly trained: false | "unguarded";
  readonly labelled: boolean;
  readonly raw: string;
  readonly utterance: string;
  readonly asrError: boolean;
  readonly receivedAt: string | null;
  readonly commands: readonly GoldCommand[];
}

interface Scored {
  readonly row: Selected;
  readonly result: ShoResult;
  readonly plan: ShoPlan;
  readonly expectedAction: string | null;
  readonly predicted: string | null;
  readonly gated: boolean;
  readonly closed: boolean;
  readonly correct: boolean;
  readonly missClass: string | null;
}

function selection(): readonly Selected[] {
  return readFileSync(join(RESEARCH, "utterances.jsonl"), "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Selected);
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

function expectedActionOf(
  row: Selected,
  whitelist: Readonly<Record<string, string>>,
): string | null {
  const only = row.commands.length === 1 ? row.commands[0] : undefined;
  return only === undefined || whitelist[only.action] === undefined
    ? null
    : only.action;
}

function gatePassed(plan: ShoPlan): boolean {
  return plan.kind !== "fallback" || !SHO_GATE_FAILURES.includes(plan.reason);
}

function goldPeriod(row: Selected): string | null {
  const period = row.commands[0]?.params["period"];
  return typeof period === "string" ? period : null;
}

function refStatuses(result: ShoResult): readonly string[] {
  const command = result.commands[0];
  if (command === undefined) {
    return [];
  }
  return Object.values(command.params).flatMap((param) =>
    typeof param === "object" && param !== null && "status" in param
      ? [String(param.status)]
      : [],
  );
}

function firstNameOnly(row: Selected): boolean {
  const customer = row.commands[0]?.params["customer"];
  return (
    typeof customer === "string" && customer.trim().split(/\s+/).length === 1
  );
}

function classifyMiss(row: Selected, result: ShoResult, plan: ShoPlan): string {
  if (plan.kind !== "fallback") {
    return "wrong confident";
  }
  if (row.asrError) {
    return "asr error";
  }
  const period = goldPeriod(row);
  if (
    plan.reason === "unsupported_param" &&
    period !== null &&
    !KYIV_NAMED_PERIODS.includes(period)
  ) {
    return "period mapping";
  }
  if (plan.reason === "unresolved_reference") {
    const statuses = refStatuses(result);
    if (statuses.includes("ambiguous") || firstNameOnly(row)) {
      return "first-name-only customer";
    }
    return "entity not in catalogue";
  }
  if (plan.reason === "blocking_need") {
    return "needs missing";
  }
  if (plan.reason === "unsupported_param") {
    return "unsupported param";
  }
  if (plan.reason === "low_confidence") {
    return "model unsure";
  }
  return "model wrong";
}

function pct(part: number, whole: number): string {
  return whole === 0 ? "n/a" : `${((part / whole) * 100).toFixed(1)}%`;
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

function confidentAt(scored: Scored, floor: number): boolean {
  const action = scored.result.commands[0]?.confidence.action ?? 0;
  return scored.gated && action >= floor;
}

function block(title: string, rows: readonly Scored[]): string {
  const gated = rows.filter((scored) => scored.gated);
  const closed = rows.filter((scored) => scored.closed);
  const reads = closed.filter((scored) => scored.plan.kind === "read");
  const writes = closed.filter((scored) => scored.plan.kind === "write");
  const choices = closed.filter((scored) => scored.plan.kind === "choice");
  const correct = gated.filter((scored) => scored.correct);
  const wrong = gated.filter((scored) => !scored.correct);
  const coverable = rows.filter((scored) => scored.expectedAction !== null);
  const missed = coverable.filter((scored) => !scored.gated);
  const lines = [
    `### ${title} (${String(rows.length)} utterances)`,
    "",
    "| metric | value |",
    "|---|---|",
    `| gold inside this whitelist | ${String(coverable.length)} (${pct(coverable.length, rows.length)}) |`,
    `| passed the decision gate | ${String(gated.length)} (${pct(gated.length, rows.length)}) |`,
    `| closed without the LLM (gate + a param plan) | ${String(closed.length)} (${pct(closed.length, rows.length)}) |`,
    `| — answered (read) | ${String(reads.length)} |`,
    `| — paused for confirmation (write) | ${String(writes.length)} |`,
    `| — choice | ${String(choices.length)} |`,
    `| fallback to the LLM | ${String(rows.length - closed.length)} (${pct(rows.length - closed.length, rows.length)}) |`,
    `| action accuracy of gated decisions | ${String(correct.length)}/${String(gated.length)} = ${pct(correct.length, gated.length)} |`,
    `| wrong-confident | ${String(wrong.length)} |`,
    `| whitelisted gold the gate rejected | ${String(missed.length)} |`,
    "",
    "Action accuracy by confidence floor (`confidence.action`):",
    "",
    "| floor | gated | right | accuracy |",
    "|---|---|---|---|",
    ...CONFIDENCE_SWEEP.map((floor) => {
      const at = rows.filter((scored) => confidentAt(scored, floor));
      const right = at.filter((scored) => scored.correct);
      return `| ${floor.toFixed(2)} | ${String(at.length)} | ${String(right.length)} | ${pct(right.length, at.length)} |`;
    }),
    "",
    "Misses by class (whitelisted gold the gate rejected, plus wrong-confident):",
    "",
    "| class | rows |",
    "|---|---|",
    ...tally(
      [...missed, ...wrong].map((scored) => scored.missClass ?? "unclassified"),
    ).map(([name, count]) => `| ${name} | ${String(count)} |`),
    "",
    "Fallback reasons over every utterance:",
    "",
    "| reason | rows |",
    "|---|---|",
    ...tally(
      rows
        .filter((scored) => scored.plan.kind === "fallback")
        .map((scored) =>
          scored.plan.kind === "fallback" ? scored.plan.reason : "",
        ),
    ).map(([name, count]) => `| ${name} | ${String(count)} |`),
    "",
  ];
  return lines.join("\n");
}

function needReasons(rows: readonly Scored[]): string {
  const blocking = rows
    .filter((scored) => scored.expectedAction !== null)
    .flatMap((scored) =>
      (scored.result.commands[0]?.needs ?? [])
        .filter((need) => need.blocking)
        .map(
          (need) =>
            `${need.path.replaceAll(/\[\d+\]/g, "[i]")} — ${need.reason}`,
        ),
    );
  return [
    "### Blocking needs on spike-whitelisted gold",
    "",
    "| need | occurrences |",
    "|---|---|",
    ...tally(blocking).map(([name, count]) => `| ${name} | ${String(count)} |`),
    "",
  ].join("\n");
}

function wrongConfidentTable(rows: readonly Scored[]): string {
  const wrong = rows.filter((scored) => scored.gated && !scored.correct);
  return [
    "### Wrong-confident decisions (ticket whitelist)",
    "",
    "| row | said | gold | Шо decided |",
    "|---|---|---|---|",
    ...wrong.map((scored) => {
      const gold = scored.row.commands
        .map((command) => command.action)
        .join(" + ");
      const reason =
        scored.plan.kind === "fallback" ? scored.plan.reason : scored.plan.kind;
      return `| ${scored.row.id} | ${scored.row.raw.replaceAll("|", "/")} | ${gold === "" ? "none" : gold} | ${scored.predicted ?? "-"} (${reason}) |`;
    }),
    "",
  ].join("\n");
}

const RUN = process.env["SHO_734"] === "1";

describe.skipIf(!RUN)("Шо v3.3 on the seeded dev bakery", () => {
  let kit: TestKit;
  let sho: Sho;

  beforeAll(async () => {
    kit = await createTestKit();
    await seedDevShoBakery(kit.db.runtime.db);
    sho = await loadSho();
  }, 900_000);

  afterAll(async () => {
    await sho.dispose();
    await kit.db.close();
  });

  it("scores every selected utterance against gold", async () => {
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

    expect(productRows.length).toBeGreaterThan(0);
    expect(customerRows.length).toBeGreaterThan(0);

    const context = compileContext({
      version: 2,
      revision: `sho-734:${company}`,
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

    const rows = selection();

    const scoreAll = async (
      whitelist: Readonly<Record<string, string>>,
    ): Promise<Scored[]> => {
      const out: Scored[] = [];
      for (const row of rows) {
        const at =
          row.receivedAt === null ? new Date() : new Date(row.receivedAt);
        const result = await sho.run(
          { raw: row.raw },
          { context, now: kyivNow(at) },
        );
        const plan = planShoTurn(result, at, whitelist);
        const expectedAction = expectedActionOf(row, whitelist);
        const predicted = result.commands[0]?.action ?? null;
        const closed = plan.kind !== "fallback";
        const gated = gatePassed(plan);
        const correct = gated && predicted === expectedAction;
        out.push({
          row,
          result,
          plan,
          expectedAction,
          predicted,
          closed,
          gated,
          correct,
          missClass: correct ? null : classifyMiss(row, result, plan),
        });
      }
      return out;
    };

    const spike = await scoreAll(SHO_WHITELIST);
    const wide = await scoreAll(TICKET_WHITELIST);

    const labelledHeldOut = (scored: readonly Scored[]): readonly Scored[] =>
      scored.filter(
        (entry) => entry.row.trained === false && entry.row.labelled,
      );
    const unguarded = spike.filter((entry) => entry.row.trained !== false);
    const unlabelled = spike.filter((entry) => !entry.row.labelled);

    mkdirSync(RESEARCH, { recursive: true });
    writeFileSync(
      join(RESEARCH, "results.md"),
      [
        "# SHO-734 — Шо v3.3 on Shozee dev data",
        "",
        `Model ${sho.model.name} (${sho.model.md5.slice(0, 8)}); decision function`,
        "`planShoTurn` (`packages/assistant-runtime/src/sho-plan.ts`, SHO-733).",
        "Context compiled from the seeded dev company's own catalogue rows",
        "(no server path builds one yet — the SHO-733 spike compiles it in its",
        "test). Every utterance enters the runtime as `run({ raw })`, so the",
        "runtime normalises and finds punctuation breaks itself.",
        "",
        "Two whitelists are scored. The SHO-733 spike whitelist is",
        "`orders.list` + `orders.create`; the SHO-734 ticket whitelist adds",
        "orders get/confirm/start/complete/cancel, customer and product",
        "cards and lists, and price lists. Only the two spike actions have a",
        "param planner, so on the ticket whitelist the decision gate (single",
        "command, action whitelisted, confidence floor, no blocking need) is",
        "what is scored and the rest falls back with `no_param_plan`.",
        "",
        "## A. SHO-733 spike whitelist",
        "",
        block("A1. Never-trained gold", labelledHeldOut(spike)),
        block("A2. Not leak-guarded — report separately", unguarded),
        "## B. SHO-734 ticket whitelist",
        "",
        block("B1. Never-trained gold", labelledHeldOut(wide)),
        needReasons(labelledHeldOut(spike)),
        wrongConfidentTable(labelledHeldOut(wide)),
        `Unlabelled held-out rows (ambiguous, excluded above): ${String(unlabelled.length)}, ` +
          `of which Шо closed ${String(unlabelled.filter((entry) => entry.closed).length)}.`,
        "",
      ].join("\n"),
      "utf8",
    );

    writeFileSync(
      join(RESEARCH, "scored.jsonl"),
      `${spike
        .map((entry, index) =>
          JSON.stringify({
            id: entry.row.id,
            set: entry.row.set,
            trained: entry.row.trained,
            labelled: entry.row.labelled,
            raw: entry.row.raw,
            gold: entry.row.commands.map((command) => command.action),
            expectedAction: entry.expectedAction,
            plan: entry.plan,
            confidence: entry.result.commands[0]?.confidence ?? null,
            needs: entry.result.commands[0]?.needs ?? [],
            predicted: entry.result.commands.map((command) => command.action),
            closed: entry.closed,
            gated: entry.gated,
            correct: entry.correct,
            missClass: entry.missClass,
            wideGated: wide[index]?.gated ?? false,
            wideCorrect: wide[index]?.correct ?? false,
          }),
        )
        .join("\n")}\n`,
      "utf8",
    );

    expect(spike.length).toBe(rows.length);
  }, 3_600_000);
});
