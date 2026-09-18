import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

import {
  STAFF_JUDGMENT_SPECS,
  createAnthropicStaffProviderAdapter,
  createStaffLanguageModel,
  createTypeSafeJudgmentProvider,
  isRewriteGrounded,
  observedShadowCall,
  planStaffTurn,
  staffAssistantSystemMessages,
  staffAssistantTools,
  staffAssistantTurnContextAddendum,
  type JudgmentProvider,
  type LanguageModel,
  type StaffJudgmentPlan,
  type StaffJudgmentSpec,
} from "@showzy/ai";
import { loadServerConfig } from "@showzy/config";
import { aiToolSourcesForPrincipal } from "@showzy/contract";
import type { JudgmentShadowCall } from "@showzy/validation/assistant-judgment";

import { createActionRegistry } from "../../registry.js";
import type { LlmUsage } from "../executor/llm.js";
import { num, pct, percentile, share } from "../probe.js";
import { FOLLOWUP_HOLDOUT_CASES } from "./corpus-holdout.js";
import {
  FOLLOWUP_CASES,
  KNOWN_CUSTOMER_NAMES,
  type FollowupCase,
} from "./corpus.js";
import {
  firstCallInToolLoop,
  rewriteWithHistory,
  type ToolLoopSetup,
} from "./llm.js";
import { scoreCall, type CallScore } from "./score.js";

const USD_PER_MTOK = {
  sonnet: { input: 3, output: 15 },
  haiku: { input: 1, output: 5 },
} as const;
const GATE_THRESHOLDS = [0.3, 0.5, 0.7] as const;
const GATE_AT = 0.5;
const POOL = 3;

interface CaseRow {
  readonly caseId: string;
  readonly needsHistory: boolean;
  readonly gateMessageOnly: number | null;
  readonly gateWithReply: number | null;
  readonly rawPlan: StaffJudgmentPlan;
  readonly rewritten: string;
  readonly rewriteLatencyMs: number;
  readonly rewriteUsage: LlmUsage;
  readonly rewrittenPlan: StaffJudgmentPlan;
  readonly haiku: LoopRow;
  readonly sonnet: LoopRow;
}

interface LoopRow {
  readonly call: JudgmentShadowCall | null;
  readonly text: string;
  readonly latencyMs: number;
  readonly usage: LlmUsage;
}

async function mapPool<T, R>(
  items: readonly T[],
  size: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        const item = items[index];
        if (item !== undefined) {
          results[index] = await work(item);
        }
      }
    }),
  );
  return results;
}

async function askGate(
  provider: JudgmentProvider,
  probeCase: FollowupCase,
  withReply: boolean,
): Promise<number | null> {
  const previousReply = probeCase.history.at(-1)?.assistant;
  if (withReply && previousReply === undefined) {
    return null;
  }
  const result = await provider.ask({
    state: withReply
      ? { previousReply: previousReply ?? "", message: probeCase.message }
      : { message: probeCase.message },
    questions: {
      needsHistory: {
        type: "noul",
        instructions: withReply
          ? "`previousReply` is what the business assistant said last and `message` is what the staff member typed next. Does `message` depend on the earlier conversation to be understood: it answers, continues, narrows or corrects it, or refers to a person, product, order or period without naming it?"
          : "`message` is what a staff member typed to the business assistant in the middle of a conversation. Does `message` depend on the earlier conversation to be understood: it answers, continues, narrows or corrects something said before, or refers to a person, product, order or period without naming it?",
        criteria: {
          true: "The message cannot be acted on alone: part of the request is only in the earlier conversation.",
          false:
            "The message states the whole request itself, or is small talk that needs no context.",
        },
      },
    },
  });
  return result.ok ? result.answers.needsHistory.probability : null;
}

function namedIds(value: unknown, found: Map<string, string>): void {
  if (Array.isArray(value)) {
    value.forEach((entry) => {
      namedIds(entry, found);
    });
    return;
  }
  if (typeof value !== "object" || value === null) {
    return;
  }
  if (
    "id" in value &&
    "name" in value &&
    typeof value.id === "string" &&
    typeof value.name === "string"
  ) {
    found.set(value.id, value.name);
  }
  Object.values(value).forEach((entry) => {
    namedIds(entry, found);
  });
}

