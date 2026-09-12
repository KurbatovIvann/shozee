import { useRef, useState } from "react";
import { useForm, useWatch } from "react-hook-form";

import { useApiClient } from "../../../api/api-provider";
import { useActiveCompany } from "../../../api/query-provider";
import { useUnsavedGuard } from "../../../components/form-kit";
import { useResolvedCompany } from "../../../company-resolution/resolved-company-provider";
import { documentsCopy } from "../../../i18n/documents";
import { detectLocale } from "../../../i18n/locale";
import {
  canCreateDocuments,
  canEditDocuments,
} from "../shared/document-permissions";
import { rhfPathsForFieldErrors } from "./document-form-copy";
import {
  cloneDocumentFormDraft,
  emptyDocumentFormDraft,
  type DocumentFormDraft,
} from "./document-form-draft";
import { classifyDocumentFormLoad } from "./document-form-load";
import { layoutCardLabel } from "./document-form-layouts";
import { counterpartyPickerEnabled } from "./document-form-pickers";
import {
  presentDocumentFormCopy,
  presentDocumentFormView,
} from "./document-form.presenter";
import { documentFormResolver } from "./document-form.schema";
import { useDocumentFormHandover } from "./use-document-form-handover";
import { useDocumentFormLayouts } from "./use-document-form-layouts";
import {
  useDocumentFormLookups,
  type DocumentFormOrderRow,
} from "./use-document-form-lookups";
import { useDocumentFormPickers } from "./use-document-form-pickers";
import { useDocumentSave } from "./use-document-save";

export type DocumentFormModel = ReturnType<typeof useDocumentForm>;

