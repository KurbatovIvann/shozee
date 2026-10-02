import { parentPort } from "node:worker_threads";
import {
  InputError,
  compileContext,
  loadSho,
  manifest,
  parseContext,
  parsePrevious,
  runtimeVersion,
  type Previous,
  type Sho,
} from "@showzy/sho";
import type { ShoModelStamp } from "@showzy/sho-protocol";

import { createShoContextCache, type ShoContextCache } from "./contexts.ts";
import {
  SHO_LABELS_FILE,
  type ShoWorkerCommand,
  type ShoWorkerReady,
  type ShoWorkerReply,
} from "./engine.ts";

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
): Promise<ShoWorkerReply> {
  const id = command.id;
  if (command.kind === "phrases") {
    const entry = cache.read(command.key);
    return { id, kind: "phrases", phrases: entry?.phrases ?? null };
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
    return { id, kind: "stored" };
  }
  const job = command.job;
  const entry = cache.fresh(job.key, job.fingerprint);
  if (entry === null) return { id, kind: "context_required" };
  const previous: Previous | null =
    job.previous === null ? null : parsePrevious(job.previous);
  const started = performance.now();
  const result = await sho.run(
    { raw: job.text },
    {
      context: entry.compiled,
      now: job.now,
      previous,
      debug: job.debug,
    },
  );
  return {
    id,
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
  const cache = createShoContextCache();
  port.on("message", (command: ShoWorkerCommand) => {
    void answer(sho, cache, command)
      .catch((cause: unknown): ShoWorkerReply => {
        if (cause instanceof InputError) {
          return { id: command.id, kind: "input" };
        }
        return {
          id: command.id,
          kind: "failed",
          message: cause instanceof Error ? cause.message : String(cause),
        };
      })
      .then((reply) => {
        port.postMessage(reply);
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
