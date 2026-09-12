/**
 * Canvas OrderEditor as create-only (SHO-242).
 * Shared: AppHeader, Button, EditorFooter, TextField, SearchField, Sheet,
 * EmptyState, Banner, OptionSelectSheet, SelectorRow.
 * Feature: EditorSection, OrderLineCard, QuantityStepper,
 * ProductSelectSheet (products + in-sheet variant drill-down).
 * OptionSelectSheet is customers only — never stacked on the product Modal.
 * Omitted: payment, delivery, due date, status picker, discount, line
 * prices, and the order-total row (owner decision 2 — footer is line count).
 */
import type { ReactNode } from "react";
import { View } from "react-native";
import {
  LockIcon,
  PackagePlusIcon,
  UserIcon,
  WifiOffIcon,
} from "lucide-react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { SafeAreaView } from "react-native-safe-area-context";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

import { LIST_PRODUCTS_QUERY_MAX } from "@showzy/validation/catalog";
import { LIST_CUSTOMERS_SEARCH_MAX } from "@showzy/validation/customers";

import {
  AppHeader,
  Banner,
  EditorFooter,
  EmptyState,
  OptionSelectSheet,
  SelectorRow,
} from "../../../components/ui";
import { EditorSection } from "./editor-section";
import { OrderFormCommentField } from "./order-form-fields";
import { OrderLineCard } from "./order-line-card";
import { ProductSelectSheet } from "./product-select-sheet";
import type { OrderFormModel } from "./use-order-form";

export function OrderFormView(model: OrderFormModel) {
  const form = model.copy.create;

  return (
    <SafeAreaView
      edges={["top", "bottom"]}
      accessibilityLabel={form.title}
      style={styles.screen}
    >
      <AppHeader
        title={form.title}
        back={{
          onPress: model.requestLeave,
          accessibilityLabel: form.backLabel,
        }}
      />
      <OrderFormBody model={model} />
      {model.state.kind === "ready" && model.showSubmit ? (
        <EditorFooter
          cancelLabel={form.cancel}
          confirmLabel={model.submitLabel}
          confirming={model.pending}
          confirmDisabled={model.submitDisabled}
          cancelDisabled={model.pending}
          onCancel={model.requestLeave}
          onConfirm={model.save}
          empty={model.footer.empty}
          emptyLabel={model.footer.emptyLabel}
          metaLabel={model.footer.metaLabel}
        />
      ) : null}
      <OptionSelectSheet
        visible={model.customerSheetOpen}
        title={form.customerSheetTitle}
        searchPlaceholder={form.customerSearchPlaceholder}
        searchLabel={form.customerSearchLabel}
        closeLabel={model.copy.closeSheet}
        emptyLabel={form.emptyCustomers}
        value={model.selectedCustomerId}
        options={model.customerOptions}
        searchMaxLength={LIST_CUSTOMERS_SEARCH_MAX}
        leading="user"
        onClose={model.closeCustomerSheet}
        onChange={(id) => {
          if (id !== null) {
            model.pickCustomer(id);
          }
        }}
        query={model.customerQuery}
        onQueryChange={model.onCustomerQueryChange}
        loadingMore={model.customersLoadingMore}
        loadingMoreLabel={form.pickerLoadingMoreLabel}
        onEndReached={model.onCustomersEndReached}
        loadMoreLabel={form.pickerLoadMoreLabel}
      />
      <ProductSelectSheet
        visible={model.productSheetOpen}
        sessionOpen={model.productPickerSessionOpen}
        level={model.productPickerLevel}
        title={form.productSheetTitle}
        variantsTitle={model.productPickerVariantsTitle}
        searchPlaceholder={form.productSearchPlaceholder}
        searchLabel={form.productSearchLabel}
        closeLabel={model.copy.closeSheet}
        backLabel={form.variantsBackLabel}
        emptyLabel={form.emptyProducts}
        variantsLoadingLabel={form.variantsLoading}
        variantsEmptyLabel={form.emptyVariants}
        variantsErrorLabel={form.variantsError}
        doneLabel={form.productSheetDone}
        thumbnailFailedLabel={form.thumbnailUnavailable}
        searchMaxLength={LIST_PRODUCTS_QUERY_MAX}
        selectedIds={model.selectedProductIds}
        selectedVariantIds={model.selectedVariantIds}
        doneCount={model.productPickCount}
        products={model.productSelectRows}
        variants={model.variantSelectRows}
        variantsStatus={model.variantsStatus}
        onClose={model.closeProductSheet}
        onBack={model.backFromVariants}
        onToggle={model.toggleProduct}
        onToggleVariant={model.pickVariant}
        onConfirm={model.confirmProductPicks}
        query={model.productQuery}
        onQueryChange={model.onProductQueryChange}
        loadingMore={model.productsLoadingMore}
        loadingMoreLabel={form.pickerLoadingMoreLabel}
        onEndReached={model.onProductsEndReached}
        loadMoreLabel={form.pickerLoadMoreLabel}
      />
    </SafeAreaView>
  );
}

