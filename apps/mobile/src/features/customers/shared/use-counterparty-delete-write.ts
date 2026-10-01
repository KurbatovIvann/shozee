/**
 * Counterparty delete mutations (SHO-195 / SHO-307). List and editor
 * share this so confirm+protocol-delete+busy is not forked. Callbacks
 * are ref-stable so pane `useCallback([model.remove])` bails.
 */
import { useCallback, useMemo, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { useApiClient } from "../../../api/api-provider";
import { useContractMutation } from "../../../api/contract-mutation";
import { describeQueryFailure } from "../../../api/errors";
import { submitWithProtocolConfirmation } from "../../../api/protocol-confirm";
import { useActiveCompany } from "../../../api/query-provider";
import { useConfirmationCard } from "../../../components/ui/confirmation-card-host";
import type { CustomersCopy } from "../../../i18n/customers";
import { bindCounterpartyDeleteMutate } from "../api/counterparty-delete";
import { invalidateCustomersAfterWrite } from "../api/customer-status";
import { runConfirmedWrite } from "./confirmed-write";
import {
  customersWriteBanner,
  mapCustomersWriteFailure,
} from "./mutation-failure";

export function useCounterpartyDeleteWrite(args: {
  readonly copy: CustomersCopy;
  readonly canEdit: boolean;
  readonly afterSuccess?: () => void;
}): {
  readonly banner: string | null;
  readonly pending: boolean;
  readonly remove: (id: string) => Promise<void>;
} {
  const apiClient = useApiClient();
  const apiRef = useRef(apiClient);
  apiRef.current = apiClient;
  const { activeCompanyId } = useActiveCompany();
  const queryClient = useQueryClient();
  const writeBusyRef = useRef(false);
  const argsRef = useRef(args);
  argsRef.current = args;
  const companyIdRef = useRef(activeCompanyId);
  companyIdRef.current = activeCompanyId;
  const queryClientRef = useRef(queryClient);
  queryClientRef.current = queryClient;
  const presentCard = useConfirmationCard();
  const presentCardRef = useRef(presentCard);
  presentCardRef.current = presentCard;

  const deleteMutation = useContractMutation(
    (input: { id: string }, options) => {
      const current = apiRef.current;
      if (current === null) {
        return Promise.reject(new TypeError("Failed to fetch"));
      }
      return bindCounterpartyDeleteMutate(current)(input, options);
    },
  );
  const deleteMutationRef = useRef(deleteMutation);
  deleteMutationRef.current = deleteMutation;

  const banner = customersWriteBanner(
    mapCustomersWriteFailure(
      deleteMutation.isError
        ? describeQueryFailure(deleteMutation.error).kind
        : null,
    ),
    args.copy.mutation,
  );

  const afterWrite = useCallback(async (): Promise<void> => {
    await invalidateCustomersAfterWrite({
      queryClient: queryClientRef.current,
      companyId: companyIdRef.current,
    });
    deleteMutationRef.current.reset();
    argsRef.current.afterSuccess?.();
  }, []);

  const remove = useCallback(
    async (id: string) => {
      const current = argsRef.current;
      await runConfirmedWrite({
        busyRef: writeBusyRef,
        allowed: current.canEdit,
        run: async () => {
          const result = await submitWithProtocolConfirmation({
            submit: () => deleteMutationRef.current.submit({ id }),
            present: (challenge) => presentCardRef.current(challenge),
            confirm: (challengeId) =>
              deleteMutationRef.current.confirm(challengeId),
          });
          if (result.outcome === "declined") {
            return;
          }
          await afterWrite();
        },
      });
    },
    [afterWrite],
  );

  return useMemo(
    () => ({
      banner,
      pending: deleteMutation.isPending,
      remove,
    }),
    [banner, deleteMutation.isPending, remove],
  );
}
