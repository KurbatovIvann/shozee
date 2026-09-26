import { writeFileSync } from "node:fs";

import {
  createTypeSafeJudgmentProvider,
  type JudgmentProvider,
  type JudgmentText,
} from "@showzy/ai";
import { createProduct, listProducts } from "@showzy/catalog";
import { loadServerConfig } from "@showzy/config";
import { createTestKit, type TestKit } from "@showzy/core/testing";
import {
  createCustomer,
  createGroup,
  listCustomers,
  listGroups,
} from "@showzy/customers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { mean, num, pct, share } from "../probe.js";
import {
  BASE_AMBIGUOUS,
  BASE_MENTIONS,
  BASE_NONE,
  SEED_GROUP_NAMES,
  seedCustomerNames,
  seedProductNames,
  type BaseKind,
  type BaseMention,
} from "./world.js";

const LIVE = process.env["TYPESAFE_LIVE_PROBE"] === "1";
const OUT = process.env["TYPESAFE_PROBE_OUT"];
const RETRIEVAL_LIMIT = 50;
const WHOLE_LIST_CHUNK = 150;

let kit: TestKit;
const allNames: Record<BaseKind, readonly string[]> = {
  customer: seedCustomerNames(),
  product: seedProductNames(),
  "customer group": SEED_GROUP_NAMES,
};

async function retrieve(mention: BaseMention): Promise<readonly string[]> {
  if (mention.kind === "customer") {
    const page = await kit.invoke(listCustomers, {
      search: mention.mention,
      limit: RETRIEVAL_LIMIT,
    });
    return page.items.map((row) => row.name);
  }
  if (mention.kind === "product") {
    const page = await kit.invoke(listProducts, {
      query: mention.mention,
      limit: RETRIEVAL_LIMIT,
    });
    return page.items.map((row) => row.name);
  }
  const page = await kit.invoke(listGroups, {
    search: mention.mention,
    limit: RETRIEVAL_LIMIT,
  });
  return page.items.map((row) => row.name);
}

interface BaseRow {
  readonly mention: BaseMention;
  readonly retrieved: readonly string[];
  readonly viaRetrieval: Pick;
  readonly viaFullList: Pick;
  readonly combined: Pick;
}

interface Pick {
  readonly choice: string;
  readonly confidence: number;
}

async function pickRecord(
  provider: JudgmentProvider,
  mention: BaseMention,
  candidates: readonly string[],
): Promise<Pick> {
  const criteria: Record<string, JudgmentText | null> = {};
  for (const candidate of candidates) {
    criteria[candidate] = null;
  }
  criteria[BASE_AMBIGUOUS] =
    "Two or more of the records fit the mention equally well.";
  criteria[BASE_NONE] = "No record fits the mention.";
  const result = await provider.ask({
    state: { mention: mention.mention },
    questions: {
      pick: {
        type: "choice",
        instructions: `\`mention\` is how a staff member referred to a ${mention.kind} in a Ukrainian message; it may be inflected, shortened, misspelled or transliterated. Which stored record is it? Choose \`${BASE_AMBIGUOUS}\` when two or more records fit equally well. Choose \`${BASE_NONE}\` when no record fits.`,
        criteria,
      },
    },
  });
  return result.ok
    ? {
        choice: result.answers.pick.choice,
        confidence: result.answers.pick.confidence,
      }
    : { choice: `refused: ${result.reason}`, confidence: 0 };
}

async function pickFromWholeList(
  provider: JudgmentProvider,
  mention: BaseMention,
  names: readonly string[],
): Promise<Pick> {
  if (names.length <= WHOLE_LIST_CHUNK) {
    return pickRecord(provider, mention, names);
  }
  const winners: Pick[] = [];
  for (let start = 0; start < names.length; start += WHOLE_LIST_CHUNK) {
    winners.push(
      await pickRecord(
        provider,
        mention,
        names.slice(start, start + WHOLE_LIST_CHUNK),
      ),
    );
  }
  const flagged = winners.find((w) => w.choice === BASE_AMBIGUOUS);
  if (flagged !== undefined) {
    return flagged;
  }
  const records = winners.filter((w) => w.choice !== BASE_NONE);
  if (records.length <= 1) {
    return (
      records[0] ?? {
        choice: BASE_NONE,
        confidence: Math.min(...winners.map((w) => w.confidence)),
      }
    );
  }
  const final = await pickRecord(
    provider,
    mention,
    records.map((w) => w.choice),
  );
  return {
    choice: final.choice,
    confidence: Math.min(final.confidence, ...records.map((w) => w.confidence)),
  };
}

beforeAll(async () => {
  kit = await createTestKit();
  const seeding = {
    deps: {
      ...kit.pipeline,
      hooks: {
        ...kit.pipeline.hooks,
        rateLimit: { enforce: () => Promise.resolve() },
      },
    },
  };
  for (const name of SEED_GROUP_NAMES) {
    await kit.invoke(createGroup, { name }, {}, seeding);
  }
  let phone = 670000000;
  for (const name of allNames.customer) {
    phone += 1;
    await kit.invoke(
      createCustomer,
      { name, phone: `0${String(phone)}` },
      {},
      seeding,
    );
  }
  for (const name of allNames.product) {
    await kit.invoke(
      createProduct,
      { name, basePriceMinor: "6500", currency: "UAH", variants: [] },
      {},
      seeding,
    );
  }
});

afterAll(async () => {
  await kit.db.close();
});

