import { readFileSync } from "node:fs";

interface SavedPlan {
  readonly declinedBecause?: string;
  readonly call?: { readonly tool: string; readonly args: unknown };
}

interface SavedRow {
  readonly caseId: string;
  readonly gateWithReply: number | null;
  readonly rewritten: string;
  readonly rawPlan: SavedPlan;
  readonly rewrittenPlan: SavedPlan;
}

const GATE_AT = 0.5;

const signature = (plan: SavedPlan): string =>
  plan.call !== undefined &&
  (plan.declinedBecause === undefined || plan.declinedBecause === "write")
    ? JSON.stringify([plan.call.tool, plan.call.args])
    : "delegated";

const FACETS: readonly (readonly [string, (row: SavedRow) => string])[] = [
  ["raw plan", (row) => signature(row.rawPlan)],
  ["rewritten plan", (row) => signature(row.rewrittenPlan)],
  ["gate", (row) => String((row.gateWithReply ?? 0) >= GATE_AT)],
  ["rewrite text", (row) => row.rewritten],
];

const runs = process.argv
  .slice(2)
  .map(
    (path) =>
      (JSON.parse(readFileSync(path, "utf8")) as { rows: SavedRow[] }).rows,
  );
const first = runs[0] ?? [];
const changedRows = first.flatMap((row) => {
  const same = runs.map((rows) => rows.find((r) => r.caseId === row.caseId));
  const changed = FACETS.filter(
    ([, read]) =>
      new Set(same.map((r) => (r === undefined ? "missing" : read(r)))).size >
      1,
  ).map(([name]) => name);
  return changed.length === 0
    ? []
    : [`| ${row.caseId} | ${changed.join(", ")} |`];
});

process.stdout.write(
  [
    `${String(runs.length)} runs, ${String(first.length)} cases, ${String(changedRows.length)} changed.`,
    "",
    "| Case | What changed between runs |",
    "| --- | --- |",
    ...changedRows,
    "",
  ].join("\n"),
);
