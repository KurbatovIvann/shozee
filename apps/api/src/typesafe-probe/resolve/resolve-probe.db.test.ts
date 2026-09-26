import { writeFileSync } from "node:fs";

import {
  JUDGMENT_PICKER_THRESHOLD,
  STAFF_JUDGMENT_SPECS,
  answerPickerFromMessage,
  buildStaffPlanQuestions,
  catalogPickerConflictExtrasFromError,
  createTypeSafeJudgmentProvider,
  decideStaffPlan,
  type CatalogPickerConflictExtras,
  type JudgmentProvider,
} from "@showzy/ai";
import { createProduct, resolveLineReferences } from "@showzy/catalog";
import { loadServerConfig } from "@showzy/config";
import { CoreError } from "@showzy/core/errors";
import { createTestKit, type TestKit } from "@showzy/core/testing";
import { createCustomer, resolveCustomerReference } from "@showzy/customers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { seedCustomerNames, seedProductNames } from "../base/world.js";
import { num } from "../probe.js";
import {
  RESOLVE_CASES,
  RESOLVE_NONE,
  RESOLVE_PICKER,
  VARIABLE_PRODUCTS,
  type ResolveCase,
} from "./corpus.js";

const LIVE = process.env["TYPESAFE_LIVE_PROBE"] === "1";
const OUT = process.env["TYPESAFE_PROBE_OUT"];
const THRESHOLD_PAIRS = [
  "0.85/0.7",
  "0.8/0.7",
  "0.75/0.7",
  "0.75/0.3",
  "0.7/0.7",
] as const;
const PATHS = ["module alone", "judgment answers the picker"];
const ROUNDS_MAX = 4;

let kit: TestKit;

const unthrottled = () => ({
  deps: {
    ...kit.pipeline,
    hooks: {
      ...kit.pipeline.hooks,
      rateLimit: { enforce: () => Promise.resolve() },
    },
  },
});

type Ref =
  | { readonly by: "query"; readonly value: string }
  | { readonly by: "id"; readonly id: string };

type Resolution =
  | { readonly kind: "resolved"; readonly names: readonly (string | null)[] }
  | { readonly kind: "picker"; readonly extras: CatalogPickerConflictExtras }
  | { readonly kind: "none" }
  | { readonly kind: "error"; readonly code: string };

interface PickRecord {
  readonly caseId: string;
  readonly about: string;
  readonly options: number;
  readonly choice: string;
}

function failure(error: unknown): Resolution {
  const extras = catalogPickerConflictExtrasFromError(error);
  if (extras !== undefined) {
    return { kind: "picker", extras };
  }
  if (error instanceof CoreError) {
    return error.code === "NOT_FOUND"
      ? { kind: "none" }
      : { kind: "error", code: error.code };
  }
  throw error;
}

async function resolveCustomer(ref: Ref): Promise<Resolution> {
  try {
    const found = await kit.invoke(
      resolveCustomerReference,
      ref,
      {},
      unthrottled(),
    );
    return { kind: "resolved", names: [found.name] };
  } catch (error) {
    return failure(error);
  }
}

async function resolveLine(product: Ref, variant?: Ref): Promise<Resolution> {
  try {
    const found = await kit.invoke(
      resolveLineReferences,
      {
        lines: [
          {
            product,
            variantSelection:
              variant === undefined
                ? { kind: "unspecified" }
                : { kind: "reference", ref: variant },
          },
        ],
      },
      {},
      unthrottled(),
    );
    const line = found.lines[0];
    return {
      kind: "resolved",
      names: [line?.productName ?? null, line?.variantName ?? null],
    };
  } catch (error) {
    return failure(error);
  }
}

async function pickOption(
  provider: JudgmentProvider,
  probeCase: ResolveCase,
  extras: CatalogPickerConflictExtras,
  lineText: string | undefined,
  picks: PickRecord[],
): Promise<string | undefined> {
  const chosen = await answerPickerFromMessage({
    provider,
    message: probeCase.message,
    picker: extras,
    ...(lineText === undefined ? {} : { line: lineText }),
  });
  picks.push({
    caseId: probeCase.id,
    about:
      "query" in extras.target
        ? extras.target.query
        : extras.target.productName,
    options: extras.options.length,
    choice:
      extras.options.find((option) => option.id === chosen)?.label ??
      "left to the person",
  });
  return chosen;
}

