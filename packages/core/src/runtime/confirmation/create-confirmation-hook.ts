/**
 * `createConfirmationHook` — the fnd-T20 confirmation protocol (core.md §7).
 *
 * First invocation (no challenge token) runs after authorization preflight:
 * core calls `confirmationSummary`, stores a 5-minute challenge bound to
 * action / input hash / principal / company / idempotency key, and returns
 * `ConfirmationRequiredError` carrying only the redacted summary.
 *
 * Re-invocation with `{ challengeId }` consumes the challenge atomically
 * (`getAndDelete`). Bindings and the input hash are checked after consume
 * so a mismatched token is burned, never reusable. Any mismatch or expiry
 * issues a fresh challenge.
 *
 * Redis unavailability fails closed: high-risk execution does not proceed
 * (core.md §7). The consumed grant is returned to the pipeline so the
 * idempotency reservation can persist it for crash-safe resume (§5).
 */
import { randomUUID } from "node:crypto";

import { z } from "zod";

import {
  ConfirmationRequiredError,
  CoreError,
  CoreInvariantError,
  type ActionPreview,
  type ActionPreviewLine,
} from "../../errors/index.js";
import { canonicalJsonSha256OfUnknown } from "../audit/canonical-json.js";
import { principalKeyFor, requireIdempotencyKey } from "../idempotency/keys.js";
import type {
  ConfirmationChallengeSummary,
  ConfirmationGrant,
  ConfirmationHook,
  PipelineHookEnv,
  PreflightAuthorization,
} from "../pipeline/types.js";
import type { ConfirmationStore } from "./store.js";

/** Challenges expire 5 minutes after issuance (core.md §7). */
export const CONFIRMATION_TTL_MS = 5 * 60 * 1000;

const storedChallengeSchema = z.object({
  challengeId: z.uuid(),
  actionName: z.string().min(1),
  inputHash: z.string().min(1),
  previewHash: z.string().min(1).nullable(),
  principalKey: z.string().min(1),
  companyId: z.uuid().nullable(),
  idempotencyKey: z.string().min(1),
  expiresAt: z.string().min(1),
});

type StoredChallenge = z.infer<typeof storedChallengeSchema>;

export interface ConfirmationHookDeps {
  readonly store: ConfirmationStore;
  /** Clock override for tests; defaults to `Date.now`. */
  readonly now?: () => number;
}

type GateEnv = PipelineHookEnv & {
  readonly authorization: PreflightAuthorization;
  readonly summarize: () =>
    ConfirmationChallengeSummary | Promise<ConfirmationChallengeSummary>;
};

export function createConfirmationHook(
  deps: ConfirmationHookDeps,
): ConfirmationHook {
  const now = deps.now ?? Date.now;

  return {
    async gate(env) {
      const idempotencyKey = requireIdempotencyKey(env);
      const principalKey = principalKeyFor(env);
      const companyId = env.authorization.companyId;
      const inputHash = canonicalJsonSha256OfUnknown(env.input);
      const challengeId = env.request.confirmationChallengeId;
      const bindings = {
        inputHash,
        principalKey,
        companyId,
        idempotencyKey,
      };

      if (env.request.confirmationOnly === true) {
        return await issueChallenge(deps.store, now, env, bindings);
      }

      if (challengeId !== undefined && challengeId !== "") {
        const raw = await withStore(env.contract.name, () =>
          deps.store.getAndDelete(challengeKey(challengeId)),
        );
        const stored = parseChallenge(raw);
        const nowMs = now();
        if (
          stored !== undefined &&
          Date.parse(stored.expiresAt) > nowMs &&
          bindingsMatch(stored, env, {
            challengeId,
            ...bindings,
          })
        ) {
          const grant = {
            challengeId: stored.challengeId,
            confirmedAt: new Date(nowMs),
            expiresAt: new Date(stored.expiresAt),
          } satisfies ConfirmationGrant;
          if (stored.previewHash === null) {
            return grant;
          }
          const presented = await env.summarize();
          if (previewHashOf(presented) === stored.previewHash) {
            return grant;
          }
          return await issueChallenge(
            deps.store,
            now,
            env,
            bindings,
            presented,
          );
        }
      }

      return await issueChallenge(deps.store, now, env, bindings);
    },
  };
}

function challengeKey(challengeId: string): string {
  return `confirm:${challengeId}`;
}

function previewHashOf(card: ConfirmationChallengeSummary): string | null {
  return card.preview === undefined
    ? null
    : canonicalJsonSha256OfUnknown(canonicalPreview(card.preview));
}

type CanonicalPreview = Required<Omit<ActionPreview, "lines">> & {
  readonly lines: readonly Required<ActionPreviewLine>[];
};

function canonicalPreview(preview: ActionPreview): CanonicalPreview {
  return {
    title: preview.title,
    lines: preview.lines.map(canonicalPreviewLine),
    notes: preview.notes ?? [],
  };
}

function canonicalPreviewLine(
  line: ActionPreviewLine,
): Required<ActionPreviewLine> {
  return {
    label: line.label,
    value: line.value,
  };
}

function bindingsMatch(
  stored: StoredChallenge,
  env: GateEnv,
  expected: {
    readonly challengeId: string;
    readonly inputHash: string;
    readonly principalKey: string;
    readonly companyId: string | null;
    readonly idempotencyKey: string;
  },
): boolean {
  return (
    stored.challengeId === expected.challengeId &&
    stored.actionName === env.contract.name &&
    stored.inputHash === expected.inputHash &&
    stored.principalKey === expected.principalKey &&
    stored.companyId === expected.companyId &&
    stored.idempotencyKey === expected.idempotencyKey
  );
}

function parseChallenge(raw: string | null): StoredChallenge | undefined {
  if (raw === null) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
  const result = storedChallengeSchema.safeParse(parsed);
  return result.success ? result.data : undefined;
}

async function issueChallenge(
  store: ConfirmationStore,
  now: () => number,
  env: GateEnv,
  bindings: {
    readonly inputHash: string;
    readonly principalKey: string;
    readonly companyId: string | null;
    readonly idempotencyKey: string;
  },
  presented?: ConfirmationChallengeSummary,
): Promise<never> {
  const card = presented ?? (await env.summarize());
  const { summary, preview } = card;
  const challengeId = randomUUID();
  const expiresAt = new Date(now() + CONFIRMATION_TTL_MS);
  const record: StoredChallenge = {
    challengeId,
    actionName: env.contract.name,
    inputHash: bindings.inputHash,
    previewHash: previewHashOf(card),
    principalKey: bindings.principalKey,
    companyId: bindings.companyId,
    idempotencyKey: bindings.idempotencyKey,
    expiresAt: expiresAt.toISOString(),
  };
  await withStore(env.contract.name, () =>
    store.set(
      challengeKey(challengeId),
      JSON.stringify(record),
      CONFIRMATION_TTL_MS,
    ),
  );
  throw new ConfirmationRequiredError({
    challengeId,
    summary,
    expiresAt: expiresAt.toISOString(),
    ...(preview !== undefined ? { preview } : {}),
  });
}

/**
 * Store failures fail closed (core.md §7). Typed core errors (missing
 * idempotency key, the issued challenge itself) pass through.
 */
async function withStore<T>(
  actionName: string,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof CoreError) {
      throw error;
    }
    throw new CoreInvariantError(
      `confirmation store unavailable — failing closed for "${actionName}"`,
      { cause: error },
    );
  }
}
