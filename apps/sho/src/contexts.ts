import type { CompiledContext } from "@showzy/sho";
import type { ShoContext } from "@showzy/sho-protocol";

export const SHO_CONTEXT_CACHE_BYTES = 256 * 1024 * 1024;

export interface ShoContextEntry {
  readonly fingerprint: string;
  readonly revision: string | null;
  readonly compiled: CompiledContext;
  readonly phrases: readonly string[];
  readonly bytes: number;
}

export interface ShoContextCache {
  fresh(key: string, fingerprint: string): ShoContextEntry | null;
  held(key: string): ShoContextEntry | null;
  put(key: string, entry: ShoContextEntry): void;
  readonly keys: readonly string[];
  readonly bytes: number;
}

export function createShoContextCache(
  maxBytes: number = SHO_CONTEXT_CACHE_BYTES,
): ShoContextCache {
  const entries = new Map<string, ShoContextEntry>();
  let held = 0;

  function drop(key: string): void {
    const entry = entries.get(key);
    if (entry === undefined) return;
    entries.delete(key);
    held -= entry.bytes;
  }

  return {
    fresh(key, fingerprint) {
      const entry = entries.get(key);
      if (entry === undefined || entry.fingerprint !== fingerprint) return null;
      entries.delete(key);
      entries.set(key, entry);
      return entry;
    },
    held(key) {
      return entries.get(key) ?? null;
    },
    put(key, entry) {
      drop(key);
      entries.set(key, entry);
      held += entry.bytes;
      for (const oldest of [...entries.keys()]) {
        if (held <= maxBytes || entries.size <= 1) break;
        drop(oldest);
      }
    },
    get keys() {
      return [...entries.keys()];
    },
    get bytes() {
      return held;
    },
  };
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
