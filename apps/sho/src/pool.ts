import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";

import { SHO_MAX_CONTEXT_BYTES } from "@showzy/sho-protocol";

import { SHO_CONTEXT_CACHE_UPLOAD_BYTES } from "./contexts.ts";
import {
  ShoRunFailure,
  type ShoAnswer,
  type ShoEngine,
  type ShoFailureDetail,
  type ShoPhrasesReply,
  type ShoReply,
  type ShoRunReply,
  type ShoStoreReply,
  type ShoWorkerCommand,
  type ShoWorkerReady,
  type ShoWorkerSetup,
} from "./engine.ts";

export const SHO_QUEUE_LIMIT = 8;
export const SHO_CALL_TIMEOUT_MS = 30_000;
export const SHO_RESPAWN_BACKOFF_MS = 250;
export const SHO_RESPAWN_LIMIT = 5;

export const shoDefaultWorkers = (): number =>
  Math.max(availableParallelism() - 1, 1);

export const SHO_WORKER_CACHE_FLOOR_BYTES = SHO_MAX_CONTEXT_BYTES;

export const shoWorkerCacheBytes = (size: number): number =>
  Math.max(
    Math.floor(SHO_CONTEXT_CACHE_UPLOAD_BYTES / Math.max(size, 1)),
    SHO_WORKER_CACHE_FLOOR_BYTES,
  );

const WRONG_KIND = { kind: "failed", code: "unexpected_reply" } as const;

const refusal = (
  reply: ShoReply,
): reply is Extract<ShoReply, { kind: "busy" | "deadline" | "failed" }> =>
  reply.kind === "busy" || reply.kind === "deadline" || reply.kind === "failed";

const storeReplyOf = (reply: ShoReply): ShoStoreReply =>
  refusal(reply) || reply.kind === "stored" || reply.kind === "input"
    ? reply
    : WRONG_KIND;

const phrasesReplyOf = (reply: ShoReply): ShoPhrasesReply =>
  refusal(reply) || reply.kind === "phrases" ? reply : WRONG_KIND;

const runReplyOf = (reply: ShoReply): ShoRunReply =>
  refusal(reply) ||
  reply.kind === "parsed" ||
  reply.kind === "context_required" ||
  reply.kind === "input"
    ? reply
    : WRONG_KIND;

export function shoSlotOf(contextKey: string, size: number): number {
  const colon = contextKey.indexOf(":");
  const companyId = colon < 0 ? contextKey : contextKey.slice(0, colon);
  let hash = 2166136261;
  for (let at = 0; at < companyId.length; at += 1) {
    hash = Math.imul(hash ^ companyId.charCodeAt(at), 16777619);
  }
  return (hash >>> 0) % size;
}

export type ShoWorkerLoss = "crashed" | "hung";

export interface ShoPoolOptions {
  readonly size?: number;
  readonly queueLimit?: number;
  readonly callTimeoutMs?: number;
  readonly hangMs?: number;
  readonly respawnBackoffMs?: number;
  readonly respawnLimit?: number;
  readonly workerUrl?: URL;
  readonly onLoss?: (slot: number, loss: ShoWorkerLoss) => void;
  readonly onFailure?: (code: string, detail: ShoFailureDetail | null) => void;
}

type Timer = ReturnType<typeof setTimeout>;

interface Boot {
  readonly resolve: (ready: ShoWorkerReady) => void;
  readonly reject: (cause: Error) => void;
}

interface Pending {
  readonly command: ShoWorkerCommand;
  readonly expiresAt: number;
  settle: ((reply: ShoReply) => void) | null;
  timer: Timer | null;
  hangTimer: Timer | null;
}

interface Slot {
  readonly index: number;
  worker: Worker | null;
  ready: boolean;
  failures: number;
  respawnTimer: Timer | null;
  running: Pending | null;
  readonly queue: Pending[];
}

