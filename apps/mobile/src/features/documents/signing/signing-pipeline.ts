/**
 * On-device QES pipeline (SHO-260). Ports keep Nitro / fetch / PUT out of
 * Vitest. AbortSignal is honored on download, digest, Nitro sign/pack,
 * handshake PUT, and immediately before `docSigning.complete` — dismiss
 * must not sign in the background. Complete input is `{ requestId, fileId }`
 * only — never ASiC bytes or base64. Signed URLs, key bytes, and passwords
 * never live on returned state.
 */
import type { MutationAttempt, MutationCallOptions } from "@showzy/contract";

import { writeFailureIsSilent } from "../../../api/classify-write-failure";
import {
  describeQueryFailure,
  type QueryFailureKind,
} from "../../../api/errors";
import {
  hashOidForCertAlgorithm,
  xmlDigestUriForHashOid,
} from "./signing-algorithms";
import {
  buildAsicManifestXml,
  packSignedAsicE,
  SigningAsicPackError,
} from "./signing-asic-pack";
import {
  MAX_SIGNING_BYTES,
  SIGNING_MIME_TYPE,
  SIGNING_PAYLOAD_NAME,
  SIGNING_PURPOSE,
} from "./signing-limits";
import type { SigningBannerKey, SigningPhase } from "./signing-session";

export class SigningPasswordError extends Error {
  constructor() {
    super("password");
    this.name = "SigningPasswordError";
  }
}

export class SigningUnavailableError extends Error {
  constructor() {
    super("native");
    this.name = "SigningUnavailableError";
  }
}

export class SigningDigestMismatchError extends Error {
  constructor() {
    super("validation");
    this.name = "SigningDigestMismatchError";
  }
}

export type SigningStartOutput = {
  readonly requestId: string;
  readonly payloadSha256: string;
  readonly payloadDownloadUrl: string;
};

export type SigningCompleteOutput = {
  readonly requestId: string;
  readonly fileId: string;
  readonly documentId: string;
};

export type DocumentSigningPorts = {
  readonly start: (
    input: { readonly documentId: string },
    options: MutationCallOptions,
  ) => Promise<SigningStartOutput>;
  readonly downloadPayload: (
    url: string,
    signal: AbortSignal,
  ) => Promise<Uint8Array>;
  readonly sha256Hex: (bytes: Uint8Array) => Promise<string>;
  readonly inspectKey: (args: {
    readonly keyBytes: Uint8Array;
    readonly password: string;
  }) => Promise<{
    readonly certAlgorithm: string;
    readonly certCommonName: string;
  }>;
  readonly digestPayload: (
    bytes: Uint8Array,
    hashOid: string,
  ) => Promise<string>;
  readonly signManifest: (args: {
    readonly keyBytes: Uint8Array;
    readonly password: string;
    readonly manifest: Uint8Array;
  }) => Promise<Uint8Array>;
  readonly requestSigningUpload: (
    input: {
      readonly purpose: typeof SIGNING_PURPOSE;
      readonly mimeType: typeof SIGNING_MIME_TYPE;
      readonly byteSize: number;
      readonly checksumSha256: string;
    },
    options: MutationCallOptions,
  ) => Promise<{ readonly fileId: string }>;
  readonly getSigningUploadUrl: (input: {
    readonly fileId: string;
  }) => Promise<{ readonly uploadUrl: string }>;
  readonly putAsic: (args: {
    readonly bytes: Uint8Array;
    readonly uploadUrl: string;
    readonly mimeType: typeof SIGNING_MIME_TYPE;
    readonly signal: AbortSignal;
  }) => Promise<void>;
  readonly complete: (
    input: { readonly requestId: string; readonly fileId: string },
    options: MutationCallOptions,
  ) => Promise<SigningCompleteOutput>;
  readonly createAttempt: () => MutationAttempt;
};

export type RunDocumentSigningArgs = {
  readonly documentId: string;
  readonly keyBytes: Uint8Array;
  readonly password: string;
  readonly ports: DocumentSigningPorts;
  readonly signal: AbortSignal;
  readonly onPhase: (phase: SigningPhase) => void;
};

function signingAbortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) {
    return reason;
  }
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

export function throwIfSigningAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signingAbortError(signal);
  }
}

