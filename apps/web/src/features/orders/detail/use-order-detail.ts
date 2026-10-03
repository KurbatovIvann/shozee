/**
 * Order detail facade (SHO-378). Composes get + customer hydrate and
 * status writes. View stays presentational.
 */
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { useApiClient } from "../../../api/api-provider";
import { describeQueryFailure } from "../../../api/errors";
import { useActiveCompany } from "../../../api/query-provider";
import { useListMine } from "../../companies/shared/list-mine";
import { customerGetQueryOptions } from "../api/customer";
import { ordersGetQueryOptions, parseOrderId } from "../api/get";
import {
  classifyOrderDetail,
  type OrderQueryLoadState,
} from "../shared/classify-order-load";
import {
  canEditOrders,
  canFetchFileDownloadUrls,
  orderDetailActions,
} from "../shared/order-permissions";
import { useOrdersCopy } from "../shared/use-orders-copy";
import type { OrdersCopy } from "../../../i18n/orders";
import {
  orderDetailHeaderTitle,
  orderDetailWriteChrome,
  toOrderDetailView,
  uniqueOrderLineProductIds,
  withOrderLineThumbnails,
  type OrderDetailViewModel,
} from "./order-detail.presenter";
import { useOrderDetailActions } from "./use-order-detail-actions";
import { useOrderDetailThumbnails } from "./use-order-detail-thumbnails";

export type OrderDetailModel = {
  readonly copy: OrdersCopy;
  readonly state: OrderQueryLoadState;
  readonly order: OrderDetailViewModel | null;
  readonly showConfirm: boolean;
  readonly showStart: boolean;
  readonly showComplete: boolean;
  readonly showActions: boolean;
  readonly cancelEnabled: boolean;
  readonly confirmPending: boolean;
  readonly startPending: boolean;
  readonly completePending: boolean;
  readonly cancelPending: boolean;
  readonly statusBanner: string | null;
  readonly headerTitle: string;
  readonly retry: () => void;
  readonly confirm: () => void;
  readonly start: () => void;
  readonly complete: () => void;
  readonly cancel: () => void;
};

export function useOrderDetail(orderIdParam: string): OrderDetailModel {
  const copy = useOrdersCopy();
  const client = useApiClient();
  const { activeCompanyId } = useActiveCompany();
  const listMine = useListMine();
  const membership = (listMine.data?.memberships ?? []).find(
    (item) => item.company.id === activeCompanyId,
  );
  const canEdit = membership !== undefined && canEditOrders(membership);
  const canFetchThumbnails =
    membership !== undefined && canFetchFileDownloadUrls(membership);
  const orderId = parseOrderId(orderIdParam);
  const query = useQuery(
    ordersGetQueryOptions({
      client,
      companyId: activeCompanyId,
      orderId: orderId ?? "",
    }),
  );
  const failureKind = query.isError
    ? describeQueryFailure(query.error).kind
    : null;
  const state = classifyOrderDetail({
    orderId,
    clientReady: activeCompanyId !== null,
    status: query.status,
    failureKind,
  });
  const linkedCustomerId = query.data?.customer.linkedCustomerId ?? null;
  const linkedCustomerQuery = useQuery(
    customerGetQueryOptions({
      client,
      companyId: activeCompanyId,
      customerId: linkedCustomerId,
    }),
  );
  const livePhone = linkedCustomerQuery.data?.phone ?? null;
  const productIds = useMemo(
    () => uniqueOrderLineProductIds(query.data?.items ?? []),
    [query.data?.items],
  );
  const thumbnailsByProductId = useOrderDetailThumbnails({
    productIds,
    enabled: state.kind === "ready",
    canFetchThumbnails,
  });
  const snapshot = useMemo(() => {
    if (query.data === undefined) {
      return null;
    }
    return toOrderDetailView({
      order: query.data,
      copy,
      customerPhone: livePhone,
    });
  }, [copy, livePhone, query.data]);
  const order = useMemo(() => {
    if (snapshot === null) {
      return null;
    }
    return {
      ...snapshot,
      lines: withOrderLineThumbnails(snapshot.lines, thumbnailsByProductId),
    };
  }, [snapshot, thumbnailsByProductId]);
  const actionFlags = orderDetailActions({
    canEdit,
    status: order?.status ?? "canceled",
  });
  const writeChrome = orderDetailWriteChrome({
    stateKind: state.kind,
    hasOrder: order !== null,
    actionFlags,
  });
  const actions = useOrderDetailActions({
    orderId,
    copy: copy.detail,
  });

  return {
    copy,
    state,
    order,
    showConfirm: writeChrome.showConfirm,
    showStart: writeChrome.showStart,
    showComplete: writeChrome.showComplete,
    showActions: writeChrome.showActions,
    cancelEnabled: writeChrome.cancelEnabled,
    confirmPending: actions.confirmPending,
    startPending: actions.startPending,
    completePending: actions.completePending,
    cancelPending: actions.cancelPending,
    statusBanner: actions.banner,
    headerTitle:
      state.kind === "ready"
        ? orderDetailHeaderTitle({
            orderNumber: order?.orderNumber ?? null,
            fallbackTitle: copy.detail.title,
          })
        : copy.detail.title,
    retry: () => {
      void query.refetch();
    },
    confirm: actions.confirm,
    start: actions.start,
    complete: actions.complete,
    cancel: actions.cancel,
  };
}