async function settle(
  start: () => Promise<Resolution>,
  retry: (
    extras: CatalogPickerConflictExtras,
    id: string,
  ) => Promise<Resolution>,
  answer:
    | ((extras: CatalogPickerConflictExtras) => Promise<string | undefined>)
    | undefined,
): Promise<Resolution> {
  let current = await start();
  for (let round = 0; round < ROUNDS_MAX; round += 1) {
    if (current.kind !== "picker" || answer === undefined) {
      return current;
    }
    const id = await answer(current.extras);
    if (id === undefined) {
      return current;
    }
    current = await retry(current.extras, id);
  }
  return current;
}

type Verdict = "correct" | "wrong" | "left to the person" | "not found";

function verdictOf(
  expected: readonly (string | null)[],
  resolution: Resolution,
): Verdict {
  const wantsPicker = expected.includes(RESOLVE_PICKER);
  const wantsNone = expected.includes(RESOLVE_NONE);
  if (resolution.kind === "picker") {
    return wantsPicker ? "correct" : "left to the person";
  }
  if (resolution.kind === "none" || resolution.kind === "error") {
    return wantsNone ? "correct" : "not found";
  }
  return !wantsPicker &&
    !wantsNone &&
    expected.every((name, index) => name === (resolution.names[index] ?? null))
    ? "correct"
    : "wrong";
}

interface ReferenceRow {
  readonly caseId: string;
  readonly trait: string;
  readonly what: string;
  readonly said: string;
  readonly verdicts: readonly Verdict[];
}

const decideAt = (
  message: string,
  answers: Parameters<typeof decideStaffPlan>[0]["answers"],
  pair: string,
) =>
  decideStaffPlan({
    message,
    answers,
    specs: STAFF_JUDGMENT_SPECS.map((spec) =>
      spec.tool === "orders_create"
        ? {
            ...spec,
            thresholds: {
              act: Number(pair.split("/")[0]),
              argument: Number(pair.split("/")[1]),
            },
          }
        : spec,
    ),
    isWrite: () => false,
  });

beforeAll(async () => {
  kit = await createTestKit();
  const seeding = unthrottled();
  let phone = 670000000;
  for (const name of seedCustomerNames()) {
    phone += 1;
    await kit.invoke(
      createCustomer,
      { name, phone: `0${String(phone)}` },
      {},
      seeding,
    );
  }
  for (const name of seedProductNames()) {
    await kit.invoke(
      createProduct,
      { name, basePriceMinor: "6500", currency: "UAH", variants: [] },
      {},
      seeding,
    );
  }
  for (const [name, variants] of Object.entries(VARIABLE_PRODUCTS)) {
    await kit.invoke(
      createProduct,
      {
        name,
        basePriceMinor: "9000",
        currency: "UAH",
        variants: variants.map((variant) => ({ name: variant })),
      },
      {},
      seeding,
    );
  }
});

afterAll(async () => {
  await kit.db.close();
});

describe("typesafe resolve probe world", () => {
  it("names only records the seed holds", () => {
    const customers = new Set([
      ...seedCustomerNames(),
      RESOLVE_PICKER,
      RESOLVE_NONE,
    ]);
    const products = new Set([
      ...seedProductNames(),
      ...Object.keys(VARIABLE_PRODUCTS),
      RESOLVE_NONE,
    ]);
    expect(
      RESOLVE_CASES.filter((entry) => !customers.has(entry.customer)).map(
        (entry) => entry.id,
      ),
    ).toEqual([]);
    expect(
      RESOLVE_CASES.flatMap((entry) =>
        entry.lines
          .filter(
            (line) =>
              !products.has(line.product) ||
              (line.variant !== undefined &&
                line.variant !== RESOLVE_PICKER &&
                VARIABLE_PRODUCTS[line.product]?.includes(line.variant) !==
                  true),
          )
          .map(() => entry.id),
      ),
    ).toEqual([]);
  });

  it("opens a variant picker for a product sold only in variants", async () => {
    const found = await resolveLine({ by: "query", value: "Макаронси" });
    expect(found.kind === "picker" && found.extras.reason).toBe(
      "variant_required",
    );
  });
});