describe("typesafe base probe world", () => {
  it("seeds a base large enough to make candidate lists realistic", () => {
    expect(allNames.customer.length).toBe(300);
    expect(allNames.product.length).toBeGreaterThanOrEqual(130);
    expect(new Set(BASE_MENTIONS.map((x) => x.id + x.kind)).size).toBe(
      BASE_MENTIONS.length,
    );
    const known = new Set([
      BASE_AMBIGUOUS,
      BASE_NONE,
      ...allNames.customer,
      ...allNames.product,
      ...allNames["customer group"],
    ]);
    expect(
      BASE_MENTIONS.flatMap((x) => x.expected).filter((e) => !known.has(e)),
    ).toEqual([]);
  });

  it("finds a record by its exact stored name through the module's own search", async () => {
    const found = await retrieve({
      id: "exact",
      kind: "customer",
      mention: "Наталія Гук",
      expected: ["Наталія Гук"],
    });
    expect(found).toContain("Наталія Гук");
  });
});

describe.runIf(LIVE)("typesafe base probe, live", () => {
  it("resolves mentions through real retrieval and over the whole list", async () => {
    const { ai } = loadServerConfig();
    if (ai.typesafeApiKey === undefined) {
      throw new Error("TYPESAFE_API_KEY is required for the live base probe");
    }
    const provider = createTypeSafeJudgmentProvider({
      apiKey: ai.typesafeApiKey,
      model: ai.typesafeModel,
      deadlineMs: 20_000,
      attemptTimeoutMs: 15_000,
    });

    const rows: BaseRow[] = [];
    for (const mention of BASE_MENTIONS) {
      const retrieved = await retrieve(mention);
      const viaRetrieval: Pick =
        retrieved.length === 0
          ? { choice: BASE_NONE, confidence: 1 }
          : await pickRecord(provider, mention, retrieved);
      const viaFullList = await pickFromWholeList(
        provider,
        mention,
        allNames[mention.kind],
      );
      rows.push({
        mention,
        retrieved,
        viaRetrieval,
        viaFullList,
        combined: retrieved.length === 0 ? viaFullList : viaRetrieval,
      });
    }

    const needsRecord = (x: BaseMention) =>
      !x.expected.includes(BASE_NONE) && !x.expected.includes(BASE_AMBIGUOUS);
    const line = (label: string, subset: readonly BaseRow[]) => {
      const targets = subset.filter((r) => needsRecord(r.mention));
      return `| ${label} | ${String(subset.length)} | ${pct(share(targets.map((r) => r.mention.expected.some((e) => r.retrieved.includes(e)))))} | ${num(mean(subset.map((r) => r.retrieved.length)), 1)} | ${pct(share(subset.map((r) => r.mention.expected.includes(r.viaRetrieval.choice))))} | ${pct(share(subset.map((r) => r.mention.expected.includes(r.viaFullList.choice))))} | ${pct(share(subset.map((r) => r.mention.expected.includes(r.combined.choice))))} | ${String(subset.filter((r) => !r.mention.expected.includes(r.combined.choice) && r.combined.choice !== BASE_NONE && r.combined.choice !== BASE_AMBIGUOUS).length)} |`;
    };
    const kinds: readonly BaseKind[] = [
      "customer",
      "product",
      "customer group",
    ];
    const confident = (
      key: "viaRetrieval" | "viaFullList" | "combined",
      threshold: number,
    ) => {
      const kept = rows.filter((r) => r[key].confidence >= threshold);
      return `${pct(kept.length / rows.length)} kept, ${pct(share(kept.map((r) => r.mention.expected.includes(r[key].choice))))} correct`;
    };
    const report = [
      `Model \`${provider.model}\`. Base: ${String(allNames.customer.length)} customers, ${String(allNames.product.length)} products, ${String(allNames["customer group"].length)} groups, seeded through the modules' create actions. Retrieval is the module's own list search, limit ${String(RETRIEVAL_LIMIT)}.`,
      "",
      "| Kind | Mentions | Retrieval finds the record | Mean candidates | Correct via retrieval → Jev | Correct via whole list → Jev | Correct combined | Wrong record combined |",
      "| --- | --- | --- | --- | --- | --- | --- | --- |",
      line("all", rows),
      ...kinds.map((kind) =>
        line(
          kind,
          rows.filter((r) => r.mention.kind === kind),
        ),
      ),
      "",
      "| Confidence ≥ | Retrieval → Jev | Whole list → Jev | Combined |",
      "| --- | --- | --- | --- |",
      ...[0.5, 0.7, 0.9].map(
        (t) =>
          `| ${num(t, 1)} | ${confident("viaRetrieval", t)} | ${confident("viaFullList", t)} | ${confident("combined", t)} |`,
      ),
      "",
      "| Kind | Mention | Expected | Retrieved | Via retrieval | Via whole list |",
      "| --- | --- | --- | --- | --- | --- |",
      ...rows.map(
        (r) =>
          `| ${r.mention.kind} | ${r.mention.mention} | ${r.mention.expected.join(" / ")} | ${String(r.retrieved.length)}${r.mention.expected.some((e) => r.retrieved.includes(e)) ? " ✓" : ""} | ${r.viaRetrieval.choice} (${num(r.viaRetrieval.confidence)}) | ${r.viaFullList.choice} (${num(r.viaFullList.confidence)}) |`,
      ),
    ].join("\n");

    if (OUT !== undefined) {
      writeFileSync(OUT, `${report}\n`);
    }
    expect(rows).toHaveLength(BASE_MENTIONS.length);
  });
});
