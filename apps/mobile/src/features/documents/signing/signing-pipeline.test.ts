import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { createMutationAttempt } from "@showzy/contract";
import { ORPCError } from "@orpc/client";

import { createContractMutationController } from "../../../api/contract-mutation";
import { submitWithProtocolConfirmation } from "../../../api/protocol-confirm";
import { bindDocumentRequestSignMutate } from "../api/document-request-sign";
import { SIGNING_MIME_TYPE, SIGNING_PURPOSE } from "./signing-limits";
import {
  bannerFromQueryKind,
  createDocumentSigningAbort,
  mapSigningFailure,
  runDocumentSigning,
  SigningDigestMismatchError,
  SigningPasswordError,
  SigningUnavailableError,
  type DocumentSigningPorts,
  type SigningCompleteOutput,
} from "./signing-pipeline";
import type { SigningPhase } from "./signing-session";

const DOCUMENT_ID = "0f0e2d5c-4a1b-4c3d-9e8f-102938475601";
const REQUEST_ID = "1f0e2d5c-4a1b-4c3d-9e8f-102938475602";
const FILE_ID = "2f0e2d5c-4a1b-4c3d-9e8f-102938475603";
const PAYLOAD_SHA = "a".repeat(64);
const ASIC_SHA = "b".repeat(64);
const PAYLOAD_URL = "https://files.example.invalid/payload.pdf?token=secret";
const PUT_URL = "https://files.example.invalid/uploads/pending?token=put";
const PASSWORD = "key-password-once";

const PIPELINE_SOURCE = readFileSync(
  new URL("./signing-pipeline.ts", import.meta.url),
  "utf8",
);
const HOOK_SOURCE = readFileSync(
  new URL("./use-document-signing.ts", import.meta.url),
  "utf8",
);
const DEVICE_SOURCE = readFileSync(
  new URL("./document-signing-device.ts", import.meta.url),
  "utf8",
);
const SHEET_SOURCE = readFileSync(
  new URL("./document-signing-sheet.tsx", import.meta.url),
  "utf8",
);

function payloadBytes(): Uint8Array {
  return new TextEncoder().encode("%PDF-1.4 fixture");
}

function neverSettle<T>(): Promise<T> {
  return new Promise<T>(() => {
    return;
  });
}

function fakePorts(args: {
  readonly failAt?:
    | "start"
    | "download"
    | "inspect"
    | "digest"
    | "sign"
    | "request"
    | "put"
    | "complete";
  readonly hangAt?: "download" | "digest" | "sign" | "put";
  readonly digestMismatch?: boolean;
}): {
  readonly ports: DocumentSigningPorts;
  readonly calls: string[];
  readonly completeInputs: Array<{
    readonly requestId: string;
    readonly fileId: string;
  }>;
} {
  const calls: string[] = [];
  const completeInputs: Array<{
    readonly requestId: string;
    readonly fileId: string;
  }> = [];
  const payload = payloadBytes();
  const ports: DocumentSigningPorts = {
    start: () => {
      calls.push("start");
      if (args.failAt === "start") {
        return Promise.reject(new TypeError("Failed to fetch"));
      }
      return Promise.resolve({
        requestId: REQUEST_ID,
        payloadSha256: args.digestMismatch ? "c".repeat(64) : PAYLOAD_SHA,
        payloadDownloadUrl: PAYLOAD_URL,
      });
    },
    downloadPayload: (url) => {
      calls.push("download");
      expect(url).toBe(PAYLOAD_URL);
      if (args.failAt === "download") {
        return Promise.reject(new TypeError("Failed to fetch"));
      }
      if (args.hangAt === "download") {
        return neverSettle();
      }
      return Promise.resolve(payload);
    },
    sha256Hex: (bytes) => {
      if (bytes.byteLength === payload.byteLength) {
        return Promise.resolve(PAYLOAD_SHA);
      }
      return Promise.resolve(ASIC_SHA);
    },
    inspectKey: () => {
      calls.push("inspect");
      if (args.failAt === "inspect") {
        return Promise.reject(new SigningPasswordError());
      }
      return Promise.resolve({
        certAlgorithm: "1.2.804.2.1.1.1.1.3.1.1",
        certCommonName: "ФОП Тест",
      });
    },
    digestPayload: () => {
      calls.push("digest");
      if (args.failAt === "digest") {
        return Promise.reject(new TypeError("Failed to fetch"));
      }
      if (args.hangAt === "digest") {
        return neverSettle();
      }
      return Promise.resolve("ZGlnZXN0");
    },
    signManifest: ({ manifest }) => {
      calls.push("sign");
      expect(manifest.byteLength).toBeGreaterThan(0);
      if (args.failAt === "sign") {
        return Promise.reject(new TypeError("Failed to fetch"));
      }
      if (args.hangAt === "sign") {
        return neverSettle();
      }
      return Promise.resolve(new Uint8Array([0x30, 0x82, 0x01]));
    },
    requestSigningUpload: (input) => {
      calls.push("request");
      expect(input.purpose).toBe(SIGNING_PURPOSE);
      expect(input.mimeType).toBe(SIGNING_MIME_TYPE);
      expect(input.checksumSha256).toBe(ASIC_SHA);
      if (args.failAt === "request") {
        return Promise.reject(new TypeError("Failed to fetch"));
      }
      return Promise.resolve({ fileId: FILE_ID });
    },
    getSigningUploadUrl: () => {
      calls.push("getUrl");
      return Promise.resolve({ uploadUrl: PUT_URL });
    },
    putAsic: ({ uploadUrl }) => {
      calls.push("put");
      expect(uploadUrl).toBe(PUT_URL);
      if (args.failAt === "put") {
        return Promise.reject(new TypeError("Failed to fetch"));
      }
      if (args.hangAt === "put") {
        return neverSettle();
      }
      return Promise.resolve();
    },
    complete: (input) => {
      calls.push("complete");
      completeInputs.push(input);
      if (args.failAt === "complete") {
        return Promise.reject(new TypeError("Failed to fetch"));
      }
      return Promise.resolve({
        requestId: input.requestId,
        fileId: input.fileId,
        documentId: DOCUMENT_ID,
      });
    },
    createAttempt: () => createMutationAttempt(() => crypto.randomUUID()),
  };
  return { ports, calls, completeInputs };
}

