import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "expo-router";
import { useCallback, useMemo, useRef, useState } from "react";
import { useFieldArray, useForm } from "react-hook-form";

import {
  catalogFactsBlockSubmit,
  uniqueProductIds,
} from "@showzy/validation/order-line-catalog-facts";
import { orderFormDraftSchema } from "@showzy/validation/orders";

import { useApiClient } from "../../../api/api-provider";
import { describeQueryFailure, describeWireError } from "../../../api/errors";
import { useActiveCompany } from "../../../api/query-provider";
import { useUnsavedGuard } from "../../../components/form-kit";
import { useResolvedCompany } from "../../../company-resolution/resolved-company-provider";
import { detectLocale } from "../../../i18n/locale";
import { ordersCopy } from "../../../i18n/orders";
import { orderDetailHref } from "../shared/order-hrefs";
import {
  canCreateOrders,
  orderCreateScreenActions,
} from "../shared/order-permissions";
import { EMPTY_ORDER_THUMBNAIL } from "../shared/order-thumbnails";
import {
  mapValidationIssues,
  mapVariantSelectionConflict,
  rhfPathsForFieldErrors,
  type BannerKey,
} from "./order-form-copy";
import {
  cloneOrderFormDraft,
  emptyOrderFormDraft,
  stepQuantityMilli,
  type OrderFormDraft,
} from "./order-form-draft";
import { classifyOrderFormLoad } from "./order-form-load";
import {
  presentOrderFormCopy,
  presentOrderFormFooter,
  presentOrderFormItems,
  presentProductsValue,
  presentProductSelectRows,
  presentVariantSelectRows,
} from "./order-form.presenter";
import { commitProductPickerPicks, productPickerPicks } from "./product-picker";
import { useOrderFormLookups } from "./use-order-form-lookups";
import { useOrderFormSheets } from "./use-order-form-sheets";
import { useOrderSave } from "./use-order-save";

export type OrderFormModel = ReturnType<typeof useOrderForm>;

