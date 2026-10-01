import { useQueryClient } from "@tanstack/react-query";
import { useReducer, useRef, useState } from "react";

import { useApiClient } from "../../../api/api-provider";
import { apiUrlFromEnv } from "../../../api/config";
import { useContractMutation } from "../../../api/contract-mutation";
import { describeQueryFailure } from "../../../api/errors";
import { submitWithProtocolConfirmation } from "../../../api/protocol-confirm";
import { useActiveCompany } from "../../../api/query-provider";
import { useConfirmationCard } from "../../../components/ui/confirmation-card-host";
import { createMobileMutationAttempt } from "../../../crypto/create-attempt";
import type { DocumentsCopy } from "../../../i18n/documents";
import { bindDocumentRequestSignMutate } from "../api/document-request-sign";
import { invalidateDocumentsAfterWrite } from "../api/document-writes";
import {
  downloadSigningPayload,
  pickSigningKey,
  putSigningAsic,
  sha256Hex,
} from "./document-signing-device";
import { createDocumentSigningEngine } from "./document-signing-runtime";
import { pkiProxyUrl } from "./pki-proxy-url";
import { wipeKeyBytes } from "./signing-key";
import {
  bannerFromQueryKind,
  createDocumentSigningAbort,
  mapSigningFailure,
  raceSigningAbort,
  runDocumentSigning,
  type DocumentSigningPorts,
} from "./signing-pipeline";
import {
  IDLE_SIGNING_SESSION,
  reduceSigningSession,
  signingSessionBlocksNewRequest,
  signingSessionCanSubmit,
  signingSessionIsBusy,
} from "./signing-session";

export type DocumentSigningTarget = {
  readonly id: string;
  readonly documentNumber: string;
};

/**
 * Metro-only breadcrumb mirroring `[showzy/rpc]`. Never logs key bytes,
 * passwords, or signed URLs — only the phase and the error name/message
 * (network errors are already stripped to "Failed to fetch").
 */
function logSigningFailure(phase: string, error: unknown): void {
  if (!__DEV__) {
    return;
  }
  console.warn("[showzy/signing]", {
    phase,
    name: error instanceof Error ? error.name : typeof error,
    message: error instanceof Error ? error.message : String(error),
  });
}

