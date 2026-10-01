/**
 * Group delete + edit navigation (SHO-179 / SHO-307). Delete is UI
 * confirm then protocol confirmation. Callbacks are ref-stable so pane
 * `useCallback([model.remove])` and row `memo` bail.
 */
import { useCallback, useMemo, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";

import { useApiClient } from "../../../api/api-provider";
import { useContractMutation } from "../../../api/contract-mutation";
import { describeQueryFailure } from "../../../api/errors";
import { submitWithProtocolConfirmation } from "../../../api/protocol-confirm";
import { useActiveCompany } from "../../../api/query-provider";
import { useConfirmationCard } from "../../../components/ui/confirmation-card-host";
import type { CustomersCopy } from "../../../i18n/customers";
import { invalidateCustomersAfterWrite } from "../api/customer-status";
import { bindGroupDeleteMutate } from "../api/group-delete";
import { runConfirmedWrite } from "../shared/confirmed-write";
import { groupEditorHref } from "../shared/customer-hrefs";
import {
  customersWriteBanner,
  mapCustomersWriteFailure,
} from "../shared/mutation-failure";

export function useGroupWrites(args: {
  readonly copy: CustomersCopy;
  readonly canEdit: boolean;
}) {
  const apiClient = useApiClient();
  const apiRef = useRef(apiClient);
  apiRef.current = apiClient;
  const { activeCompanyId } = useActiveCompany();
  const queryClient = useQueryClient();
  const router = useRouter();
  const writeBusyRef = useRef(false);
  const argsRef = useRef(args);
  argsRef.current = args;
  const companyIdRef = useRef(activeCompanyId);
  companyIdRef.current = activeCompanyId;
  const queryClientRef = useRef(queryClient);
  queryClientRef.current = queryClient;
  const routerRef = useRef(router);
  routerRef.current = router;
  const presentCard = useConfirmationCard();
  const presentCardRef = useRef(presentCard);
  presentCardRef.current = presentCard;

  const deleteMutation = useContractMutation(
    (input: { id: string }, options) => {
      const current = apiRef.current;
      if (current === null) {
        return Promise.reject(new TypeError("Failed to fetch"));
      }
      return bindGroupDeleteMutate(current)(input, options);
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
  }, []);

  const openEdit = useCallback((id: string) => {
    routerRef.current.push(groupEditorHref(id));
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
      openEdit,
      remove,
    }),
    [banner, deleteMutation.isPending, openEdit, remove],
  );
}
