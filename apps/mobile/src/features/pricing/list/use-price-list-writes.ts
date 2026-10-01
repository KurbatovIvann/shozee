/**
 * Default / active / delete + navigation (SHO-189). Delete protocol
 * submit assumes the options-sheet follow-up already presented the UI
 * confirm after `onHidden` (SHO-198 / SHO-200). Deactivating the default
 * is blocked in the UI and never sent; the follow-up sets the Banner.
 */
import { useCallback, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";

import { useApiClient } from "../../../api/api-provider";
import { useContractMutation } from "../../../api/contract-mutation";
import { describeQueryFailure } from "../../../api/errors";
import { submitWithProtocolConfirmation } from "../../../api/protocol-confirm";
import { useActiveCompany } from "../../../api/query-provider";
import { useConfirmationCard } from "../../../components/ui/confirmation-card-host";
import type { PricingCopy } from "../../../i18n/pricing";
import { bindPriceListDeleteMutate } from "../api/price-list-delete";
import {
  bindPriceListStatusMutate,
  invalidatePriceListsAfterWrite,
  type PriceListStatusWrite,
} from "../api/price-list-status";
import {
  priceListCreateHref,
  priceListEditorHref,
} from "../shared/price-list-hrefs";
import {
  mapPricingWriteFailure,
  pricingWriteBanner,
} from "../shared/mutation-failure";
import { shouldBlockDeactivateDefault } from "./price-lists-list.presenter";

export type PriceListWriteTarget = {
  readonly id: string;
  readonly name: string;
  readonly isDefault: boolean;
  readonly isActive: boolean;
};

export function usePriceListWrites(args: {
  readonly copy: PricingCopy;
  readonly canManage: boolean;
}) {
  const apiClient = useApiClient();
  const apiRef = useRef(apiClient);
  apiRef.current = apiClient;
  const { activeCompanyId } = useActiveCompany();
  const queryClient = useQueryClient();
  const router = useRouter();
  const writeBusyRef = useRef(false);
  const presentCard = useConfirmationCard();
  const presentCardRef = useRef(presentCard);
  presentCardRef.current = presentCard;
  const [localBanner, setLocalBanner] = useState<string | null>(null);

  const statusMutation = useContractMutation(
    (input: PriceListStatusWrite, options) => {
      const current = apiRef.current;
      if (current === null) {
        return Promise.reject(new TypeError("Failed to fetch"));
      }
      return bindPriceListStatusMutate(current)(input, options);
    },
  );
  const deleteMutation = useContractMutation(
    (input: { id: string }, options) => {
      const current = apiRef.current;
      if (current === null) {
        return Promise.reject(new TypeError("Failed to fetch"));
      }
      return bindPriceListDeleteMutate(current)(input, options);
    },
  );

  const statusFailure = statusMutation.isError
    ? describeQueryFailure(statusMutation.error).kind
    : null;
  const deleteFailure = deleteMutation.isError
    ? describeQueryFailure(deleteMutation.error).kind
    : null;
  const banner =
    localBanner ??
    pricingWriteBanner(
      mapPricingWriteFailure(deleteFailure),
      args.copy.mutation,
    ) ??
    pricingWriteBanner(
      mapPricingWriteFailure(statusFailure),
      args.copy.mutation,
    );

  async function afterWrite(): Promise<void> {
    await invalidatePriceListsAfterWrite({
      queryClient,
      companyId: activeCompanyId,
    });
    statusMutation.reset();
    deleteMutation.reset();
    setLocalBanner(null);
  }

  const openCreate = useCallback(() => {
    router.push(priceListCreateHref());
  }, [router]);
  const openEdit = useCallback(
    (id: string) => {
      router.push(priceListEditorHref(id));
    },
    [router],
  );
  const goBack = useCallback(() => {
    router.back();
  }, [router]);

  return {
    banner,
    pending: statusMutation.isPending || deleteMutation.isPending,
    openCreate,
    openEdit,
    goBack,
    setBanner: (message: string) => {
      statusMutation.reset();
      deleteMutation.reset();
      setLocalBanner(message);
    },
    setDefault: async (list: PriceListWriteTarget) => {
      if (!args.canManage || writeBusyRef.current) {
        return;
      }
      writeBusyRef.current = true;
      setLocalBanner(null);
      try {
        await statusMutation.submit(
          list.isDefault
            ? { kind: "clearDefault" }
            : { kind: "setDefault", priceListId: list.id },
        );
        await afterWrite();
      } catch {
        // Banner is derived from mutation.error.
      } finally {
        writeBusyRef.current = false;
      }
    },
    toggleActive: async (list: PriceListWriteTarget) => {
      if (!args.canManage || writeBusyRef.current) {
        return;
      }
      if (
        list.isActive &&
        shouldBlockDeactivateDefault({
          isDefault: list.isDefault,
          isActive: list.isActive,
        })
      ) {
        return;
      }
      writeBusyRef.current = true;
      setLocalBanner(null);
      try {
        await statusMutation.submit(
          list.isActive
            ? { kind: "deactivate", id: list.id }
            : { kind: "activate", id: list.id },
        );
        await afterWrite();
      } catch {
        // Banner is derived from mutation.error.
      } finally {
        writeBusyRef.current = false;
      }
    },
    remove: async (list: PriceListWriteTarget) => {
      if (!args.canManage || writeBusyRef.current) {
        return;
      }
      writeBusyRef.current = true;
      setLocalBanner(null);
      try {
        const result = await submitWithProtocolConfirmation({
          submit: () => deleteMutation.submit({ id: list.id }),
          present: (challenge) => presentCardRef.current(challenge),
          confirm: (challengeId) => deleteMutation.confirm(challengeId),
        });
        if (result.outcome === "declined") {
          return;
        }
        await afterWrite();
      } catch {
        // Banner is derived from mutation.error.
      } finally {
        writeBusyRef.current = false;
      }
    },
  };
}
