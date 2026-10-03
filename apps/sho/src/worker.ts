import { parentPort, workerData } from "node:worker_threads";
import {
  compileContext,
  loadSho,
  manifest,
  parseContext,
  parseFocus,
  parsePrevious,
  runtimeVersion,
  type FocusEntry,
  type Previous,
  type Sho,
} from "@showzy/sho";
import type { ShoModelStamp } from "@showzy/sho-protocol";

import {
  createShoContextCache,
  shoCacheBudgetOf,
  type ShoContextCache,
} from "./contexts.ts";
import {
  SHO_LABELS_FILE,
  type ShoAnswer,
  type ShoFailureDetail,
  type ShoReply,
  type ShoWorkerCommand,
  type ShoWorkerReady,
} from "./engine.ts";
import { shoFailureOf } from "./failure.ts";

function stampOf(sho: Sho): ShoModelStamp {
  return {
    id: sho.model.name,
    md5: sho.model.md5,
    catalogue: sho.bundle.catalogue ?? "",
    labelsMd5: manifest.files[SHO_LABELS_FILE]?.md5 ?? "",
    runtime: runtimeVersion,
  };
}

async function answer(
  sho: Sho,
  cache: ShoContextCache,
  command: ShoWorkerCommand,
): Promise<ShoReply> {
  if (command.kind === "phrases") {
    const entry = cache.read(command.key);
    return { kind: "phrases", phrases: entry?.phrases ?? null };
  }
  if (command.kind === "store") {
    const upload = command.upload;
    cache.put(upload.key, {
      fingerprint: upload.fingerprint,
      revision: upload.revision,
      compiled: compileContext(parseContext(upload.context)),
      phrases: upload.phrases,
      uploadBytes: upload.uploadBytes,
    });
    return { kind: "stored" };
  }
  const job = command.job;
  const entry = cache.fresh(job.key, job.fingerprint);
  if (entry === null) return { kind: "context_required" };
  const previous: Previous | null =
    job.previous === null ? null : parsePrevious(job.previous);
  const focus: FocusEntry[] | null =
    job.focus === null ? null : parseFocus(job.focus);
  const started = performance.now();
  const result = await sho.run(
    { raw: job.text },
    {
      context: entry.compiled,
      now: job.now,
      previous,
      focus,
      debug: job.debug,
    },
  );
  return {
    kind: "parsed",
    result,
    contextRevision: entry.revision,
    ms: performance.now() - started,
  };
}

async function serveShoWorker(
  port: NonNullable<typeof parentPort>,
): Promise<void> {
  const sho = await loadSho();
  const cache = createShoContextCache(shoCacheBudgetOf(workerData));
  port.on("message", (command: ShoWorkerCommand) => {
    let detail: ShoFailureDetail | undefined;
    void answer(sho, cache, command)
      .catch((cause: unknown): ShoReply => {
        const failure = shoFailureOf(cause);
        detail = failure.detail;
        return failure.reply;
      })
      .then((reply) => {
        const sent: ShoAnswer = { id: command.id, reply, detail };
        port.postMessage(sent);
      });
  });
  const ready: ShoWorkerReady = {
    kind: "ready",
    stamp: stampOf(sho),
    actions: sho.bundle.actions,
  };
  port.postMessage(ready);
}

if (parentPort !== null) await serveShoWorker(parentPort);