function runArgs(
  ports: DocumentSigningPorts,
  signal: AbortSignal,
): Parameters<typeof runDocumentSigning>[0] {
  return {
    documentId: DOCUMENT_ID,
    keyBytes: new Uint8Array([0x30, 0x82]),
    password: PASSWORD,
    ports,
    signal,
    onPhase: () => {
      return;
    },
  };
}

describe("runDocumentSigning", () => {
  it("HITL then start → Nitro ports → handshake PUT → complete { requestId, fileId }", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {
      return;
    });
    const requestCalls: string[] = [];
    const requestSign = createContractMutationController<
      { documentId: string },
      { documentId: string }
    >({
      mutate: bindDocumentRequestSignMutate({
        client: {
          documents: {
            requestSign: (_input, options) => {
              const challenge = options.context.confirmationChallengeId;
              if (challenge === undefined) {
                requestCalls.push("submit");
                return Promise.reject(
                  new ORPCError("CONFIRMATION_REQUIRED", {
                    defined: true,
                    status: 409,
                    message: "Confirm.",
                    data: {
                      challenge: {
                        challengeId: "challenge-sign",
                        summary: "Request a qualified electronic signature.",
                        expiresAt: "2026-08-30T00:00:00.000Z",
                      },
                    },
                  }),
                );
              }
              requestCalls.push(challenge);
              return Promise.resolve({ documentId: DOCUMENT_ID });
            },
          },
        },
      }),
    });

    await submitWithProtocolConfirmation({
      submit: () => requestSign.submit({ documentId: DOCUMENT_ID }),
      present: () => Promise.resolve("confirm"),
      confirm: (challengeId) => requestSign.confirm(challengeId),
    });
    expect(requestCalls).toEqual(["submit", "challenge-sign"]);

    const { ports, calls, completeInputs } = fakePorts({});
    const phases: SigningPhase[] = [];
    const result: SigningCompleteOutput = await runDocumentSigning({
      ...runArgs(ports, new AbortController().signal),
      onPhase: (phase) => {
        phases.push(phase);
      },
    });

    expect(result).toEqual({
      requestId: REQUEST_ID,
      fileId: FILE_ID,
      documentId: DOCUMENT_ID,
    });
    expect(completeInputs).toEqual([
      { requestId: REQUEST_ID, fileId: FILE_ID },
    ]);
    expect(JSON.stringify(completeInputs[0])).not.toContain("bytes");
    expect(JSON.stringify(completeInputs[0])).not.toContain("base64");
    expect(calls).toEqual([
      "start",
      "download",
      "inspect",
      "digest",
      "sign",
      "request",
      "getUrl",
      "put",
      "complete",
    ]);
    expect(phases).toEqual([
      "starting",
      "downloading",
      "digesting",
      "signing",
      "uploading",
      "completing",
    ]);
    expect(JSON.stringify(phases)).not.toContain(PAYLOAD_URL);
    expect(JSON.stringify(phases)).not.toContain(PUT_URL);
    expect(JSON.stringify(phases)).not.toContain(PASSWORD);
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it("rejects a payload whose SHA-256 does not match the frozen digest", async () => {
    const { ports } = fakePorts({ digestMismatch: true });
    await expect(
      runDocumentSigning(runArgs(ports, new AbortController().signal)),
    ).rejects.toBeInstanceOf(SigningDigestMismatchError);
  });

  it("abort before complete never invokes complete", async () => {
    const abort = new AbortController();
    const { ports, calls, completeInputs } = fakePorts({ hangAt: "digest" });
    const running = runDocumentSigning(runArgs(ports, abort.signal));
    await vi.waitFor(() => {
      expect(calls).toContain("digest");
    });
    abort.abort();
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).not.toContain("complete");
    expect(calls).not.toContain("sign");
    expect(completeInputs).toEqual([]);
  });

  it("abort during PUT does not complete", async () => {
    const abort = new AbortController();
    const { ports, calls, completeInputs } = fakePorts({ hangAt: "put" });
    const running = runDocumentSigning(runArgs(ports, abort.signal));
    await vi.waitFor(() => {
      expect(calls).toContain("put");
    });
    abort.abort();
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toContain("put");
    expect(calls).not.toContain("complete");
    expect(completeInputs).toEqual([]);
  });

  it("does not invoke complete when abort wins after PUT resolves", async () => {
    const abort = new AbortController();
    const base = fakePorts({});
    const ports: DocumentSigningPorts = {
      ...base.ports,
      putAsic: async (putArgs) => {
        await base.ports.putAsic(putArgs);
        abort.abort();
      },
    };
    await expect(
      runDocumentSigning(runArgs(ports, abort.signal)),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(base.calls).toContain("put");
    expect(base.calls).not.toContain("complete");
    expect(base.completeInputs).toEqual([]);
  });

  it("closing the sheet aborts in-flight work", async () => {
    const handle = createDocumentSigningAbort();
    const signal = handle.begin();
    const { ports, calls, completeInputs } = fakePorts({
      hangAt: "download",
    });
    const running = runDocumentSigning(runArgs(ports, signal));
    await vi.waitFor(() => {
      expect(calls).toContain("download");
    });
    handle.abort();
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    expect(signal.aborted).toBe(true);
    expect(calls).not.toContain("complete");
    expect(calls).not.toContain("inspect");
    expect(completeInputs).toEqual([]);
  });
});

