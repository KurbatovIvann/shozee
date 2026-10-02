import { ORPCError } from "@orpc/client";
import { describe, expect, it } from "vitest";

import type { MutationCallOptions } from "@showzy/contract";

import { createContractMutationController } from "../../../api/contract-mutation";
import { submitWithProtocolConfirmation } from "../../../api/protocol-confirm";
import { bindPriceListDeleteMutate } from "./price-list-delete";

const PRICE_LIST_ID = "0f0e2d5c-4a1b-4c3d-9e8f-102938475601";

describe("bindPriceListDeleteMutate", () => {
  it("forwards id and attempt options to deletePriceList", async () => {
    const keys: string[] = [];
    const controller = createContractMutationController<
      { id: string },
      { id: string }
    >({
      mutate: bindPriceListDeleteMutate({
        client: {
          pricing: {
            deletePriceList: (input, options: MutationCallOptions) => {
              keys.push(options.context.idempotencyKey);
              return Promise.resolve({ id: input.id });
            },
          },
        },
      }),
    });

    const result = await controller.submit({ id: PRICE_LIST_ID });
    expect(result).toEqual({ id: PRICE_LIST_ID });
    expect(keys[0]?.length).toBeGreaterThan(0);
  });

  it("re-invokes deletePriceList with the confirmation challenge", async () => {
    const calls: string[] = [];
    const controller = createContractMutationController<
      { id: string },
      { id: string }
    >({
      mutate: bindPriceListDeleteMutate({
        client: {
          pricing: {
            deletePriceList: (input, options: MutationCallOptions) => {
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
                        challengeId: "challenge-delete",
                        summary: "Delete?",
                        expiresAt: "2026-08-28T00:00:00.000Z",
                        risk: "high",
                      },
                    },
                  }),
                );
              }
              calls.push(challenge);
              return Promise.resolve({ id: input.id });
            },
          },
        },
      }),
    });

    const result = await submitWithProtocolConfirmation({
      submit: () => controller.submit({ id: PRICE_LIST_ID }),
      present: () => Promise.resolve("confirm"),
      confirm: (challengeId) => controller.confirm(challengeId),
    });
    expect(result).toEqual({
      outcome: "submitted",
      value: { id: PRICE_LIST_ID },
    });
    expect(calls).toEqual(["submit", "challenge-delete"]);
  });
});