function withKnownCustomer(probeCase: FollowupCase, input: unknown): unknown {
  if (typeof input !== "object" || input === null || !("customerId" in input)) {
    return input;
  }
  const known = new Map(Object.entries(KNOWN_CUSTOMER_NAMES));
  namedIds(
    probeCase.history.map((exchange) => exchange.call?.output ?? null),
    known,
  );
  const name =
    typeof input.customerId === "string"
      ? known.get(input.customerId)
      : undefined;
  return name === undefined ? input : { ...input, customerQuery: name };
}

const isTalk = (plan: StaffJudgmentPlan): boolean =>
  plan.kind === "small_talk" || plan.kind === "capability_question";

const confidentCall = (plan: StaffJudgmentPlan): JudgmentShadowCall | null =>
  plan.call !== undefined &&
  (plan.declinedBecause === undefined || plan.declinedBecause === "write")
    ? { tool: plan.call.tool, args: plan.call.args }
    : null;

const llmCost = (usage: LlmUsage, kind: keyof typeof USD_PER_MTOK): number =>
  (usage.inputTokens * USD_PER_MTOK[kind].input +
    usage.outputTokens * USD_PER_MTOK[kind].output) /
  1_000_000;

interface JevOutcome {
  readonly planned: JudgmentShadowCall | null;
  readonly score: CallScore | null;
}

function jevOutcome(
  readTools: ReadonlySet<string>,
  probeCase: FollowupCase,
  plan: StaffJudgmentPlan,
  gated: boolean,
): JevOutcome {
  const planned = gated ? null : confidentCall(plan);
  return {
    planned,
    score: planned === null ? null : scoreCall(probeCase, planned, readTools),
  };
}

function jevLine(
  mode: string,
  cases: readonly FollowupCase[],
  outcomes: readonly JevOutcome[],
): string {
  const planned = outcomes.filter((outcome) => outcome.planned !== null);
  const correct = planned.filter((outcome) => outcome.score?.correct === true);
  return `| ${mode} | ${String(planned.length)} / ${String(cases.length)} | ${String(correct.length)} | ${String(planned.length - correct.length)} | ${String(cases.length - planned.length)} |`;
}

