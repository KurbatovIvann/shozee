import type { AuditTargetEnv } from "@showzy/core";
import { z } from "zod";

/** Catalog product audit type. Product stays `product`. */
export const PRODUCT_AUDIT_TYPE = "product";

/**
 * Catalog variant audit type. Create/update already used `variant`;
 * archive/restore used `product_variant`. SHO-285 unifies on `variant`.
 */
export const VARIANT_AUDIT_TYPE = "variant";

export type AuditTarget = {
  readonly type: string;
  readonly id: string;
};

export type AuditTargetSource = "output" | "resolved" | "input";

export type AuditTargetStep =
  | { readonly source: "resolved" }
  | {
      readonly source: "output" | "input";
      readonly schema: z.ZodType;
      readonly pick: (data: unknown) => string | undefined;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function pickString(field: string, data: unknown): string | undefined {
  if (!isRecord(data)) {
    return undefined;
  }
  const value = data[field];
  return typeof value === "string" ? value : undefined;
}

/**
 * When `field` is present and null, return `fallback` instead of
 * continuing (pricing `priceListId` → `none`).
 */
export function pickNullableStringOr(
  field: string,
  fallback: string,
  data: unknown,
): string | undefined {
  if (!isRecord(data)) {
    return undefined;
  }
  if (!(field in data)) {
    return undefined;
  }
  const value = data[field];
  if (typeof value === "string") {
    return value;
  }
  if (value === null) {
    return fallback;
  }
  return undefined;
}

export function createAuditTarget(options: {
  readonly type: string;
  readonly fallback: string;
  readonly steps: readonly AuditTargetStep[];
}): (env: AuditTargetEnv) => AuditTarget {
  return (env) => {
    for (const step of options.steps) {
      if (step.source === "resolved") {
        if (env.resolvedId !== undefined) {
          return { type: options.type, id: env.resolvedId };
        }
        continue;
      }
      const raw = step.source === "output" ? env.output : env.input;
      const parsed = step.schema.safeParse(raw);
      if (!parsed.success) {
        continue;
      }
      const id = step.pick(parsed.data);
      if (id === undefined) {
        continue;
      }
      return { type: options.type, id };
    }
    return { type: options.type, id: options.fallback };
  };
}

export function holderAuditTarget(options: {
  readonly type: string;
  readonly field: string;
  readonly fallback: string;
  readonly sources: readonly AuditTargetSource[];
}): (env: AuditTargetEnv) => AuditTarget {
  const schema = z.object({ [options.field]: z.string() });
  return createAuditTarget({
    type: options.type,
    fallback: options.fallback,
    steps: options.sources.map((source) =>
      source === "resolved"
        ? { source }
        : {
            source,
            schema,
            pick: (data) => pickString(options.field, data),
          },
    ),
  });
}
