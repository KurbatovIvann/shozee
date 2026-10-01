/**
 * Archive / restore / delete mutations for clients (SHO-307). List and
 * editor share this so confirm+mutate+busy is not forked. Callbacks are
 * ref-stable so pane `useCallback([model.archive])` and row `memo` bail.
 */
import { useCallback, useMemo, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { useApiClient } from "../../../api/api-provider";
import { useContractMutation } from "../../../api/contract-mutation";
import { describeQueryFailure } from "../../../api/errors";
import { submitWithProtocolConfirmation } from "../../../api/protocol-confirm";
import { useActiveCompany } from "../../../api/query-provider";
import { useConfirmationCard } from "../../../components/ui/confirmation-card-host";
import { presentConfirmDialog } from "../../../components/ui/present-confirm-dialog";
import type { CustomersCopy } from "../../../i18n/customers";
import { bindCustomerDeleteMutate } from "../api/customer-delete";
import {
  bindCustomerStatusMutate,
  invalidateCustomersAfterWrite,
  type CustomerStatusWrite,
} from "../api/customer-status";
import { runConfirmedWrite } from "./confirmed-write";
import {
  customersWriteBanner,
  mapCustomersWriteFailure,
} from "./mutation-failure";

export function useCustomerStatusWrites(args: {
  readonly copy: CustomersCopy;
  readonly canEdit: boolean;
  readonly canDelete: boolean;
  readonly afterSuccess?: () => void;
}): {
  readonly banner: string | null;
  readonly pending: boolean;
  readonly archive: (id: string) => Promise<void>;
  readonly restore: (id: string) => Promise<void>;
  readonly remove: (id: string) => Promise<void>;
} {
  const apiClient = useApiClient();
  const apiRef = useRef(apiClient);
  apiRef.current = apiClient;
  const { activeCompanyId } = useActiveCompany();
  const queryClient = useQueryClient();
  const presentCard = useConfirmationCard();
  const presentCardRef = useRef(presentCard);
  presentCardRef.current = presentCard;
  const writeBusyRef = useRef(false);
  const argsRef = useRef(args);
  argsRef.current = args;
  const companyIdRef = useRef(activeCompanyId);
  companyIdRef.current = activeCompanyId;
  const queryClientRef = useRef(queryClient);
  queryClientRef.current = queryClient;

  const statusMutation = useContractMutation(
    (input: CustomerStatusWrite, options) => {
      const current = apiRef.current;
      if (current === null) {
        return Promise.reject(new TypeError("Failed to fetch"));
      }
      return bindCustomerStatusMutate(current)(input, options);
    },
  );
  const deleteMutation = useContractMutation(
    (input: { id: string }, options) => {
      const current = apiRef.current;
      if (current === null) {
        return Promise.reject(new TypeError("Failed to fetch"));
      }
      return bindCustomerDeleteMutate(current)(input, options);
    },
  );
  const statusMutationRef = useRef(statusMutation);
  statusMutationRef.current = statusMutation;
  const deleteMutationRef = useRef(deleteMutation);
  deleteMutationRef.current = deleteMutation;

  const statusFailure = statusMutation.isError
    ? describeQueryFailure(statusMutation.error).kind
    : null;
  const deleteFailure = deleteMutation.isError
    ? describeQueryFailure(deleteMutation.error).kind
    : null;
  const banner =
    customersWriteBanner(
      mapCustomersWriteFailure(deleteFailure),
      args.copy.mutation,
    ) ??
    customersWriteBanner(
      mapCustomersWriteFailure(statusFailure),
      args.copy.mutation,
    );

  const afterWrite = useCallback(async (): Promise<void> => {
    await invalidateCustomersAfterWrite({
      queryClient: queryClientRef.current,
      companyId: companyIdRef.current,
    });
    statusMutationRef.current.reset();
    deleteMutationRef.current.reset();
    argsRef.current.afterSuccess?.();
  }, []);

  const archive = useCallback(
    async (id: string) => {
      const current = argsRef.current;
      await runConfirmedWrite({
        busyRef: writeBusyRef,
        allowed: current.canEdit,
        confirm: {
          title: current.copy.confirm.archiveTitle,
          message: current.copy.confirm.archiveDescription,
          confirmLabel: current.copy.confirm.archiveConfirm,
          cancelLabel: current.copy.confirm.cancel,
          tone: "default",
        },
        present: presentConfirmDialog,
        run: async () => {
          await statusMutationRef.current.submit({
            kind: "archiveCustomer",
            id,
          });
          await afterWrite();
        },
      });
    },
    [afterWrite],
  );

  const restore = useCallback(
    async (id: string) => {
      const current = argsRef.current;
      await runConfirmedWrite({
        busyRef: writeBusyRef,
        allowed: current.canEdit,
        run: async () => {
          await statusMutationRef.current.submit({
            kind: "restoreCustomer",
            id,
          });
          await afterWrite();
        },
      });
    },
    [afterWrite],
  );

  const remove = useCallback(
    async (id: string) => {
      const current = argsRef.current;
      await runConfirmedWrite({
        busyRef: writeBusyRef,
        allowed: current.canDelete,
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

  const pending = statusMutation.isPending || deleteMutation.isPending;
  return useMemo(
    () => ({
      banner,
      pending,
      archive,
      restore,
      remove,
    }),
    [banner, pending, archive, restore, remove],
  );
}
