import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadSho } from "../src/index.ts";

const DEFAULT_DIR = "E:/system-one-uk/data/voice2";
const FILES = [
  "live_heldout_gold.jsonl",
  "dictation_v4_gold.jsonl",
  "test_verified.jsonl",
];

function phraseOf(line: string): string | null {
  const row: unknown = JSON.parse(line);
  if (typeof row !== "object" || row === null) return null;
  const raw: unknown = Reflect.get(row, "raw");
  if (typeof raw === "string" && raw.trim() !== "") return raw;
  const utterance: unknown = Reflect.get(row, "utterance");
  if (typeof utterance === "string" && utterance.trim() !== "")
    return utterance;
  return null;
}

async function phrases(dir: string): Promise<string[]> {
  const all: string[] = [];
  for (const file of FILES) {
    const text = await readFile(join(dir, file), "utf8");
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      const phrase = phraseOf(line);
      if (phrase !== null) all.push(phrase);
    }
  }
  return all;
}

function quantile(sorted: readonly number[], at: number): number {
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(at * sorted.length) - 1),
  );
  return sorted[index] ?? Number.NaN;
}

const dir = process.argv[2] ?? DEFAULT_DIR;
const utterances = await phrases(dir);
const sho = await loadSho({ threads: 1, verify: true });

for (const phrase of utterances.slice(0, 20)) await sho.run({ raw: phrase });

const timings: number[] = [];
for (const phrase of utterances) {
  const started = performance.now();
  await sho.run({ raw: phrase });
  timings.push(performance.now() - started);
}
await sho.dispose();

timings.sort((a, b) => a - b);
const mean = timings.reduce((sum, ms) => sum + ms, 0) / timings.length;
process.stdout.write(
  `Шо ${sho.model.name} parse over ${String(timings.length)} utterances (1 worker, 1 intra-op thread)\n` +
    `  mean ${mean.toFixed(2)} ms  p50 ${quantile(timings, 0.5).toFixed(2)} ms` +
    `  p95 ${quantile(timings, 0.95).toFixed(2)} ms  p99 ${quantile(timings, 0.99).toFixed(2)} ms\n`,
);
