/**
 * Canvas DocumentEditor as create-only (SHO-238 / SHO-306 / SHO-366).
 * Shared: FormScreenScaffold, AppHeader, Button, Banner, EmptyState,
 * OptionSelectSheet, SelectorRow, FormTextField (Підстава).
 * Feature: EditorSection, DocumentTypeCards, DocumentLayoutCards.
 * Omitted: company template gallery, agreement, city, dates, QES, four
 * types, react-pdf / live PDF before create.
 */
import { FileTextIcon, UserIcon } from "lucide-react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

import { FormScreenScaffold } from "../../../components/form-kit";
import { Banner, OptionSelectSheet, SelectorRow } from "../../../components/ui";
import { DocumentHandoverSheet } from "../share/document-handover-sheet";
import {
  LIST_COUNTERPARTIES_SEARCH_MAX,
  LIST_ORDERS_QUERY_MAX,
} from "../shared/document-caps";
import {
  DocumentBasisField,
  DocumentLayoutCards,
  DocumentTypeCards,
} from "./document-form-fields";
import { EditorSection } from "./editor-section";
import type { DocumentFormModel } from "./use-document-form";

export function DocumentFormView(model: DocumentFormModel) {
  const form = model.copy.form;

  return (
    <FormScreenScaffold
      title={model.copy.createLabel}
      accessibilityLabel={model.copy.createLabel}
      backLabel={model.copy.backLabel}
      onBack={model.requestLeave}
      loadKind={model.state.kind}
      loadingLabel={form.loadingLabel}
      empty={{
        offlineTitle: model.copy.empty.offlineTitle,
        offlineDescription: model.copy.empty.offlineDescription,
        errorTitle: model.copy.empty.errorTitle,
        errorDescription: form.errors.unavailable,
        permissionTitle: form.permissionCreateTitle,
        permissionDescription: form.permissionCreateDescription,
        retryLabel: model.copy.empty.retry,
      }}
      {...(model.state.kind === "ready" && model.showSubmit
        ? {
            footer: {
              cancelLabel: form.cancel,
              submitLabel: model.submitLabel,
              pending: model.pending,
              submitDisabled: model.submitDisabled,
              onCancel: model.requestLeave,
              onSubmit: model.save,
            },
          }
        : {})}
      overlay={
        <>
          <OptionSelectSheet
            visible={model.orderSheetOpen}
            title={form.orderSheetTitle}
            searchPlaceholder={form.orderSearchPlaceholder}
            searchLabel={form.orderSearchLabel}
            closeLabel={form.closeSheet}
            emptyLabel={form.orderEmpty}
            value={model.selectedOrderId}
            options={model.orderOptions}
            searchMaxLength={LIST_ORDERS_QUERY_MAX}
            query={model.orderQuery}
            onQueryChange={model.onOrderQueryChange}
            loadingMore={model.ordersLoadingMore}
            loadingMoreLabel={form.pickerLoadingMoreLabel}
            onEndReached={model.onOrdersEndReached}
            onClose={model.closeOrderSheet}
            onChange={(id) => {
              if (id !== null) {
                model.pickOrder(id);
              }
            }}
          />
          <OptionSelectSheet
            visible={model.counterpartySheetOpen}
            title={form.counterpartySheetTitle}
            searchPlaceholder={form.counterpartySearchPlaceholder}
            searchLabel={form.counterpartySearchLabel}
            closeLabel={form.closeSheet}
            emptyLabel={form.counterpartyEmpty}
            emptyOptionLabel={form.counterpartyEmptyOption}
            value={model.selectedCounterpartyId}
            options={model.counterpartyOptions}
            searchMaxLength={LIST_COUNTERPARTIES_SEARCH_MAX}
            onClose={model.closeCounterpartySheet}
            onChange={model.pickCounterparty}
          />
          <DocumentHandoverSheet
            visible={model.handoverVisible}
            title={model.handoverTitle}
            url={model.handoverUrl}
            copy={model.copy}
            copied={model.copied}
            copyFailed={model.copyFailed}
            onClose={model.closeHandover}
            onHidden={model.onHandoverHidden}
            onCopy={() => {
              void model.copyHandover();
            }}
            onShare={() => {
              void model.shareHandover();
            }}
            onPrint={model.printHandover}
          />
        </>
      }
    >
      <DocumentFormReady model={model} />
    </FormScreenScaffold>
  );
}

function DocumentFormReady(props: { readonly model: DocumentFormModel }) {
  const { model } = props;
  const { theme } = useUnistyles();
  const form = model.copy.form;

  return (
    <KeyboardAwareScrollView
      style={styles.scroll}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      bottomOffset={theme.spacing.lg}
    >
      {model.banner !== null ? <Banner message={model.banner} /> : null}
      <EditorSection title={form.typeSectionTitle}>
        <DocumentTypeCards
          copy={form}
          value={model.type}
          disabled={!model.fieldsEditable}
          onChange={model.setType}
        />
      </EditorSection>
      {model.layoutSectionVisible ? (
        <EditorSection title={form.layoutSectionTitle}>
          <DocumentLayoutCards
            copy={form}
            cards={model.layoutCards}
            value={model.layoutKey}
            disabled={!model.fieldsEditable}
            loading={model.layoutsStatus === "loading"}
            failed={model.layoutsStatus === "error"}
            error={model.layoutError}
            preview={model.layoutPreview}
            onRetry={model.retryLayouts}
            onChange={model.pickLayout}
          />
        </EditorSection>
      ) : null}
      {model.basisVisible ? (
        <EditorSection title={form.basisSectionTitle}>
          <DocumentBasisField
            control={model.control}
            copy={form}
            editable={model.fieldsEditable}
            error={model.basisError}
            onFieldEdit={model.onFieldEdit}
          />
        </EditorSection>
      ) : null}
      <EditorSection title={form.orderSectionTitle}>
        <SelectorRow
          label={form.orderLabel}
          value={model.orderValue}
          subtitle={model.orderSubtitle}
          placeholder={form.orderPlaceholder}
          icon={
            <FileTextIcon
              size={theme.iconSize.sm}
              color={theme.colors.mutedForeground}
            />
          }
          error={model.orderError}
          disabled={!model.fieldsEditable}
          onPress={model.openOrderSheet}
        />
      </EditorSection>
      <EditorSection title={form.counterpartySectionTitle}>
        <SelectorRow
          label={form.counterpartyLabel}
          value={model.counterpartyValue}
          subtitle={model.counterpartySubtitle}
          placeholder={
            model.counterpartyEnabled
              ? form.counterpartyPlaceholder
              : form.counterpartyDisabledPlaceholder
          }
          icon={
            <UserIcon
              size={theme.iconSize.sm}
              color={theme.colors.mutedForeground}
            />
          }
          disabled={!model.fieldsEditable || !model.counterpartyEnabled}
          onPress={model.openCounterpartySheet}
        />
      </EditorSection>
    </KeyboardAwareScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  scroll: {
    flex: 1,
  },
  content: {
    paddingHorizontal: theme.spacing.lg,
    paddingBottom: theme.spacing.lg,
    gap: theme.spacing.lg,
  },
}));