export function useDocumentForm() {
  const locale = detectLocale();
  const copy = documentsCopy(locale);
  const formCopy = copy.form;
  const apiClient = useApiClient();
  const { activeCompanyId } = useActiveCompany();
  const membership = useResolvedCompany();
  const canCreate = canCreateDocuments(membership.role);
  const canEdit = canEditDocuments(membership.role);

  const {
    getValues,
    setValue,
    handleSubmit,
    setError,
    clearErrors,
    formState,
    control,
    reset,
  } = useForm<DocumentFormDraft>({
    defaultValues: emptyDocumentFormDraft(),
    resolver: documentFormResolver,
    mode: "onSubmit",
  });
  const { isDirty, errors, isSubmitted } = formState;
  const type = useWatch({ control, name: "type" });
  const orderId = useWatch({ control, name: "orderId" });
  const counterpartyId = useWatch({ control, name: "counterpartyId" });
  const layoutKey = useWatch({ control, name: "layoutKey" });

  const handover = useDocumentFormHandover({ copy, canEdit });
  const clientReady = apiClient !== null && activeCompanyId !== null;
  const loadState = classifyDocumentFormLoad({
    canCreate,
    clientReady,
  });
  const [selectedOrder, setSelectedOrder] =
    useState<DocumentFormOrderRow | null>(null);
  const lookups = useDocumentFormLookups({
    enabled: loadState.kind === "ready",
    customerId: selectedOrder?.customerId ?? null,
    missingCustomer: formCopy.orderMissingCustomer,
  });
  const layoutsQuery = useDocumentFormLayouts({
    enabled: loadState.kind === "ready",
    type,
    layoutKey,
    setValue,
  });
  const selectedCounterparty = lookups.counterpartyOptions.find(
    (row) => row.id === counterpartyId,
  );
  const counterpartyEnabled = counterpartyPickerEnabled({
    orderId,
    customerId: selectedOrder?.customerId ?? null,
  });

  const armLeaveRef = useRef(() => {});
  const saveApi = useDocumentSave({
    loadKind: loadState.kind,
    getDraft: () => cloneDocumentFormDraft(getValues()),
    setOrigin: (draft) => {
      reset(draft);
    },
    onSaved: async (result) => {
      armLeaveRef.current();
      await handover.afterCreate(result);
    },
    setFieldErrors: (nextFieldErrors) => {
      for (const entry of rhfPathsForFieldErrors(nextFieldErrors)) {
        setError(entry.name, { type: "validate", message: entry.message });
      }
    },
  });

  function onFieldEdit(): void {
    clearErrors();
    saveApi.resetMutation();
  }

  const pickers = useDocumentFormPickers({
    counterpartyEnabled,
    setValue,
    onFieldEdit,
  });
  const { armLeave, requestLeave } = useUnsavedGuard({
    dirty: isDirty && !handover.created,
    pending: saveApi.pending,
    copy: formCopy,
    sheetOpen: pickers.sheetOpen || handover.visible,
    closeSheet: pickers.closeSheets,
    armedLeave: "dispatch-only",
  });
  armLeaveRef.current = armLeave;

  const pending = saveApi.pending || handover.pending;
  const resolved = presentDocumentFormCopy({
    formCopy,
    submitted: isSubmitted,
    orderMessage: errors.orderId?.message,
    layoutMessage: errors.layoutKey?.message,
    basisMessage: errors.basis?.message,
    mutationError: saveApi.mutationError,
    lastWrite: saveApi.lastWrite,
    isMutationError: saveApi.isMutationError,
    pending,
    clientReady,
    canCreate,
    created: handover.created,
  });
  const layoutCards = layoutsQuery.layouts.map((row) => ({
    key: row.key,
    label: layoutCardLabel(row, locale),
  }));
  const selectedLayout = layoutsQuery.layouts.find(
    (row) => row.key === layoutKey,
  );
  const presented = presentDocumentFormView({
    copy,
    loadState,
    resolved,
    type,
    pending,
    canCreate,
    selectedOrder,
    selectedCounterparty,
    counterpartyEnabled,
    orderId,
    counterpartyId,
    layoutKey,
    layoutCards,
    layoutCatalog: layoutsQuery.layouts,
    layoutsStatus: layoutsQuery.status,
    layoutPreview:
      selectedLayout === undefined
        ? null
        : layoutCardLabel(selectedLayout, locale),
    orderSheetOpen: pickers.orderSheetOpen,
    counterpartySheetOpen: pickers.counterpartySheetOpen,
  });

  return {
    copy,
    control,
    ...presented,
    orderOptions: lookups.orderOptions,
    counterpartyOptions: lookups.counterpartyOptions,
    handoverVisible: handover.visible,
    handoverUrl: handover.url,
    handoverTitle: handover.title,
    copied: handover.copied,
    copyFailed: handover.copyFailed,
    requestLeave,
    orderQuery: lookups.orderQuery,
    onOrderQueryChange: lookups.onOrderQueryChange,
    ordersLoadingMore: lookups.ordersLoadingMore,
    onOrdersEndReached: lookups.onOrdersEndReached,
    openOrderSheet: pickers.openOrderSheet,
    openCounterpartySheet: pickers.openCounterpartySheet,
    closeOrderSheet: () => {
      pickers.closeOrderSheet();
      lookups.onOrderQueryChange("");
    },
    closeCounterpartySheet: pickers.closeCounterpartySheet,
    pickOrder: (id: string) => {
      setSelectedOrder(lookups.orderRows.find((row) => row.id === id) ?? null);
      lookups.onOrderQueryChange("");
      pickers.pickOrder(id);
    },
    pickCounterparty: pickers.pickCounterparty,
    setType: pickers.setType,
    pickLayout: pickers.pickLayout,
    retryLayouts: layoutsQuery.retry,
    onFieldEdit,
    closeHandover: handover.closeHandover,
    onHandoverHidden: handover.onHandoverHidden,
    copyHandover: handover.copyHandover,
    shareHandover: handover.shareHandover,
    printHandover: handover.printHandover,
    save: () => {
      void handleSubmit(
        () => {
          void saveApi.save();
        },
        () => {
          saveApi.resetMutation();
        },
      )();
    },
  };
}
