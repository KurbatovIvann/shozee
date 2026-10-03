import type { ModelMessage } from "@showzy/assistant-kit";
import { foldNameWords } from "@showzy/module-kit/name-match";
import {
  shoBlockingNeeds,
  type ShoCommand,
  type ShoNeedReason,
  type ShoRefStatus,
} from "@showzy/sho-protocol";
import { z } from "zod";

import {
  shoCommandRefs,
  shoLoggedTurns,
  shoLogPart,
  SHO_LOG_NAMESPACE,
} from "./sho-focus.js";

export const SHO_ESCALATION_FIELD = "escalation";

export const SHO_MOST_GAPS = 4;

export const SHO_GAP_WHYS = ["missing", "ambiguous", "unknown"] as const;

export const SHO_TRAP_KINDS = ["repeat-gap", "repeat-text"] as const;

export type ShoGapWhy = (typeof SHO_GAP_WHYS)[number];

export type ShoTrapKind = (typeof SHO_TRAP_KINDS)[number];

export const shoGapSchema = z.object({
  path: z.string(),
  why: z.enum(SHO_GAP_WHYS),
});

export const shoEscalationSchema = z.object({
  reason: z.string(),
  gaps: z.array(shoGapSchema),
  trap: z.enum(SHO_TRAP_KINDS).optional(),
  sessionId: z.string(),
  at: z.string(),
});

export type ShoGap = z.infer<typeof shoGapSchema>;

export type ShoEscalation = z.infer<typeof shoEscalationSchema>;

export interface ShoStuck {
  readonly trap: ShoTrapKind;
  readonly gaps: readonly ShoGap[];
}

const NEED_WHY: Partial<Record<ShoNeedReason, ShoGapWhy>> = {
  ambiguous: "ambiguous",
  unknown: "unknown",
  unknown_attr: "unknown",
};

const REF_WHY: Partial<Record<ShoRefStatus, ShoGapWhy>> = {
  ambiguous: "ambiguous",
  unknown: "unknown",
  unchecked: "missing",
};

function gapInto(
  gaps: ShoGap[],
  held: Set<string>,
  path: string,
  why: ShoGapWhy,
): void {
  if (path.length === 0 || held.has(path) || gaps.length === SHO_MOST_GAPS) {
    return;
  }
  held.add(path);
  gaps.push({ path, why });
}

export function shoGapsOf(command: ShoCommand): readonly ShoGap[] {
  const gaps: ShoGap[] = [];
  const held = new Set<string>();
  for (const need of shoBlockingNeeds(command)) {
    gapInto(gaps, held, need.path, NEED_WHY[need.reason] ?? "missing");
  }
  for (const { slot, ref } of shoCommandRefs(command)) {
    const why = REF_WHY[ref.status];
    if (why !== undefined) {
      gapInto(gaps, held, slot, why);
    }
  }
  return gaps;
}

export function shoEscalationOptions(escalation: ShoEscalation): {
  readonly [SHO_LOG_NAMESPACE]: { readonly [SHO_ESCALATION_FIELD]: string };
} {
  return {
    [SHO_LOG_NAMESPACE]: { [SHO_ESCALATION_FIELD]: JSON.stringify(escalation) },
  };
}

export function shoEscalationIn(message: ModelMessage): ShoEscalation | null {
  const parsed = shoEscalationSchema.safeParse(
    shoLogPart(message, SHO_ESCALATION_FIELD),
  );
  return parsed.success ? parsed.data : null;
}

export function shoEscalationOf(input: {
  readonly reason: string;
  readonly sessionId: string;
  readonly now: Date;
  readonly gaps?: readonly ShoGap[];
  readonly trap?: ShoTrapKind;
}): ShoEscalation {
  return {
    reason: input.reason,
    gaps: [...(input.gaps ?? [])],
    ...(input.trap === undefined ? {} : { trap: input.trap }),
    sessionId: input.sessionId,
    at: input.now.toISOString(),
  };
}

export function shoEscalationNote(stuck: ShoStuck): string {
  if (stuck.trap === "repeat-text") {
    return "[Шо] The staff member just repeated a request that the previous turn did not finish. Do not ask the question that was already asked — take a different route to the same job.";
  }
  const named = stuck.gaps.map((gap) => gap.path).join(", ");
  return `[Шо] Already asked twice and still unresolved: ${named}. Do not raise the same card a third time — ask for it in plain words or offer another way to finish the job.`;
}

