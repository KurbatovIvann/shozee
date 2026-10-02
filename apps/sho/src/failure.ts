import { InputError } from "@showzy/sho";

import type { ShoFailureDetail, ShoReply } from "./engine.ts";

export const SHO_FAILURE_DETAIL_LIMIT = 2_000;

const FRAME = /^at\s.+:\d+:\d+\)?$/;

export interface ShoFailureAnswer {
  readonly reply: Extract<ShoReply, { kind: "input" | "failed" }>;
  readonly detail: ShoFailureDetail | undefined;
}

function capped(value: string): string {
  return value.length <= SHO_FAILURE_DETAIL_LIMIT
    ? value
    : `${value.slice(0, SHO_FAILURE_DETAIL_LIMIT - 1)}…`;
}

function framesOf(stack: string | undefined): string | null {
  if (stack === undefined) return null;
  const frames = stack
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => FRAME.test(line));
  return frames.length === 0 ? null : capped(frames.join("\n"));
}

export function shoFailureOf(cause: unknown): ShoFailureAnswer {
  if (cause instanceof InputError) {
    return { reply: { kind: "input" }, detail: undefined };
  }
  if (cause instanceof Error) {
    return {
      reply: { kind: "failed", code: cause.name },
      detail: { frames: framesOf(cause.stack) },
    };
  }
  return {
    reply: { kind: "failed", code: "unknown" },
    detail: { frames: null },
  };
}
