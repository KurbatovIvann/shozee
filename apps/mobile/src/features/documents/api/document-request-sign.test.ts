import { ORPCError } from "@orpc/client";
import { describe, expect, it } from "vitest";

import type { MutationCallOptions } from "@showzy/contract";

import { createContractMutationController } from "../../../api/contract-mutation";
import { submitWithProtocolConfirmation } from "../../../api/protocol-confirm";
import { bindDocumentRequestSignMutate } from "./document-request-sign";

const DOCUMENT_ID = "0f0e2d5c-4a1b-4c3d-9e8f-102938475601";

describe("bindDocumentRequestSignMutate", () => {
  it("forwards documentId and attempt options to requestSign", async () => {
    const keys: string[] = [];
    const controller = createContractMutationController<
      { documentId: string },
      { documentId: string }
    >({
      mutate: bindDocumentRequestSignMutate({
        client: {
          documents: {
            requestSign: (input, options: MutationCallOptions) => {
              keys.push(options.context.idempotencyKey);
              return Promise.resolve({ documentId: input.documentId });
            },
          },
        },
      }),
    });

    const result = await controller.submit({ documentId: DOCUMENT_ID });
    expect(result).toEqual({ documentId: DOCUMENT_ID });
    expect(keys[0]?.length).toBeGreaterThan(0);
  });

  it("re-invokes requestSign with the confirmation challenge", async () => {
    const calls: string[] = [];
    const controller = createContractMutationController<
      { documentId: string },
      { documentId: string }
    >({
      mutate: bindDocumentRequestSignMutate({
        client: {
          documents: {
            requestSign: (input, options: MutationCallOptions) => {
              const challenge = options.context.confirmationChallengeId;
              if (challenge === undefined) {
                calls.push("submit");
                return Promise.reject(
                  new ORPCError("CONFIRMATION_REQUIRED", {
                    defined: true,
                    status: 409,
                    message: "Confirm.",
                    data: {
                      challenge: {
                        challengeId: "challenge-request-sign",
                        summary:
                          "Request a qualified electronic signature for this issued document.",
                        expiresAt: "2026-08-30T00:00:00.000Z",
                      },
                    },
                  }),
                );
              }
              calls.push(challenge);
              return Promise.resolve({ documentId: input.documentId });
            },
          },
        },
      }),
    });

    const result = await submitWithProtocolConfirmation({
      submit: () => controller.submit({ documentId: DOCUMENT_ID }),
      present: () => Promise.resolve("confirm"),
      confirm: (challengeId) => controller.confirm(challengeId),
    });
    expect(result).toEqual({
      outcome: "submitted",
      value: { documentId: DOCUMENT_ID },
    });
    expect(calls).toEqual(["submit", "challenge-request-sign"]);
  });
});
