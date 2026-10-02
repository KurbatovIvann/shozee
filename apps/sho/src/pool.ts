import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";

import {
  ShoRunFailure,
  type ShoEngine,
  type ShoSlotReply,
  type ShoWorkerCommand,
  type ShoWorkerReady,
  type ShoWorkerReply,
} from "./engine.ts";

export const SHO_QUEUE_LIMIT = 8;
export const SHO_CALL_TIMEOUT_MS = 30_000;

export const shoDefaultWorkers = (): number =>
  Math.max(availableParallelism() - 1, 1);

export function shoSlotOf(key: string, size: number): number {
  let hash = 2166136261;
  for (let at = 0; at < key.length; at += 1) {
    hash = Math.imul(hash ^ key.charCodeAt(at), 16777619);
  }
  return (hash >>> 0) % size;
}

export type ShoWorkerLoss = "crashed" | "hung";

export interface ShoPoolOptions {
  readonly size?: number;
  readonly queueLimit?: number;
  readonly callTimeoutMs?: number;
  readonly workerUrl?: URL;
  readonly onLoss?: (slot: number, loss: ShoWorkerLoss) => void;
}

interface Pending {
  readonly command: ShoWorkerCommand;
  readonly settle: (reply: ShoSlotReply) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

interface Slot {
  readonly index: number;
  worker: Worker | null;
  ready: boolean;
  running: Pending | null;
  readonly queue: Pending[];
}

export async function createShoPool(
  options: ShoPoolOptions = {},
): Promise<ShoEngine> {
  const size = Math.max(options.size ?? shoDefaultWorkers(), 1);
  const queueLimit = options.queueLimit ?? SHO_QUEUE_LIMIT;
  const callTimeoutMs = options.callTimeoutMs ?? SHO_CALL_TIMEOUT_MS;
  const workerUrl =
    options.workerUrl ?? new URL("./worker.ts", import.meta.url);
  const onLoss = options.onLoss ?? ((): void => undefined);

  const slots: Slot[] = [];
  let stopped = false;
  let booting = true;
  let nextId = 1;

  function finish(pending: Pending, reply: ShoSlotReply): void {
    if (pending.timer !== null) {
      clearTimeout(pending.timer);
      pending.timer = null;
    }
    pending.settle(reply);
  }

  function pump(slot: Slot): void {
    const worker = slot.worker;
    if (worker === null || !slot.ready || slot.running !== null) return;
    const next = slot.queue.shift();
    if (next === undefined) return;
    slot.running = next;
    worker.postMessage(next.command);
  }

  function lose(slot: Slot, loss: ShoWorkerLoss): void {
    const victim = slot.worker;
    const running = slot.running;
    const waiting = slot.queue.splice(0, slot.queue.length);
    slot.worker = null;
    slot.ready = false;
    slot.running = null;
    if (running !== null) {
      finish(running, {
        id: running.command.id,
        kind: loss === "hung" ? "deadline" : "busy",
      });
    }
    for (const pending of waiting) {
      finish(pending, { id: pending.command.id, kind: "busy" });
    }
    if (victim !== null) void victim.terminate();
    onLoss(slot.index, loss);
    if (!stopped && !booting) spawn(slot, null);
  }

  function spawn(
    slot: Slot,
    boot: {
      resolve: (ready: ShoWorkerReady) => void;
      reject: (cause: Error) => void;
    } | null,
  ): void {
    const worker = new Worker(workerUrl);
    slot.worker = worker;
    slot.ready = false;
    worker.on("message", (reply: ShoWorkerReady | ShoWorkerReply) => {
      if (slot.worker !== worker) return;
      if (reply.kind === "ready") {
        slot.ready = true;
        boot?.resolve(reply);
        pump(slot);
        return;
      }
      const running = slot.running;
      if (running === null || running.command.id !== reply.id) return;
      slot.running = null;
      finish(running, reply);
      pump(slot);
    });
    worker.on("error", (cause: Error) => {
      if (slot.worker !== worker) return;
      boot?.reject(cause);
      lose(slot, "crashed");
    });
    worker.on("exit", () => {
      if (slot.worker !== worker) return;
      lose(slot, "crashed");
    });
  }

  function send(
    key: string,
    make: (id: number) => ShoWorkerCommand,
    timeoutMs: number,
  ): Promise<ShoSlotReply> {
    const id = nextId;
    nextId += 1;
    const slot = slots[shoSlotOf(key, size)];
    if (slot === undefined || stopped || !slot.ready) {
      return Promise.resolve({ id, kind: "busy" });
    }
    if (slot.queue.length + (slot.running === null ? 0 : 1) >= queueLimit) {
      return Promise.resolve({ id, kind: "busy" });
    }
    return new Promise<ShoSlotReply>((resolve) => {
      const pending: Pending = {
        command: make(id),
        settle: resolve,
        timer: null,
      };
      pending.timer = setTimeout(
        () => {
          pending.timer = null;
          if (slot.running === pending) {
            lose(slot, "hung");
            return;
          }
          const at = slot.queue.indexOf(pending);
          if (at >= 0) slot.queue.splice(at, 1);
          resolve({ id, kind: "deadline" });
        },
        Math.max(timeoutMs, 0),
      );
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
  if (first === undefined) throw new ShoRunFailure("sho pool has no workers");

  return {
    stamp: first.stamp,
    actions: first.actions,
    workers: size,

    async store(upload) {
      const reply = await send(
        upload.key,
        (id) => ({ id, kind: "store", upload }),
        callTimeoutMs,
      );
      if (reply.kind === "stored") return { kind: "stored" };
      if (reply.kind === "input") return { kind: "input" };
      if (reply.kind === "failed") {
        return { kind: "failed", message: reply.message };
      }
      return { kind: "busy" };
    },

    async phrases(key) {
      const reply = await send(
        key,
        (id) => ({ id, kind: "phrases", key }),
        callTimeoutMs,
      );
      return reply.kind === "phrases" ? reply.phrases : null;
    },

    async run(job) {
      const reply = await send(
        job.key,
        (id) => ({ id, kind: "parse", job }),
        job.deadlineMs,
      );
      switch (reply.kind) {
        case "parsed":
          return {
            kind: "ok",
            result: reply.result,
            contextRevision: reply.contextRevision,
            ms: reply.ms,
          };
        case "context_required":
          return { kind: "context_required" };
        case "deadline":
          return { kind: "deadline" };
        case "input":
          return { kind: "input" };
        case "failed":
          return { kind: "failed", message: reply.message };
        default:
          return { kind: "busy" };
      }
    },

    async dispose() {
      stopped = true;
      for (const slot of slots) {
        const worker = slot.worker;
        const running = slot.running;
        const waiting = slot.queue.splice(0, slot.queue.length);
        slot.worker = null;
        slot.ready = false;
        slot.running = null;
        if (running !== null) {
          finish(running, { id: running.command.id, kind: "busy" });
        }
        for (const pending of waiting) {
          finish(pending, { id: pending.command.id, kind: "busy" });
        }
        if (worker !== null) await worker.terminate();
      }
    },
  };
}
