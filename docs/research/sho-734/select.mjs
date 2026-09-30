/**
 * SHO-734 selection builder. Reads the owner's live-mic gold sets from the
 * read-only system-one-uk checkout and writes `utterances.jsonl`: every row
 * of every selected set, tagged with its source set, row id, speaker and
 * whether that set is leak-guarded out of the Шо v3.3 training mix.
 *
 * Usage: node docs/research/sho-734/select.mjs [path-to-system-one-uk]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2] ?? "E:/system-one-uk";

// `trained: false` = in sho/data/multidomain/leaks.py HELD_OUT and
// tests/test_heldout.py HELD_OUT, so no v3.3 training input could read it.
const SETS = [
  { file: "live_heldout_gold.jsonl", trained: false, labelled: true },
  { file: "dictation_v5_gold.jsonl", trained: false, labelled: true },
  { file: "live_heldout_ambiguous.jsonl", trained: false, labelled: false },
  { file: "live_orders_gold.jsonl", trained: "unguarded", labelled: true },
  { file: "live_gold.jsonl", trained: "unguarded", labelled: true },
];

function rowsOf(file) {
  const path = join(root, "data", "voice2", file);
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

function speakerOf(row) {
  if (row.speaker !== undefined) return row.speaker;
  if (row.asr === "google-retranscribed") return "owner-retranscribed";
  return row.source === "live-mic" ? "owner" : (row.source ?? "unknown");
}

function goldOf(row) {
  const commands = row.commands ?? (row.action === undefined ? [] : [row]);
  return commands.map((command) => ({
    action: command.action,
    params: command.params ?? {},
  }));
}

const out = [];
for (const set of SETS) {
  for (const row of rowsOf(set.file)) {
    out.push({
      id: `${set.file.replace(".jsonl", "")}:${row.id}`,
      set: set.file,
      row: row.id,
      speaker: speakerOf(row),
      trained: set.trained,
      labelled: set.labelled,
      raw: row.raw ?? row.utterance,
      utterance: row.utterance ?? row.raw,
      asrError: row.asr_error === true,
      receivedAt: row.received_at ?? null,
      commands: goldOf(row),
    });
  }
}

const path = join(import.meta.dirname, "utterances.jsonl");
writeFileSync(path, `${out.map((row) => JSON.stringify(row)).join("\n")}\n`);
console.log(`${String(out.length)} rows -> ${path}`);
for (const set of SETS) {
  const n = out.filter((row) => row.set === set.file).length;
  console.log(`  ${set.file}: ${String(n)} (trained=${String(set.trained)})`);
}