export async function raceSigningAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  throwIfSigningAborted(signal);
  let onAbort: (() => void) | undefined;
  try {
    const value = await new Promise<T>((resolve, reject) => {
      onAbort = () => {
        reject(signingAbortError(signal));
      };
      signal.addEventListener("abort", onAbort);
      promise.then(resolve, reject);
    });
    throwIfSigningAborted(signal);
    return value;
  } finally {
    if (onAbort !== undefined) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

export function createDocumentSigningAbort(): {
  readonly begin: () => AbortSignal;
  readonly abort: () => void;
} {
  let controller: AbortController | null = null;
  return {
    begin: () => {
      controller = new AbortController();
      return controller.signal;
    },
    abort: () => {
      controller?.abort();
    },
  };
}

export function mapSigningFailure(error: unknown): SigningBannerKey {
  if (error instanceof SigningPasswordError) {
    return "password";
  }
  if (error instanceof SigningUnavailableError) {
    return "native";
  }
  if (
    error instanceof SigningDigestMismatchError ||
    error instanceof SigningAsicPackError
  ) {
    return "validation";
  }
  return bannerFromQueryKind(describeQueryFailure(error).kind) ?? "unavailable";
}

export function bannerFromQueryKind(
  kind: QueryFailureKind,
): SigningBannerKey | null {
  if (writeFailureIsSilent(kind)) {
    return null;
  }
  switch (kind) {
    case "offline":
      return "offline";
    case "network":
      return "network";
    case "permission":
      return "permission";
    case "validation":
      return "validation";
    default:
      return "unavailable";
  }
}

export async function runDocumentSigning(
  args: RunDocumentSigningArgs,
): Promise<SigningCompleteOutput> {
  throwIfSigningAborted(args.signal);
  args.onPhase("starting");
  const startAttempt = args.ports.createAttempt();
  const started = await raceSigningAbort(
    args.ports.start({ documentId: args.documentId }, startAttempt.options),
    args.signal,
  );

  args.onPhase("downloading");
  const payload = await raceSigningAbort(
    args.ports.downloadPayload(started.payloadDownloadUrl, args.signal),
    args.signal,
  );
  if (payload.byteLength < 1 || payload.byteLength > MAX_SIGNING_BYTES) {
    throw new SigningAsicPackError("payload");
  }
  const actualDigest = await raceSigningAbort(
    args.ports.sha256Hex(payload),
    args.signal,
  );
  if (actualDigest !== started.payloadSha256) {
    throw new SigningDigestMismatchError();
  }

  args.onPhase("digesting");
  const inspected = await raceSigningAbort(
    args.ports.inspectKey({
      keyBytes: args.keyBytes,
      password: args.password,
    }),
    args.signal,
  );
  const hashOid = hashOidForCertAlgorithm(inspected.certAlgorithm);
  const digestB64 = await raceSigningAbort(
    args.ports.digestPayload(payload, hashOid),
    args.signal,
  );
  const digestUri = xmlDigestUriForHashOid(hashOid);

  args.onPhase("signing");
  const manifestBytes = new TextEncoder().encode(
    buildAsicManifestXml({
      payloadName: SIGNING_PAYLOAD_NAME,
      digestUri,
      digestB64,
    }),
  );
  const signature = await raceSigningAbort(
    args.ports.signManifest({
      keyBytes: args.keyBytes,
      password: args.password,
      manifest: manifestBytes,
    }),
    args.signal,
  );

  throwIfSigningAborted(args.signal);
  const asic = packSignedAsicE({
    payload,
    digestUri,
    digestB64,
    signature,
  });
  const checksumSha256 = await raceSigningAbort(
    args.ports.sha256Hex(asic),
    args.signal,
  );

  args.onPhase("uploading");
  const uploadAttempt = args.ports.createAttempt();
  const requested = await raceSigningAbort(
    args.ports.requestSigningUpload(
      {
        purpose: SIGNING_PURPOSE,
        mimeType: SIGNING_MIME_TYPE,
        byteSize: asic.byteLength,
        checksumSha256,
      },
      uploadAttempt.options,
    ),
    args.signal,
  );
  const signedPut = await raceSigningAbort(
    args.ports.getSigningUploadUrl({
      fileId: requested.fileId,
    }),
    args.signal,
  );
  await raceSigningAbort(
    args.ports.putAsic({
      bytes: asic,
      uploadUrl: signedPut.uploadUrl,
      mimeType: SIGNING_MIME_TYPE,
      signal: args.signal,
    }),
    args.signal,
  );

  throwIfSigningAborted(args.signal);
  args.onPhase("completing");
  throwIfSigningAborted(args.signal);
  const completeAttempt = args.ports.createAttempt();
  throwIfSigningAborted(args.signal);
  // complete() is deliberately not wrapped in raceSigningAbort. The
  // ASiC PUT already landed; aborting the complete RPC would leave
  // server signing half-applied. throwIfSigningAborted above still
  // skips the call when the sheet closed first. Do not "fix" this by
  // racing abort on complete.
  return args.ports.complete(
    { requestId: started.requestId, fileId: requested.fileId },
    completeAttempt.options,
  );
}
