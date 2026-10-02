import { parentPort, threadId, workerData } from "node:worker_threads";
import type { ActionName, CommandV2, ResultV2 } from "@showzy/sho";

import { shoCacheBudgetOf } from "../src/contexts.ts";
import type {
  ShoAnswer,
  ShoReply,
  ShoWorkerCommand,
  ShoWorkerReady,
} from "../src/engine.ts";

interface Held {
  readonly fingerprint: string;
  readonly revision: string | null;
  readonly phrases: readonly string[];
}

const held = new Map<string, Held>();

const commandOf = (text: string): CommandV2 => ({
  text,
  action: "orders.create" as ActionName,
  kind: "write",
  effect: "write",
  confirm: "card",
  params: {},
  needs: [],
  ready: true,
  refPrevious: {},
  catalogued: false,
  confidence: { action: 1, margin: 1, certainty: 1, spans: 1 },
});

const resultOf = (text: string): ResultV2 => ({
  schema: "sho-result/2",
  raw: text,
  text: String(threadId),
  segments: [text],
  tooMany: false,
  commands: [commandOf(text)],
  first: commandOf(text),
  context: null,
});

function answer(command: ShoWorkerCommand): ShoReply | null {
  if (command.kind === "store") {
    held.set(command.upload.key, {
      fingerprint: command.upload.fingerprint,
      revision: command.upload.revision,
      phrases: command.upload.phrases,
    });
    return { kind: "stored" };
  }
  if (command.kind === "phrases") {
    return {
      kind: "phrases",
      phrases: held.get(command.key)?.phrases ?? null,
    };
  }
  const job = command.job;
  if (job.text === "budget") {
    return {
      kind: "parsed",
      result: resultOf(String(shoCacheBudgetOf(workerData))),
      contextRevision: null,
      ms: 1,
    };
  }
  if (job.text === "hang") return null;
  if (job.text === "crash") process.exit(1);
  if (job.text === "boom") return { kind: "failed", code: "boom" };
  if (job.text === "bad") return { kind: "input" };
  const entry = held.get(job.key);
  if (entry === undefined || entry.fingerprint !== job.fingerprint) {
    return { kind: "context_required" };
  }
  return {
    kind: "parsed",
    result: resultOf(job.text),
    contextRevision: entry.revision,
    ms: 1,
  };
}

if (parentPort !== null && process.env.SHO_FIXTURE_EXIT === "1") {
  process.exit(3);
}

if (parentPort !== null) {
  const port = parentPort;
  port.on("message", (command: ShoWorkerCommand) => {
    const reply = answer(command);
    if (reply === null) return;
    const sent: ShoAnswer = { id: command.id, reply };
    if (command.kind === "parse" && command.job.text === "slow") {
      setTimeout(() => {
        port.postMessage(sent);
      }, 200);
      return;
    }
    port.postMessage(sent);
  });
  const ready: ShoWorkerReady = {
    kind: "ready",
    stamp: {
      id: "fixture",
      md5: "0123456789abcdef0123456789abcdef",
      catalogue: "v3",
      labelsMd5: "fedcba9876543210fedcba9876543210",
      runtime: "0.0.0",
    },
    actions: ["orders.create"],
  };
  port.postMessage(ready);
}