export function shoEscalatedAskedMessage(
  text: string,
  escalation: ShoEscalation,
): ModelMessage {
  const trap = escalation.trap;
  return {
    role: "user",
    providerOptions: shoEscalationOptions(escalation),
    content:
      trap === undefined
        ? text
        : [
            { type: "text", text },
            {
              type: "text",
              text: shoEscalationNote({ trap, gaps: escalation.gaps }),
            },
          ],
  };
}

interface Said {
  readonly index: number;
  readonly text: string;
  readonly escalation: ShoEscalation | null;
}

function saidIn(message: ModelMessage): string | null {
  if (message.role !== "user") {
    return null;
  }
  const content = message.content;
  if (typeof content === "string") {
    return content;
  }
  for (const part of content) {
    if (part.type === "text") {
      return part.text;
    }
  }
  return null;
}

function newestSaid(history: readonly ModelMessage[]): Said | null {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index];
    if (message === undefined) {
      continue;
    }
    const text = saidIn(message);
    if (text !== null) {
      return { index, text, escalation: shoEscalationIn(message) };
    }
  }
  return null;
}

interface Asked {
  readonly index: number;
  readonly gaps: readonly ShoGap[];
}

function thisSitting(
  history: readonly ModelMessage[],
  sessionId: string,
): ReturnType<typeof shoLoggedTurns> {
  return shoLoggedTurns(history).filter(
    (turn) => turn.log.sessionId === sessionId,
  );
}

function askedGaps(
  history: readonly ModelMessage[],
  sessionId: string,
): readonly Asked[] {
  const asked: Asked[] = [];
  for (const { log, index } of thisSitting(history, sessionId)) {
    const gaps = shoGapsOf(log.command);
    if (gaps.length > 0) {
      asked.push({ index, gaps });
    }
  }
  for (const [index, message] of history.entries()) {
    const escalation = shoEscalationIn(message);
    if (
      escalation === null ||
      escalation.sessionId !== sessionId ||
      escalation.gaps.length === 0
    ) {
      continue;
    }
    asked.push({ index, gaps: escalation.gaps });
  }
  return asked.sort((one, other) => other.index - one.index);
}

export function shoOpenGaps(
  history: readonly ModelMessage[],
  sessionId: string,
): readonly ShoGap[] {
  return askedGaps(history, sessionId)[0]?.gaps ?? [];
}

function sameWords(one: string, other: string): boolean {
  const said = foldNameWords(one);
  const again = foldNameWords(other);
  return (
    said.length > 0 &&
    said.length === again.length &&
    said.every((word, at) => word === again[at])
  );
}

export function shoStuckOnRepeatedText(input: {
  readonly history: readonly ModelMessage[];
  readonly sessionId: string;
  readonly text: string;
}): ShoStuck | null {
  const said = newestSaid(input.history);
  if (said === null || !sameWords(said.text, input.text)) {
    return null;
  }
  const since = thisSitting(input.history, input.sessionId).filter(
    (turn) => turn.index > said.index,
  );
  if (since.some((turn) => !turn.paused)) {
    return null;
  }
  const unfinished =
    since.length > 0 ||
    (said.escalation !== null && said.escalation.sessionId === input.sessionId);
  return unfinished
    ? {
        trap: "repeat-text",
        gaps: shoOpenGaps(input.history, input.sessionId),
      }
    : null;
}

export function shoStuckOnRepeatedGap(input: {
  readonly history: readonly ModelMessage[];
  readonly sessionId: string;
  readonly gaps: readonly ShoGap[];
}): ShoStuck | null {
  const [newest, before] = askedGaps(input.history, input.sessionId);
  if (newest === undefined || before === undefined) {
    return null;
  }
  const earlier = new Set(before.gaps.map((gap) => gap.path));
  const twice = new Set(
    newest.gaps.filter((gap) => earlier.has(gap.path)).map((gap) => gap.path),
  );
  const repeated = input.gaps.filter((gap) => twice.has(gap.path));
  return repeated.length === 0 ? null : { trap: "repeat-gap", gaps: repeated };
}
