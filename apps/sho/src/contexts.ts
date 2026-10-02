import type { CompiledContext } from "@showzy/sho";
import type { ShoContext } from "@showzy/sho-protocol";

export const SHO_CONTEXT_CACHE_UPLOAD_BYTES = 256 * 1024 * 1024;

export interface ShoContextEntry {
  readonly fingerprint: string;
  readonly revision: string | null;
  readonly compiled: CompiledContext;
  readonly phrases: readonly string[];
  readonly uploadBytes: number;
}

export interface ShoContextCache {
  read(key: string): ShoContextEntry | null;
  fresh(key: string, fingerprint: string): ShoContextEntry | null;
  put(key: string, entry: ShoContextEntry): void;
  readonly keys: readonly string[];
  readonly uploadBytes: number;
}

export function createShoContextCache(
  maxUploadBytes: number = SHO_CONTEXT_CACHE_UPLOAD_BYTES,
): ShoContextCache {
  const entries = new Map<string, ShoContextEntry>();
  let held = 0;

  function drop(key: string): void {
    const entry = entries.get(key);
    if (entry === undefined) return;
    entries.delete(key);
    held -= entry.uploadBytes;
  }

  const cache: ShoContextCache = {
    read(key) {
      const entry = entries.get(key);
      if (entry === undefined) return null;
      entries.delete(key);
      entries.set(key, entry);
      return entry;
    },
    fresh(key, fingerprint) {
      const entry = cache.read(key);
      return entry === null || entry.fingerprint !== fingerprint ? null : entry;
    },
    put(key, entry) {
      drop(key);
      entries.set(key, entry);
      held += entry.uploadBytes;
      for (const oldest of [...entries.keys()]) {
        if (held <= maxUploadBytes || entries.size <= 1) break;
        drop(oldest);
      }
    },
    get keys() {
      return [...entries.keys()];
    },
    get uploadBytes() {
      return held;
    },
  };

  return cache;
}

export function shoContextPhrases(context: ShoContext): readonly string[] {
  const found = new Set<string>();
  for (const product of context.products ?? []) {
    found.add(product.name);
    for (const variant of product.variants ?? []) found.add(variant.name);
  }
  for (const customer of context.customers ?? []) found.add(customer.name);
  return [...found];
}
