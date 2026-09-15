import { moduleOf } from "../../contract/module-of.js";
import type { Job } from "../../jobs/define-job.js";
import { canonicalJsonSha256OfUnknown } from "../audit/canonical-json.js";
import {
  principalKeyFor,
  requireIdempotencyKey,
  scopeKeyFor,
  type ProtocolIdentityEnv,
} from "../idempotency/keys.js";

export type JobOrigin =
  | {
      readonly kind: "idempotency";
      readonly principalKey: string;
      readonly scopeKey: string;
      readonly action: string;
      readonly idempotencyKey: string;
    }
  | { readonly kind: "execution"; readonly executionId: string };

export function jobOriginFor(env: {
  readonly executionId: string;
  readonly reservedIdentity: ProtocolIdentityEnv | undefined;
}): JobOrigin {
  const identity = env.reservedIdentity;
  if (identity === undefined) {
    return { kind: "execution", executionId: env.executionId };
  }
  const principalKey = principalKeyFor(identity);
  return {
    kind: "idempotency",
    principalKey,
    scopeKey: scopeKeyFor(identity, principalKey),
    action: identity.contract.name,
    idempotencyKey: requireIdempotencyKey(identity),
  };
}

export function jobDiscriminatorValues(
  job: Job,
  payload: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    job.discriminator.map((key) => [key, payload[key]]),
  );
}

export function deriveJobId(parts: {
  readonly job: Job;
  readonly companyId: string | null;
  readonly origin: JobOrigin;
  readonly payload: Readonly<Record<string, unknown>>;
}): string {
  const bytes = Buffer.from(
    canonicalJsonSha256OfUnknown({
      module: moduleOf(parts.job.name),
      job: parts.job.name,
      companyId: parts.companyId,
      origin: parts.origin,
      discriminator: jobDiscriminatorValues(parts.job, parts.payload),
    }),
    "hex",
  ).subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x80;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