export function useDocumentSigning(args: {
  readonly copy: DocumentsCopy;
  readonly canEdit: boolean;
}) {
  const presentCard = useConfirmationCard();
  const apiClient = useApiClient();
  const apiRef = useRef(apiClient);
  apiRef.current = apiClient;
  const { activeCompanyId } = useActiveCompany();
  const queryClient = useQueryClient();
  const [session, dispatch] = useReducer(
    reduceSigningSession,
    IDLE_SIGNING_SESSION,
  );
  const keyBytesRef = useRef<Uint8Array | null>(null);
  const abortHandleRef = useRef(createDocumentSigningAbort());
  const hitlBusyRef = useRef(false);
  const [hitlBanner, setHitlBanner] = useState<string | null>(null);

  const requestSignMutation = useContractMutation(
    (input: { documentId: string }, options) => {
      const current = apiRef.current;
      if (current === null) {
        return Promise.reject(new TypeError("Failed to fetch"));
      }
      return bindDocumentRequestSignMutate(current)(input, options);
    },
  );

  function clearKey(): void {
    wipeKeyBytes(keyBytesRef.current);
    keyBytesRef.current = null;
  }

  async function requestSignAndOpen(
    target: DocumentSigningTarget,
  ): Promise<void> {
    if (
      !args.canEdit ||
      hitlBusyRef.current ||
      signingSessionBlocksNewRequest(session)
    ) {
      return;
    }
    hitlBusyRef.current = true;
    setHitlBanner(null);
    requestSignMutation.reset();
    try {
      const result = await submitWithProtocolConfirmation({
        submit: () => requestSignMutation.submit({ documentId: target.id }),
        present: (challenge) => presentCard(challenge),
        confirm: (challengeId) => requestSignMutation.confirm(challengeId),
      });
      if (result.outcome === "declined") {
        return;
      }
      requestSignMutation.reset();
      clearKey();
      dispatch({
        type: "open",
        documentId: target.id,
        documentNumber: target.documentNumber,
      });
    } catch (error: unknown) {
      logSigningFailure("hitl", error);
      setHitlBanner(args.copy.signing.banners[mapSigningFailure(error)]);
    } finally {
      hitlBusyRef.current = false;
    }
  }

  async function portsFor(): Promise<DocumentSigningPorts> {
    const current = apiRef.current;
    if (current === null) {
      throw new TypeError("Failed to fetch");
    }
    const engine = await createDocumentSigningEngine(
      pkiProxyUrl(apiUrlFromEnv()),
    );
    return {
      start: (input, options) =>
        current.client.docSigning.start(input, options),
      downloadPayload: downloadSigningPayload,
      sha256Hex,
      inspectKey: engine.inspectKey,
      digestPayload: engine.digestPayload,
      signManifest: engine.signManifest,
      requestSigningUpload: (input, options) =>
        current.client.files.requestSigningUpload(input, options),
      getSigningUploadUrl: (input) =>
        current.client.files.getSigningUploadUrl(input),
      putAsic: putSigningAsic,
      // complete() is not raced against abort here. After PUT the ASiC
      // is already on the server; wrapping complete in raceSigningAbort
      // would drop a late abort and strand signing state. The pipeline
      // still skip-starts complete if abort won before this call.
      complete: (input, options) =>
        current.client.docSigning.complete(input, options),
      createAttempt: createMobileMutationAttempt,
    };
  }

  const hitlFailure = requestSignMutation.isError
    ? describeQueryFailure(requestSignMutation.error).kind
    : null;
  const banner =
    hitlBanner ??
    (hitlFailure === null
      ? null
      : args.copy.signing.banners[bannerFromQueryKind(hitlFailure)]);

  return {
    session,
    banner,
    pending: requestSignMutation.isPending || signingSessionIsBusy(session),
    requestSignAndOpen,
    closeSheet: () => {
      abortHandleRef.current.abort();
      dispatch({ type: "hide" });
    },
    onSheetHidden: () => {
      abortHandleRef.current.abort();
      clearKey();
      dispatch({ type: "hidden" });
    },
    pickKey: async () => {
      const picked = await pickSigningKey();
      if (picked.kind === "canceled") {
        return;
      }
      if (picked.kind === "invalid") {
        dispatch({ type: "fail", banner: "key" });
        return;
      }
      wipeKeyBytes(keyBytesRef.current);
      keyBytesRef.current = picked.bytes;
      dispatch({ type: "setFileName", fileName: picked.fileName });
    },
    setPassword: (password: string) => {
      dispatch({ type: "setPassword", password });
    },
    submit: async () => {
      if (!signingSessionCanSubmit(session) || session.documentId === null) {
        return;
      }
      const keyBytes = keyBytesRef.current;
      if (keyBytes === null) {
        dispatch({ type: "fail", banner: "validation" });
        return;
      }
      dispatch({ type: "begin" });
      const signal = abortHandleRef.current.begin();
      let lastPhase = "starting";
      try {
        const ports = await raceSigningAbort(portsFor(), signal);
        await runDocumentSigning({
          documentId: session.documentId,
          keyBytes,
          password: session.password,
          ports,
          signal,
          onPhase: (phase) => {
            lastPhase = phase;
            dispatch({ type: "phase", phase });
          },
        });
        clearKey();
        dispatch({ type: "succeed" });
        await invalidateDocumentsAfterWrite({
          queryClient,
          companyId: activeCompanyId,
        });
      } catch (error: unknown) {
        if (signal.aborted) {
          return;
        }
        logSigningFailure(lastPhase, error);
        dispatch({ type: "fail", banner: mapSigningFailure(error) });
      }
    },
  };
}

export type DocumentSigningApi = ReturnType<typeof useDocumentSigning>;