export async function createShoPool(
  options: ShoPoolOptions = {},
): Promise<ShoEngine> {
  const size = Math.max(options.size ?? shoDefaultWorkers(), 1);
  const queueLimit = options.queueLimit ?? SHO_QUEUE_LIMIT;
  const callTimeoutMs = options.callTimeoutMs ?? SHO_CALL_TIMEOUT_MS;
  const hangMs = options.hangMs ?? callTimeoutMs;
  const respawnBackoffMs = options.respawnBackoffMs ?? SHO_RESPAWN_BACKOFF_MS;
  const respawnLimit = options.respawnLimit ?? SHO_RESPAWN_LIMIT;
  const workerUrl =
    options.workerUrl ?? new URL("./worker.ts", import.meta.url);
  const onLoss = options.onLoss ?? ((): void => undefined);
  const onFailure = options.onFailure ?? ((): void => undefined);
  const setup: ShoWorkerSetup = { maxUploadBytes: shoWorkerCacheBytes(size) };

  const slots: Slot[] = [];
  let stopped = false;
  let booting = true;
  let nextId = 1;

  function settle(pending: Pending, reply: ShoReply): void {
    if (pending.timer !== null) clearTimeout(pending.timer);
    if (pending.hangTimer !== null) clearTimeout(pending.hangTimer);
    pending.timer = null;
    pending.hangTimer = null;
    const once = pending.settle;
    pending.settle = null;
    once?.(reply);
  }

  function pump(slot: Slot): void {
    const worker = slot.worker;
    if (worker === null || !slot.ready || slot.running !== null) return;
    for (;;) {
      const next = slot.queue.shift();
      if (next === undefined) return;
      const left = next.expiresAt - performance.now();
      if (left <= 0) {
        settle(next, { kind: "deadline" });
        continue;
      }
      if (next.timer !== null) clearTimeout(next.timer);
      next.timer = setTimeout(() => {
        next.timer = null;
        const once = next.settle;
        next.settle = null;
        once?.({ kind: "deadline" });
      }, left);
      next.hangTimer = setTimeout(() => {
        next.hangTimer = null;
        lose(slot, "hung");
      }, hangMs);
      slot.running = next;
      worker.postMessage(next.command);
      return;
    }
  }

  function drain(slot: Slot, running: ShoReply): void {
    const waiting = slot.queue.splice(0, slot.queue.length);
    const inFlight = slot.running;
    slot.worker = null;
    slot.ready = false;
    slot.running = null;
    if (inFlight !== null) settle(inFlight, running);
    for (const pending of waiting) settle(pending, { kind: "busy" });
  }

  function lose(slot: Slot, loss: ShoWorkerLoss): void {
    const victim = slot.worker;
    drain(slot, { kind: loss === "hung" ? "deadline" : "busy" });
    if (victim !== null) void victim.terminate();
    onLoss(slot.index, loss);
    if (stopped || booting) return;
    slot.failures += 1;
    if (slot.failures > respawnLimit) return;
    slot.respawnTimer = setTimeout(() => {
      slot.respawnTimer = null;
      if (!stopped) spawn(slot, null);
    }, respawnBackoffMs * slot.failures);
  }

  function spawn(slot: Slot, boot: Boot | null): void {
    const worker = new Worker(workerUrl, { workerData: setup });
    slot.worker = worker;
    slot.ready = false;
    worker.on("message", (answer: ShoWorkerReady | ShoAnswer) => {
      if (slot.worker !== worker) return;
      if ("stamp" in answer) {
        slot.ready = true;
        slot.failures = 0;
        boot?.resolve(answer);
        pump(slot);
        return;
      }
      const running = slot.running;
      if (running === null || running.command.id !== answer.id) return;
      slot.running = null;
      if (answer.reply.kind === "failed") {
        onFailure(answer.reply.code, answer.detail ?? null);
      }
      settle(running, answer.reply);
      pump(slot);
    });
    worker.on("error", (cause: Error) => {
      if (slot.worker !== worker) return;
      boot?.reject(cause);
      lose(slot, "crashed");
    });
    worker.on("exit", () => {
      if (slot.worker !== worker) return;
      boot?.reject(new ShoRunFailure("worker_exited_at_boot"));
      lose(slot, "crashed");
    });
  }

  function send(
    key: string,
    make: (id: number) => ShoWorkerCommand,
    deadlineMs: number,
  ): Promise<ShoReply> {
    const slot = slots[shoSlotOf(key, size)];
    if (slot === undefined || stopped || !slot.ready) {
      return Promise.resolve({ kind: "busy" });
    }
    if (slot.queue.length + (slot.running === null ? 0 : 1) >= queueLimit) {
      return Promise.resolve({ kind: "busy" });
    }
    const id = nextId;
    nextId += 1;
    return new Promise<ShoReply>((resolve) => {
      const budget = Math.max(deadlineMs, 0);
      const pending: Pending = {
        command: make(id),
        expiresAt: performance.now() + budget,
        settle: resolve,
        timer: null,
        hangTimer: null,
      };
      pending.timer = setTimeout(() => {
        pending.timer = null;
        const at = slot.queue.indexOf(pending);
        if (at >= 0) slot.queue.splice(at, 1);
        const once = pending.settle;
        pending.settle = null;
        once?.({ kind: "deadline" });
      }, budget);
      slot.queue.push(pending);
      pump(slot);
    });
  }

  const booted: Promise<ShoWorkerReady>[] = [];
  for (let index = 0; index < size; index += 1) {
    const slot: Slot = {
      index,
      worker: null,
      ready: false,
      failures: 0,
      respawnTimer: null,
      running: null,
      queue: [],
    };
    slots.push(slot);
    booted.push(
      new Promise<ShoWorkerReady>((resolve, reject) => {
        spawn(slot, { resolve, reject });
      }),
    );
  }

  let readied: ShoWorkerReady[];
  try {
    readied = await Promise.all(booted);
  } catch (cause) {
    stopped = true;
    for (const slot of slots) await slot.worker?.terminate();
    throw cause;
  }
  booting = false;
  const first = readied[0];
  if (first === undefined) throw new ShoRunFailure("no_workers");

  return {
    stamp: first.stamp,
    actions: first.actions,
    workers: size,

    get ready() {
      return !stopped && slots.every((slot) => slot.ready);
    },

    store: async (upload) =>
      storeReplyOf(
        await send(
          upload.key,
          (id) => ({ id, kind: "store", upload }),
          callTimeoutMs,
        ),
      ),

    phrases: async (key) =>
      phrasesReplyOf(
        await send(key, (id) => ({ id, kind: "phrases", key }), callTimeoutMs),
      ),

    run: async (job) =>
      runReplyOf(
        await send(
          job.key,
          (id) => ({ id, kind: "parse", job }),
          job.deadlineMs,
        ),
      ),

    async dispose() {
      stopped = true;
      for (const slot of slots) {
        const worker = slot.worker;
        if (slot.respawnTimer !== null) clearTimeout(slot.respawnTimer);
        slot.respawnTimer = null;
        drain(slot, { kind: "busy" });
        if (worker !== null) await worker.terminate();
      }
    },
  };
}