describe.runIf(LIVE)("typesafe resolve probe, live", () => {
  it("resolves what the planner took from the message", async () => {
    const { ai } = loadServerConfig();
    if (ai.typesafeApiKey === undefined) {
      throw new Error("TYPESAFE_API_KEY is required for the live probe");
    }
    const provider = createTypeSafeJudgmentProvider({
      apiKey: ai.typesafeApiKey,
      model: ai.typesafeModel,
    });
    const rows: ReferenceRow[] = [];
    const picks: PickRecord[] = [];
    const notPlanned: string[] = [];
    const takenAt = new Map<string, readonly string[]>();

    for (const probeCase of RESOLVE_CASES) {
      const asked = await provider.ask({
        state: { message: probeCase.message },
        questions: buildStaffPlanQuestions(
          probeCase.message,
          STAFF_JUDGMENT_SPECS,
        ),
      });
      if (!asked.ok) {
        notPlanned.push(`| ${probeCase.id} | ${asked.reason} | | | | |`);
        continue;
      }
      const plan = decideAt(probeCase.message, asked.answers, "0.85/0.7");
      takenAt.set(
        probeCase.id,
        THRESHOLD_PAIRS.filter(
          (argument) =>
            decideAt(probeCase.message, asked.answers, argument)
              .declinedBecause === undefined,
        ),
      );
      const input = plan.call?.input;
      const items = Array.isArray(input?.["items"])
        ? (input["items"] as Record<string, string>[])
        : [];
      if (plan.declinedBecause !== undefined) {
        notPlanned.push(
          `| ${probeCase.id} | ${plan.declinedBecause} | ${plan.kind ?? ""} ${num(plan.kindConfidence ?? 0)} | ${plan.call?.tool ?? ""} | ${num(plan.call?.minConfidence ?? 0)} | ${JSON.stringify(plan.call?.args ?? {})} |`,
        );
      }
      if (
        plan.call?.tool !== "orders_create" ||
        items.length !== probeCase.lines.length
      ) {
        continue;
      }
      const customerQuery = input?.["customerQuery"];
      const customerSaid =
        typeof customerQuery === "string" ? customerQuery : "";
      const customerVerdicts: Verdict[] = [];
      for (const path of PATHS) {
        const resolution = await settle(
          () => resolveCustomer({ by: "query", value: customerSaid }),
          (_, id) => resolveCustomer({ by: "id", id }),
          path === PATHS[0]
            ? undefined
            : (extras) =>
                pickOption(provider, probeCase, extras, undefined, picks),
        );
        customerVerdicts.push(verdictOf([probeCase.customer], resolution));
      }
      rows.push({
        caseId: probeCase.id,
        trait: probeCase.trait,
        what: "customer",
        said: customerSaid,
        verdicts: customerVerdicts,
      });

      for (const [index, expected] of probeCase.lines.entries()) {
        const said = items[index]?.["productQuery"] ?? "";
        const lineText = `${expected.quantity} × ${said}`;
        const verdicts: Verdict[] = [];
        for (const path of PATHS) {
          let product: Ref = { by: "query", value: said };
          let variant: Ref | undefined;
          const run = () => resolveLine(product, variant);
          const resolution = await settle(
            run,
            (extras, id) => {
              if ("query" in extras.target) {
                product = { by: "id", id };
              } else {
                variant = { by: "id", id };
              }
              return run();
            },
            path === PATHS[0]
              ? undefined
              : (extras) =>
                  pickOption(provider, probeCase, extras, lineText, picks),
          );
          verdicts.push(
            verdictOf([expected.product, expected.variant ?? null], resolution),
          );
        }
        rows.push({
          caseId: probeCase.id,
          trait: probeCase.trait,
          what: `line ${String(index + 1)}`,
          said,
          verdicts,
        });
      }
    }

    const verdictNames: Verdict[] = [
      "correct",
      "wrong",
      "left to the person",
      "not found",
    ];
    const count = (path: number, verdict: Verdict, trait?: string): number =>
      rows.filter(
        (row) =>
          row.verdicts[path] === verdict &&
          (trait === undefined || row.trait === trait),
      ).length;
    const traits = [...new Set(rows.map((row) => row.trait))];
    const orderOutcome = (caseId: string, path: number): Verdict => {
      const verdicts = rows
        .filter((row) => row.caseId === caseId)
        .map((row) => row.verdicts[path]);
      return (
        verdictNames
          .toSorted(
            (left, right) =>
              ["wrong", "not found", "left to the person", "correct"].indexOf(
                left,
              ) -
              ["wrong", "not found", "left to the person", "correct"].indexOf(
                right,
              ),
          )
          .find((verdict) => verdicts.includes(verdict)) ?? "not found"
      );
    };
    const orderLines = THRESHOLD_PAIRS.flatMap((argument) =>
      PATHS.map((path, index) => {
        const taken = [...takenAt.entries()]
          .filter(([, thresholds]) => thresholds.includes(argument))
          .map(([caseId]) => caseId)
          .filter((caseId) => rows.some((row) => row.caseId === caseId));
        return `| ${argument} | ${path} | ${String(taken.length)} | ${verdictNames.map((verdict) => String(taken.filter((caseId) => orderOutcome(caseId, index) === verdict).length)).join(" | ")} |`;
      }),
    );
    const report = [
      "## Resolve probe",
      "",
      `${String(RESOLVE_CASES.length)} order messages, ${String(rows.length)} references from the ${String(RESOLVE_CASES.length - notPlanned.length)} the planner took. The judgment acts on a pick at confidence ${num(JUDGMENT_PICKER_THRESHOLD)} or more.`,
      "",
      "| Path | Correct | Wrong | Left to the person | Not found |",
      "| --- | --- | --- | --- | --- |",
      ...PATHS.map(
        (path, index) =>
          `| ${path} | ${verdictNames.map((verdict) => String(count(index, verdict))).join(" | ")} |`,
      ),
      "",
      "### Whole orders the planner would take, by its thresholds",
      "",
      "| Act / argument threshold | Path | Taken | Right | Wrong | An unneeded picker | To the reply model |",
      "| --- | --- | --- | --- | --- | --- | --- |",
      ...orderLines,
      "",
      "### By trait (correct / wrong / left to the person / not found)",
      "",
      `| Trait | ${PATHS.join(" | ")} |`,
      `| --- | ${PATHS.map(() => "---").join(" | ")} |`,
      ...traits.map(
        (trait) =>
          `| ${trait} | ${PATHS.map((_, index) => verdictNames.map((verdict) => String(count(index, verdict, trait))).join(" / ")).join(" | ")} |`,
      ),
      "",
      "### References that did not end correct on every path",
      "",
      `| Case | What | Said | ${PATHS.join(" | ")} |`,
      `| --- | --- | --- | ${PATHS.map(() => "---").join(" | ")} |`,
      ...rows
        .filter((row) => row.verdicts.some((verdict) => verdict !== "correct"))
        .map(
          (row) =>
            `| ${row.caseId} | ${row.what} | ${row.said} | ${row.verdicts.join(" | ")} |`,
        ),
      "",
      "### Picks",
      "",
      "| Case | About | Options | Choice |",
      "| --- | --- | --- | --- |",
      ...picks.map(
        (pick) =>
          `| ${pick.caseId} | ${pick.about} | ${String(pick.options)} | ${pick.choice} |`,
      ),
      "",
      "### Messages the planner did not take",
      "",
      "| Case | Why | Kind | Tool | Lowest confidence | Arguments |",
      "| --- | --- | --- | --- | --- | --- |",
      ...notPlanned,
      "",
    ].join("\n");
    if (OUT !== undefined) {
      writeFileSync(OUT, report);
      writeFileSync(`${OUT}.json`, JSON.stringify({ rows, picks }, null, 2));
    }
    expect(rows.length).toBeGreaterThan(0);
  }, 900_000);
});
