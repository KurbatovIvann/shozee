/**
 * Order detail facade (SHO-212 / SHO-376). Composes get + customer
 * hydrate, status writes, and the actions-sheet reducer. View stays
 * presentational; no RHF and no XState on this screen.
 */
import { useQuery } from "@tanstack/react-query";
import { useMemo, useReducer } from "react";

import { useApiClient } from "../../../api/api-provider";
import { useActiveCompany } from "../../../api/query-provider";
import { useResolvedCompany } from "../../../company-resolution/resolved-company-provider";
import { detectLocale } from "../../../i18n/locale";
import { ordersCopy } from "../../../i18n/orders";
import { getCustomerNameQueryOptions } from "../api/customer-name-query";
import { canEditOrders, orderDetailActions } from "../shared/order-permissions";
import {
  orderDetailCompleteLoading,
  orderDetailConfirmLoading,
  orderDetailHeaderSubtitle,
  orderDetailHeaderTitle,
  orderDetailStartLoading,
  orderDetailWriteChrome,
  toOrderDetailView,
  uniqueOrderLineProductIds,
  withOrderLineThumbnails,
  type OrderDetailState,
  type OrderDetailViewModel,
} from "./order-detail-model";
import {
  IDLE_DETAIL_SHEETS,
  orderDetailSheetChrome,
  reduceOrderDetailSheets,
} from "./order-detail.reducer";
import { useOrderDetailActions } from "./use-order-detail-actions";
import { useOrderDetailQuery } from "./use-order-detail-query";
import { useOrderDetailThumbnails } from "./use-order-detail-thumbnails";

export type OrderDetailModel = {
  readonly copy: ReturnType<typeof ordersCopy>;
  readonly state: OrderDetailState;
  readonly order: OrderDetailViewModel | null;
  readonly showConfirm: boolean;
  readonly showStart: boolean;
  readonly showComplete: boolean;
  readonly showActions: boolean;
  readonly cancelEnabled: boolean;
  readonly actionsVisible: boolean;
  readonly confirmLoading: boolean;
  readonly startLoading: boolean;
  readonly completeLoading: boolean;
  readonly writePending: boolean;
  readonly statusBanner: string | null;
  readonly headerTitle: string;
  readonly headerSubtitle: string;
  readonly goBack: () => void;
  readonly retry: () => void;
  readonly openActions: () => void;
  readonly closeActions: () => void;
  readonly confirm: () => void;
  readonly start: () => void;
  readonly complete: () => void;
  readonly cancel: () => void;
};

export function useOrderDetail(
  idParam: string | string[] | undefined,
): OrderDetailModel {
  const locale = detectLocale();
  const copy = useMemo(() => ordersCopy(locale), [locale]);
  const apiClient = useApiClient();
  const { activeCompanyId } = useActiveCompany();
  const membership = useResolvedCompany();
  const canEdit = canEditOrders(membership);
  const [sheets, dispatch] = useReducer(
    reduceOrderDetailSheets,
    IDLE_DETAIL_SHEETS,
  );
  const query = useOrderDetailQuery(idParam);
  const productIds = useMemo(
    () => uniqueOrderLineProductIds(query.order?.items ?? []),
    [query.order?.items],
  );
  const thumbnailsByProductId = useOrderDetailThumbnails({
    productIds,
    enabled: query.state.kind === "ready",
  });
  const linkedCustomerId = query.order?.customer.linkedCustomerId ?? null;
  const linkedCustomerQuery = useQuery(
    getCustomerNameQueryOptions({
      client: apiClient,
      companyId: activeCompanyId,
      customerId: linkedCustomerId,
      getActiveCompany: () => apiClient?.getActiveCompany() ?? null,
    }),
  );
  const livePhone = linkedCustomerQuery.data?.phone ?? null;
  const actions = useOrderDetailActions({
    orderId: query.orderId,
    copy: copy.detail,
    dispatch,
  });
  const chrome = orderDetailSheetChrome(sheets);
  const snapshot = useMemo(() => {
    if (query.order === null) {
      return null;
    }
    return toOrderDetailView({
      order: query.order,
      copy,
      customerPhone: livePhone,
    });
  }, [copy, livePhone, query.order]);
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
    stateKind: query.state.kind,
    hasOrder: order !== null,
    actionFlags,
  });

  const writePending = {
    confirmPending: actions.confirmPending,
    startPending: actions.startPending,
    completePending: actions.completePending,
    cancelPending: actions.cancelPending,
  };

  return {
    copy,
    state: query.state,
    order,
    showConfirm: writeChrome.showConfirm,
    showStart: writeChrome.showStart,
    showComplete: writeChrome.showComplete,
    showActions: writeChrome.showActions,
    cancelEnabled: writeChrome.cancelEnabled,
    actionsVisible: chrome.actionsVisible,
    confirmLoading: orderDetailConfirmLoading(writePending),
    startLoading: orderDetailStartLoading(writePending),
    completeLoading: orderDetailCompleteLoading(writePending),
    writePending: actions.writePending,
    statusBanner: actions.banner,
    headerTitle:
      query.state.kind === "ready"
        ? orderDetailHeaderTitle({
            orderNumber: order?.orderNumber ?? null,
            fallbackTitle: copy.detail.title,
          })
        : copy.detail.title,
    headerSubtitle:
      query.state.kind === "ready"
        ? orderDetailHeaderSubtitle({
            nameSnapshot: query.order?.customer.nameSnapshot ?? null,
            missingCustomer: copy.missingCustomer,
          })
        : "",
    goBack: actions.goBack,
    retry: query.retry,
    openActions: actions.openActions,
    closeActions: actions.closeActions,
    confirm: actions.confirm,
    start: actions.start,
    complete: actions.complete,
    cancel: actions.cancel,
  };
}