function render(
  rows: readonly CaseRow[],
  readTools: ReadonlySet<string>,
): string {
  const byId = new Map(
    [...FOLLOWUP_CASES, ...FOLLOWUP_HOLDOUT_CASES].map((c) => [c.id, c]),
  );
  const caseOf = (row: CaseRow): FollowupCase => {
    const found = byId.get(row.caseId);
    if (found === undefined) {
      throw new TypeError(`unknown case ${row.caseId}`);
    }
    return found;
  };
  const grounded = (probeCase: FollowupCase, row: CaseRow): boolean => {
    const spec = STAFF_JUDGMENT_SPECS.find(
      (entry) => entry.tool === row.rewrittenPlan.call?.tool,
    );
    return (
      spec === undefined ||
      row.rewrittenPlan.call === undefined ||
      isRewriteGrounded({
        spec,
        callArgs: row.rewrittenPlan.call.args,
        rewritten: row.rewritten,
        conversation: [
          probeCase.message,
          ...probeCase.history.flatMap((exchange) => [
            exchange.user,
            exchange.assistant,
          ]),
        ],
      })
    );
  };
  const groups = [
    ["Follow-ups", rows.filter((row) => row.needsHistory)],
    ["Controls", rows.filter((row) => !row.needsHistory)],
  ] as const;
  const out: string[] = [];

  out.push(
    "### Needs-history Noul",
    "",
    "| Variant | Threshold | Follow-ups flagged | Controls flagged |",
    "| --- | --- | --- | --- |",
  );
  for (const [variant, pick] of [
    ["message only", (row: CaseRow) => row.gateMessageOnly],
    ["message + previous reply", (row: CaseRow) => row.gateWithReply],
  ] as const) {
    for (const threshold of GATE_THRESHOLDS) {
      const flagged = (row: CaseRow) => (pick(row) ?? 0) >= threshold;
      out.push(
        `| ${variant} | ${String(threshold)} | ${pct(share(groups[0][1].map(flagged)))} | ${pct(share(groups[1][1].map(flagged)))} |`,
      );
    }
  }

  const jevModes = [
    ["Jev, last message only", (row: CaseRow) => row.rawPlan, () => false],
    [
      `Jev + Noul (message only) ≥ ${String(GATE_AT)} delegates`,
      (row: CaseRow) => row.rawPlan,
      (row: CaseRow) => (row.gateMessageOnly ?? 0) >= GATE_AT,
    ],
    [
      `Jev + Noul (with reply) ≥ ${String(GATE_AT)} delegates`,
      (row: CaseRow) => row.rawPlan,
      (row: CaseRow) => (row.gateWithReply ?? 0) >= GATE_AT,
    ],
    ["Haiku rewrite → Jev", (row: CaseRow) => row.rewrittenPlan, () => false],
    [
      `Noul (with reply) ≥ ${String(GATE_AT)} → Haiku rewrite → Jev, else Jev`,
      (row: CaseRow) =>
        (row.gateWithReply ?? 0) >= GATE_AT ? row.rewrittenPlan : row.rawPlan,
      () => false,
    ],
    [
      `Not talk, Noul ≥ ${String(GATE_AT)} → Haiku rewrite → Jev, else Jev`,
      (row: CaseRow) =>
        (row.gateWithReply ?? 0) >= GATE_AT && !isTalk(row.rawPlan)
          ? row.rewrittenPlan
          : row.rawPlan,
      (row: CaseRow) =>
        (row.gateWithReply ?? 0) >= GATE_AT && isTalk(row.rawPlan),
    ],
    [
      `As built: not talk, Noul (message only) ≥ ${String(GATE_AT)} → rewrite → Jev + grounding guard`,
      (row: CaseRow) =>
        (row.gateMessageOnly ?? 0) >= GATE_AT &&
        !isTalk(row.rawPlan) &&
        caseOf(row).history.length > 0
          ? row.rewrittenPlan
          : row.rawPlan,
      (row: CaseRow) =>
        (row.gateMessageOnly ?? 0) >= GATE_AT &&
        !isTalk(row.rawPlan) &&
        caseOf(row).history.length > 0 &&
        !grounded(caseOf(row), row),
    ],
  ] as const;

  const wrong: string[] = [];
  for (const [title, group] of groups) {
    out.push(
      "",
      `### ${title} (${String(group.length)}): Jev paths`,
      "",
      "| Mode | Confident plans | Correct | Wrong | Delegated |",
      "| --- | --- | --- | --- | --- |",
    );
    for (const [mode, planOf, gatedOf] of jevModes) {
      const outcomes = group.map((row) =>
        jevOutcome(readTools, caseOf(row), planOf(row), gatedOf(row)),
      );
      out.push(jevLine(mode, group.map(caseOf), outcomes));
      outcomes.forEach((outcome, index) => {
        const row = group[index];
        if (row !== undefined && outcome.score?.correct === false) {
          wrong.push(
            `| ${mode} | ${row.caseId} | ${JSON.stringify(outcome.planned)} |`,
          );
        }
      });
    }
  }

  out.push(
    "",
    "### Language model in the real tool loop: first staff tool call",
    "",
    "| Model | Follow-ups correct | Controls correct | Read before the write (all) | Wrong (all) | Latency p50 / p95 ms | Cost per turn |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const [name, kind, pick] of [
    ["Haiku", "haiku", (row: CaseRow) => row.haiku],
    ["Sonnet", "sonnet", (row: CaseRow) => row.sonnet],
  ] as const) {
    const scoreOf = (row: CaseRow) =>
      scoreCall(caseOf(row), pick(row).call, readTools);
    const latencies = rows.map((row) => pick(row).latencyMs);
    const cost =
      rows.reduce((sum, row) => sum + llmCost(pick(row).usage, kind), 0) /
      Math.max(1, rows.length);
    out.push(
      `| ${name} | ${pct(share(groups[0][1].map((row) => scoreOf(row).correct)))} | ${pct(share(groups[1][1].map((row) => scoreOf(row).correct)))} | ${pct(share(rows.map((row) => scoreOf(row).detour)))} | ${pct(share(rows.map((row) => !scoreOf(row).correct && !scoreOf(row).detour)))} | ${num(percentile(latencies, 0.5), 0)} / ${num(percentile(latencies, 0.95), 0)} | $${cost.toFixed(5)} |`,
    );
    for (const row of rows) {
      if (!scoreOf(row).correct) {
        wrong.push(
          `| ${name} tool loop${scoreOf(row).detour ? " (detour)" : ""} | ${row.caseId} | ${JSON.stringify(pick(row).call)} ${pick(row).text.slice(0, 80)} |`,
        );
      }
    }
  }

  out.push(
    "",
    "### Cascade end to end (Jev plan when confident, else the language model)",
    "",
    "| Jev path | Fallback | Correct (all cases) | Turns without a language model |",
    "| --- | --- | --- | --- |",
  );
  for (const [mode, planOf, gatedOf] of jevModes) {
    for (const [name, pick] of [
      ["Haiku", (row: CaseRow) => row.haiku],
      ["Sonnet", (row: CaseRow) => row.sonnet],
    ] as const) {
      const outcomes = rows.map((row) => {
        const jev = jevOutcome(
          readTools,
          caseOf(row),
          planOf(row),
          gatedOf(row),
        );
        return {
          byJev: jev.score !== null,
          correct:
            jev.score?.correct ??
            scoreCall(caseOf(row), pick(row).call, readTools).correct,
        };
      });
      out.push(
        `| ${mode} | ${name} | ${pct(share(outcomes.map((o) => o.correct)))} | ${pct(share(outcomes.map((o) => o.byJev)))} |`,
      );
    }
  }

  out.push(
    "",
    "### Reads only (what ADR-0044 lets the judgment take)",
    "",
    "| Jev path | Reads taken | Correct | Wrong |",
    "| --- | --- | --- | --- |",
  );
  for (const [mode, planOf, gatedOf] of jevModes) {
    const taken = rows.flatMap((row) => {
      const plan = planOf(row);
      const outcome = jevOutcome(readTools, caseOf(row), plan, gatedOf(row));
      return plan.declinedBecause === undefined && outcome.score !== null
        ? [outcome.score.correct]
        : [];
    });
    out.push(
      `| ${mode} | ${String(taken.length)} / ${String(rows.length)} | ${String(taken.filter(Boolean).length)} | ${String(taken.filter((ok) => !ok).length)} |`,
    );
  }

  const rewriteLatencies = rows.map((row) => row.rewriteLatencyMs);
  const rewriteCost =
    rows.reduce((sum, row) => sum + llmCost(row.rewriteUsage, "haiku"), 0) /
    Math.max(1, rows.length);
  out.push(
    "",
    `Haiku rewrite: latency p50 / p95 ${num(percentile(rewriteLatencies, 0.5), 0)} / ${num(percentile(rewriteLatencies, 0.95), 0)} ms, $${rewriteCost.toFixed(5)} per turn. Jev plan latency p50 ${num(
      percentile(
        rows.map((row) => row.rawPlan.latencyMs),
        0.5,
      ),
      0,
    )} ms.`,
    "",
    "### Wrong answers",
    "",
    "| Mode | Case | Got |",
    "| --- | --- | --- |",
    ...wrong,
  );
  return out.join("\n");
}

