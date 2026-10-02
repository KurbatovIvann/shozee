import { InputError } from "@showzy/sho";

import type { ShoFailureDetail, ShoReply } from "./engine.ts";

export const SHO_FAILURE_DETAIL_LIMIT = 2_000;

export interface ShoFailureAnswer {
  readonly reply: Extract<ShoReply, { kind: "input" | "failed" }>;
  readonly detail: ShoFailureDetail | undefined;
}

function capped(value: string): string {
  return value.length <= SHO_FAILURE_DETAIL_LIMIT
    ? value
    : `${value.slice(0, SHO_FAILURE_DETAIL_LIMIT)}…`;
}

export function shoFailureOf(cause: unknown): ShoFailureAnswer {
  if (cause instanceof InputError) {
    return { reply: { kind: "input" }, detail: undefined };
  }
  if (cause instanceof Error) {
    return {
      reply: { kind: "failed", code: cause.name },
      detail: {
        message: capped(cause.message),
        stack: cause.stack === undefined ? null : capped(cause.stack),
      },
    };
  }
  return {
    reply: { kind: "failed", code: "unknown" },
    detail: { message: capped(String(cause)), stack: null },
  };
}
