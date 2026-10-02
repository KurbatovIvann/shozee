import { parentPort, threadId } from "node:worker_threads";
import type { ActionName, CommandV2, ResultV2 } from "@showzy/sho";

import type {
  ShoWorkerCommand,
  ShoWorkerReady,
  ShoWorkerReply,
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

function answer(command: ShoWorkerCommand): ShoWorkerReply | null {
  const id = command.id;
  if (command.kind === "store") {
    held.set(command.upload.key, {
      fingerprint: command.upload.fingerprint,
      revision: command.upload.revision,
      phrases: command.upload.phrases,
    });
    return { id, kind: "stored" };
  }
  if (command.kind === "phrases") {
    return {
      id,
      kind: "phrases",
      phrases: held.get(command.key)?.phrases ?? null,
    };
  }
  const job = command.job;
  if (job.text === "hang") return null;
  if (job.text === "crash") process.exit(1);
  if (job.text === "boom") return { id, kind: "failed", message: "boom" };
  if (job.text === "bad") return { id, kind: "input" };
  const entry = held.get(job.key);
  if (entry === undefined || entry.fingerprint !== job.fingerprint) {
    return { id, kind: "context_required" };
  }
  return {
    id,
    kind: "parsed",
    result: resultOf(job.text),
    contextRevision: entry.revision,
    ms: 1,
  };
}

if (parentPort !== null) {
  const port = parentPort;
  port.on("message", (command: ShoWorkerCommand) => {
    const reply = answer(command);
    if (reply !== null) port.postMessage(reply);
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