export function useOrderForm() {
  const locale = detectLocale();
  const copy = useMemo(() => ordersCopy(locale), [locale]);
  const formCopy = copy.create;
  const router = useRouter();
  const apiClient = useApiClient();
  const { activeCompanyId } = useActiveCompany();
  const membership = useResolvedCompany();
  const canCreate = canCreateOrders(membership);

  const {
    control,
    reset,
    getValues,
    setValue,
    watch,
    handleSubmit,
    setError,
    clearErrors,
    formState,
  } = useForm<OrderFormDraft>({
    defaultValues: emptyOrderFormDraft(),
    resolver: zodResolver(orderFormDraftSchema),
    mode: "onSubmit",
  });
  const { append, update, remove, fields } = useFieldArray({
    control,
    name: "items",
  });
  const { isDirty, errors, isSubmitted } = formState;
  const [localBanner, setLocalBanner] = useState<BannerKey | null>(null);
  const [customerPhone, setCustomerPhone] = useState<string | undefined>(
    undefined,
  );
  const sheets = useOrderFormSheets();
  const clientReady = apiClient !== null && activeCompanyId !== null;
  const loadState = classifyOrderFormLoad({ canCreate, clientReady });
  const draftProductIds = uniqueProductIds(
    fields.map((field) => field.productId),
  );
  const lookups = useOrderFormLookups({
    enabled: loadState.kind === "ready",
    variantProductId:
      sheets.picker.kind === "variants" ? sheets.picker.productId : null,
    draftProductIds,
  });
  const armLeaveRef = useRef(() => {});
  const saveApi = useOrderSave({
    loadKind: loadState.kind,
    getDraft: () => cloneOrderFormDraft(getValues()),
    getCatalogFacts: () => lookups.catalogFacts,
    setOrigin: (draft) => {
      reset(draft);
    },
    onSaved: (orderId) => {
      armLeaveRef.current();
      router.replace(orderDetailHref(orderId));
      return Promise.resolve();
    },
    setFieldErrors: (nextFieldErrors) => {
      for (const entry of rhfPathsForFieldErrors(nextFieldErrors)) {
        setError(entry.name, { type: "validate", message: entry.message });
      }
    },
  });
  const { armLeave, requestLeave } = useUnsavedGuard({
    dirty: isDirty,
    pending: saveApi.pending,
    copy: formCopy,
    sheetOpen: sheets.customerSheetOpen || sheets.productSheetOpen,
    closeSheet: sheets.closeAllSheets,
  });
  armLeaveRef.current = armLeave;

  const failure = saveApi.isMutationError
    ? describeQueryFailure(saveApi.mutationError)
    : null;
  const wire = saveApi.isMutationError
    ? describeWireError(saveApi.mutationError)
    : null;
  const serverFields = saveApi.isMutationError
    ? (mapValidationIssues(saveApi.mutationError, saveApi.lastWrite) ??
      mapVariantSelectionConflict(saveApi.mutationError))
    : null;
  const pending = saveApi.pending;
  const catalogFactsBlocked = catalogFactsBlockSubmit(
    lookups.catalogFactsStatus,
  );
  const resolved = presentOrderFormCopy({
    formCopy,
    submitted: isSubmitted,
    customerMessage: errors.customerId?.message,
    itemsError: errors.items,
    commentMessage: errors.comment?.message,
    serverFields,
    localBanner,
    failureKind: failure?.kind ?? null,
    wireCode: wire?.code ?? null,
    pending,
    clientReady,
    canCreate,
  });
  const showSubmit =
    orderCreateScreenActions({ canCreate }).showSubmit &&
    resolved.showSubmit &&
    loadState.kind === "ready";

  const items = useMemo(() => presentOrderFormItems(fields), [fields]);
  const picks = productPickerPicks(sheets.picker);
  const productSelectRows = useMemo(
    () =>
      presentProductSelectRows({
        productRows: lookups.productRows,
        thumbnailsByProductId: lookups.thumbnailsByProductId,
        picks,
        formCopy,
        locale,
      }),
    [
      formCopy,
      locale,
      lookups.productRows,
      lookups.thumbnailsByProductId,
      picks,
    ],
  );
  const variantSelectRows = useMemo(
    () => presentVariantSelectRows(lookups.variantOptions),
    [lookups.variantOptions],
  );
  const dispatchPicker = sheets.dispatchPicker;

  function onFieldEdit(): void {
    clearErrors();
    setLocalBanner(null);
    saveApi.resetMutation();
  }

  function confirmProductPicks(): void {
    const result = commitProductPickerPicks(
      cloneOrderFormDraft(getValues()),
      productPickerPicks(sheets.pickerRef.current),
    );
    for (const line of result.lines) {
      append(line);
    }
    if (result.lines.length > 0) {
      setValue("nextDraftSerial", result.draft.nextDraftSerial, {
        shouldDirty: true,
      });
      onFieldEdit();
    }
    if (result.rejected !== null) {
      setLocalBanner(result.rejected);
    }
    dispatchPicker({ type: "close" });
  }

  function pickCustomer(id: string): void {
    const option = lookups.customerOptions.find((row) => row.id === id);
    setValue("customerId", id, { shouldDirty: true });
    setValue("customerName", option?.name ?? "", { shouldDirty: true });
    setCustomerPhone(option?.description);
    sheets.closeCustomerSheet();
    onFieldEdit();
  }

  const toggleProduct = useCallback(
    (id: string) => {
      const row = lookups.productRows.find((item) => item.id === id);
      if (row === undefined) {
        return;
      }
      if (row.variantCount > 0) {
        dispatchPicker({
          type: "openVariants",
          productId: row.id,
          productName: row.name,
        });
        return;
      }
      dispatchPicker({
        type: "toggleSimple",
        productId: row.id,
        productName: row.name,
      });
    },
    [dispatchPicker, lookups.productRows],
  );

  const pickVariant = useCallback(
    (id: string) => {
      const current = sheets.pickerRef.current;
      if (current.kind !== "variants") {
        return;
      }
      const option = lookups.variantOptions.find((row) => row.id === id);
      dispatchPicker({
        type: "pickVariant",
        variantId: id,
        variantName:
          option?.name != null && option.name.length > 0 ? option.name : null,
      });
    },
    [dispatchPicker, lookups.variantOptions, sheets.pickerRef],
  );

  const customerId = watch("customerId");
  const customerName = watch("customerName");

  return {
    copy,
    control,
    items,
    state: loadState,
    customerError: resolved.customerError,
    itemsError:
      lookups.catalogFactsStatus === "error"
        ? formCopy.variantsError
        : resolved.itemsError,
    commentError: resolved.commentError,
    banner: resolved.banner,
    pending,
    submitDisabled:
      resolved.submitDisabled ||
      loadState.kind !== "ready" ||
      catalogFactsBlocked,
    submitLabel: resolved.submitLabel,
    fieldsEditable: resolved.fieldsEditable && loadState.kind === "ready",
    showSubmit,
    customerName: customerName.length > 0 ? customerName : undefined,
    customerPhone,
    productsValue: presentProductsValue(
      items.length,
      formCopy.addProductsValue,
    ),
    footer: presentOrderFormFooter({
      itemCount: items.length,
      locale,
      items: copy.items,
      emptyLabel: formCopy.emptyPositions,
    }),
    customerSheetOpen: sheets.customerSheetOpen,
    productSheetOpen: sheets.productSheetOpen,
    productPickerSessionOpen: sheets.productPickerSessionOpen,
    productPickerLevel: sheets.productPickerLevel,
    productPickerVariantsTitle: sheets.productPickerVariantsTitle,
    customerOptions: lookups.customerOptions,
    customerQuery: lookups.customerQuery,
    onCustomerQueryChange: lookups.onCustomerQueryChange,
    customersLoadingMore: lookups.customersLoadingMore,
    onCustomersEndReached: lookups.onCustomersEndReached,
    productQuery: lookups.productQuery,
    onProductQueryChange: lookups.onProductQueryChange,
    productsLoadingMore: lookups.productsLoadingMore,
    onProductsEndReached: lookups.onProductsEndReached,
    productSelectRows,
    variantSelectRows,
    variantsStatus: lookups.variantsStatus,
    selectedCustomerId: customerId.length > 0 ? customerId : null,
    selectedProductIds: sheets.selectedProductIds,
    selectedVariantIds: sheets.selectedVariantIds,
    productPickCount: sheets.productPickCount,
    lineThumbnail: (productId: string) =>
      lookups.thumbnailsByProductId.get(productId) ?? EMPTY_ORDER_THUMBNAIL,
    onFieldEdit,
    requestLeave,
    openCustomerSheet: sheets.openCustomerSheet,
    openProductsSheet: sheets.openProductsSheet,
    closeCustomerSheet: sheets.closeCustomerSheet,
    closeProductSheet: sheets.closeProductSheet,
    backFromVariants: sheets.backFromVariants,
    pickCustomer,
    toggleProduct,
    confirmProductPicks,
    pickVariant,
    stepLine: (index: number, deltaUnits: number) => {
      const current = getValues().items[index];
      if (current === undefined) {
        return;
      }
      update(index, {
        ...current,
        quantityMilli: stepQuantityMilli(current.quantityMilli, deltaUnits),
      });
      onFieldEdit();
    },
    removeLine: (index: number) => {
      remove(index);
      onFieldEdit();
    },
    save: () => {
      if (catalogFactsBlocked) {
        return;
      }
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