const { values } = parseArgs({
  options: {
    raw: { type: "string" },
    rescore: { type: "string" },
    set: { type: "string" },
    "reuse-llm": { type: "string" },
    only: { type: "string" },
  },
});
const onlyIds = values.only?.split(",");
const probeCases =
  onlyIds === undefined
    ? values.set === "holdout"
      ? FOLLOWUP_HOLDOUT_CASES
      : FOLLOWUP_CASES
    : [...FOLLOWUP_CASES, ...FOLLOWUP_HOLDOUT_CASES].filter((probeCase) =>
        onlyIds.some((id) => probeCase.id.startsWith(id)),
      );
const savedRows = (path: string): CaseRow[] =>
  (JSON.parse(readFileSync(path, "utf8")) as { rows: CaseRow[] }).rows;
const { ai } = loadServerConfig();
const contracts = aiToolSourcesForPrincipal(
  createActionRegistry().contracts(),
  "staff",
);
const risk = new Map(contracts.map((c) => [c.name, c.risk]));
const isWrite = (spec: StaffJudgmentSpec) => risk.get(spec.action) !== "read";
const readTools = new Set([
  "search_query",
  ...STAFF_JUDGMENT_SPECS.filter((spec) => !isWrite(spec)).map(
    (spec) => spec.tool,
  ),
]);
if (values.rescore !== undefined) {
  process.stdout.write(`${render(savedRows(values.rescore), readTools)}\n`);
} else if (
  ai.typesafeApiKey === undefined ||
  ai.anthropicApiKey === undefined
) {
  process.stderr.write(
    "TYPESAFE_API_KEY and ANTHROPIC_API_KEY are both required; nothing was sent.\n",
  );
  process.exitCode = 1;
} else {
  const jev = createTypeSafeJudgmentProvider({
    apiKey: ai.typesafeApiKey,
    model: ai.typesafeModel,
  });
  const adapter = createAnthropicStaffProviderAdapter({
    apiKey: ai.anthropicApiKey,
    replyModel: ai.model,
    gateModel: ai.gateModel,
  });
  const sonnet = createStaffLanguageModel({
    apiKey: ai.anthropicApiKey,
    model: ai.model,
  });
  const haiku = createStaffLanguageModel({
    apiKey: ai.anthropicApiKey,
    model: ai.gateModel,
  });
  const setup: ToolLoopSetup = {
    system: staffAssistantSystemMessages(
      staffAssistantTurnContextAddendum({ now: new Date() }),
      adapter,
    ),
    tools: staffAssistantTools(contracts, () => Promise.resolve({}), adapter),
    providerOptions: adapter.replyProviderOptions(),
  };

  const loop = async (
    model: LanguageModel,
    probeCase: FollowupCase,
  ): Promise<LoopRow> => {
    const result = await firstCallInToolLoop(model, setup, probeCase);
    return {
      call:
        result.call === undefined
          ? null
          : observedShadowCall(
              {
                ...result.call,
                input: withKnownCustomer(probeCase, result.call.input),
              },
              STAFF_JUDGMENT_SPECS,
            ),
      text: result.text,
      latencyMs: result.latencyMs,
      usage: result.usage,
    };
  };
  const reused = new Map(
    (values["reuse-llm"] === undefined
      ? []
      : savedRows(values["reuse-llm"])
    ).map((row) => [row.caseId, row]),
  );
  const plan = (message: string) =>
    planStaffTurn({
      provider: jev,
      message,
      specs: STAFF_JUDGMENT_SPECS,
      isWrite,
    });

  const rows = await mapPool(
    probeCases,
    POOL,
    async (probeCase): Promise<CaseRow> => {
      const rewrite = await rewriteWithHistory(haiku, probeCase);
      const [
        gateMessageOnly,
        gateWithReply,
        rawPlan,
        rewrittenPlan,
        haikuRow,
        sonnetRow,
      ] = await Promise.all([
        askGate(jev, probeCase, false),
        askGate(jev, probeCase, true),
        plan(probeCase.message),
        plan(rewrite.text),
        reused.get(probeCase.id)?.haiku ?? loop(haiku, probeCase),
        reused.get(probeCase.id)?.sonnet ?? loop(sonnet, probeCase),
      ]);
      process.stderr.write(`${probeCase.id}\n`);
      return {
        caseId: probeCase.id,
        needsHistory: probeCase.needsHistory,
        gateMessageOnly,
        gateWithReply,
        rawPlan,
        rewritten: rewrite.text,
        rewriteLatencyMs: rewrite.latencyMs,
        rewriteUsage: rewrite.usage,
        rewrittenPlan,
        haiku: haikuRow,
        sonnet: sonnetRow,
      };
    },
  );

  if (values.raw !== undefined) {
    writeFileSync(values.raw, JSON.stringify({ rows }, null, 2));
  }
  process.stdout.write(
    `${String(rows.length)} cases, ${jev.model}, ${ai.gateModel}, ${ai.model}.\n\n${render(rows, readTools)}\n`,
  );
}