describe("sheet close abort wiring", () => {
  it("closeSheet and onSheetHidden abort the handle the pipeline runs on", () => {
    expect(HOOK_SOURCE).toContain("createDocumentSigningAbort");
    expect(HOOK_SOURCE).toMatch(
      /closeSheet:\s*\(\)\s*=>\s*\{[^}]*abortHandleRef\.current\.abort\(\)/,
    );
    expect(HOOK_SOURCE).toMatch(
      /onSheetHidden:\s*\(\)\s*=>\s*\{[^}]*abortHandleRef\.current\.abort\(\)/,
    );
    expect(HOOK_SOURCE).toContain("wipeKeyBytes");
    expect(HOOK_SOURCE).not.toContain("console.log");
  });

  it("pickKey wipes the previous key before holding another file", () => {
    expect(HOOK_SOURCE).toMatch(
      /wipeKeyBytes\(keyBytesRef\.current\);\s*keyBytesRef\.current = picked\.bytes/,
    );
  });

  it("deletes the Expo cache copy of the key and checks size before read", () => {
    expect(DEVICE_SOURCE).toContain("copyToCacheDirectory: true");
    expect(DEVICE_SOURCE).toContain("file.size");
    expect(DEVICE_SOURCE).toContain("file.delete");
    expect(DEVICE_SOURCE).toContain("assertSafeSigningUrl");
    expect(DEVICE_SOURCE).toContain("wrapSigningNetworkFailure");
    expect(DEVICE_SOURCE).toContain('phase: "temp-key-delete"');
    expect(DEVICE_SOURCE).toContain("__DEV__");
    expect(DEVICE_SOURCE).not.toContain("console.log");
    expect(DEVICE_SOURCE).not.toContain("file.uri");
  });

  it("does not race abort on complete once the ASiC PUT has landed", () => {
    expect(HOOK_SOURCE).toContain("complete() is not raced against abort");
    expect(PIPELINE_SOURCE).toContain(
      "complete() is deliberately not wrapped in raceSigningAbort",
    );
    expect(PIPELINE_SOURCE).toMatch(
      /return args\.ports\.complete\(\s*\{ requestId: started\.requestId, fileId: requested\.fileId \}/,
    );
    expect(PIPELINE_SOURCE).not.toMatch(
      /raceSigningAbort\(\s*args\.ports\.complete/,
    );
  });

  it("does not opt the QES password into iCloud Keychain autofill", () => {
    expect(SHEET_SOURCE).toContain('autoComplete="off"');
    expect(SHEET_SOURCE).toContain("secureTextEntry");
    expect(SHEET_SOURCE).not.toContain('autoComplete="password"');
  });
});

describe("mapSigningFailure", () => {
  it("maps password, native-unavailable, and digest mismatch without reading messages", () => {
    expect(mapSigningFailure(new SigningPasswordError())).toBe("password");
    expect(mapSigningFailure(new SigningUnavailableError())).toBe("native");
    expect(mapSigningFailure(new SigningDigestMismatchError())).toBe(
      "validation",
    );
    expect(bannerFromQueryKind("validation")).toBe("validation");
    expect(bannerFromQueryKind("network")).toBe("network");
  });
});