function OrderFormBody(props: { readonly model: OrderFormModel }) {
  const { model } = props;
  const { theme } = useUnistyles();
  const iconColor = theme.colors.mutedForeground;
  const form = model.copy.create;

  switch (model.state.kind) {
    case "error":
      return (
        <CenteredEmpty>
          <EmptyState
            icon={<WifiOffIcon size={theme.iconSize.md} color={iconColor} />}
            title={model.copy.empty.errorTitle}
            description={form.errors.unavailable}
          />
        </CenteredEmpty>
      );
    case "permission":
      return (
        <CenteredEmpty>
          <EmptyState
            icon={<LockIcon size={theme.iconSize.md} color={iconColor} />}
            title={form.permissionTitle}
            description={form.permissionDescription}
          />
        </CenteredEmpty>
      );
    case "ready":
      return <OrderFormReady model={model} />;
  }
}

function OrderFormReady(props: { readonly model: OrderFormModel }) {
  const { model } = props;
  const { theme } = useUnistyles();
  const form = model.copy.create;

  return (
    <KeyboardAwareScrollView
      style={styles.scroll}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      bottomOffset={theme.spacing.lg}
    >
      {model.banner !== null ? <Banner message={model.banner} /> : null}
      <EditorSection title={form.itemsTitle}>
        {model.items.map((item, index) => {
          const thumbnail = model.lineThumbnail(item.productId);
          return (
            <OrderLineCard
              key={item.key}
              item={item}
              copy={form}
              editable={model.fieldsEditable}
              thumbnailFileId={thumbnail.fileId}
              thumbnailUrl={thumbnail.url}
              thumbnailFailed={thumbnail.failed}
              onStep={(delta) => {
                model.stepLine(index, delta);
              }}
              onRemove={() => {
                model.removeLine(index);
              }}
            />
          );
        })}
        <SelectorRow
          label={form.addProductsLabel}
          value={model.productsValue}
          placeholder={form.addProductsPlaceholder}
          icon={
            <PackagePlusIcon
              size={theme.iconSize.sm}
              color={theme.colors.mutedForeground}
            />
          }
          error={model.itemsError}
          disabled={!model.fieldsEditable}
          onPress={model.openProductsSheet}
        />
      </EditorSection>
      <EditorSection title={form.customerTitle}>
        <SelectorRow
          label={form.customerLabel}
          value={model.customerName}
          subtitle={model.customerPhone}
          placeholder={form.customerPlaceholder}
          icon={
            <UserIcon
              size={theme.iconSize.sm}
              color={theme.colors.mutedForeground}
            />
          }
          error={model.customerError}
          disabled={!model.fieldsEditable}
          onPress={model.openCustomerSheet}
        />
      </EditorSection>
      <EditorSection title={form.commentTitle}>
        <OrderFormCommentField
          control={model.control}
          copy={form}
          editable={model.fieldsEditable}
          error={model.commentError}
          onFieldEdit={model.onFieldEdit}
        />
      </EditorSection>
    </KeyboardAwareScrollView>
  );
}

function CenteredEmpty(props: { readonly children: ReactNode }) {
  return <View style={styles.centered}>{props.children}</View>;
}

const styles = StyleSheet.create((theme) => ({
  screen: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  scroll: {
    flex: 1,
  },
  content: {
    paddingHorizontal: theme.spacing.lg,
    paddingBottom: theme.spacing.lg,
    gap: theme.spacing.lg,
  },
  centered: {
    flex: 1,
    justifyContent: "center",
  },
}));
