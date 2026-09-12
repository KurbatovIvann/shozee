import type { ReactNode } from "react";
import { Text, View } from "react-native";
import { BuildingIcon, Trash2Icon, UserIcon } from "lucide-react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

import { FormScreenScaffold } from "../../../components/form-kit";
import {
  Banner,
  Button,
  OptionSelectSheet,
  SelectorRow,
} from "../../../components/ui";
import { LIST_GROUPS_SEARCH_MAX } from "../shared/customer-caps";
import {
  CounterpartyFormBankMfoField,
  CounterpartyFormBankNameField,
  CounterpartyFormEdrpouField,
  CounterpartyFormEmailField,
  CounterpartyFormIbanField,
  CounterpartyFormLegalAddressField,
  CounterpartyFormNameField,
  CounterpartyFormNotesField,
  CounterpartyFormPhoneField,
} from "./counterparty-form-fields";
import type { CounterpartyFormModel } from "./use-counterparty-form";

export function CounterpartyFormView(model: CounterpartyFormModel) {
  const { copy } = model;
  const form = copy.counterpartyForm;
  const { theme } = useUnistyles();
  const iconColor = theme.colors.mutedForeground;
  const retryEdit =
    model.state.kind === "offline" ||
    (model.state.kind === "error" && model.mode === "edit");

  return (
    <FormScreenScaffold
      title={model.headerTitle}
      accessibilityLabel={model.headerTitle}
      backLabel={copy.backLabel}
      onBack={model.requestLeave}
      loadKind={model.state.kind}
      loadingLabel={form.loadingLabel}
      empty={{
        offlineTitle: copy.empty.offlineTitle,
        offlineDescription: copy.empty.offlineDescription,
        errorTitle: copy.empty.errorTitle,
        errorDescription: copy.empty.errorDescription,
        permissionTitle:
          model.mode === "create"
            ? form.permissionCreateTitle
            : form.permissionEditTitle,
        permissionDescription:
          model.mode === "create"
            ? form.permissionCreateDescription
            : form.permissionEditDescription,
        retryLabel: copy.empty.retry,
        notFoundTitle: form.notFoundTitle,
        notFoundDescription: form.notFoundDescription,
        notFoundIcon: (
          <BuildingIcon size={theme.iconSize.md} color={iconColor} />
        ),
      }}
      {...(retryEdit ? { onRetry: model.retry } : {})}
      {...(model.state.kind === "ready"
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
        <OptionSelectSheet
          visible={model.pickerOpen}
          title={form.customerSheetTitle}
          emptyOptionLabel={form.customerEmptyOption}
          emptyLabel={form.customerEmpty}
          searchPlaceholder={form.customerSearchPlaceholder}
          searchLabel={copy.searchLabel}
          closeLabel={form.closeSheet}
          value={model.customerId}
          options={model.customerOptions}
          searchMaxLength={LIST_GROUPS_SEARCH_MAX}
          onClose={model.closePicker}
          onChange={model.selectCustomer}
          query={model.customerQuery}
          onQueryChange={model.onCustomerQueryChange}
          loadingMore={model.customersLoadingMore}
          loadingMoreLabel={form.pickerLoadingMoreLabel}
          onEndReached={model.onCustomersEndReached}
          loadMoreLabel={form.pickerLoadMoreLabel}
        />
      }
    >
      <CounterpartyFormReady model={model} />
    </FormScreenScaffold>
  );
}

function CounterpartyFormReady(props: {
  readonly model: CounterpartyFormModel;
}) {
  const { model } = props;
  const { copy } = model;
  const form = copy.counterpartyForm;
  const { theme } = useUnistyles();
  const iconColor = theme.colors.mutedForeground;

  return (
    <KeyboardAwareScrollView
      style={styles.scroll}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      bottomOffset={theme.spacing.lg}
    >
      <CounterpartyFormSection title={form.customerTitle}>
        <Text style={styles.hint}>{form.customerHelper}</Text>
        <SelectorRow
          label={form.customerLabel}
          value={model.customerValue}
          placeholder={form.customerPlaceholder}
          icon={<UserIcon size={theme.iconSize.sm} color={iconColor} />}
          changed={model.customerChanged}
          changedLabel={form.changedLabel}
          disabled={!model.fieldsEditable}
          onPress={model.openCustomerPicker}
        />
        {model.showOpenClient ? (
          <Button
            variant="secondary"
            fullWidth
            label={form.openClient}
            disabled={model.pending}
            onPress={model.openClient}
          />
        ) : null}
      </CounterpartyFormSection>
      <CounterpartyFormSection title={form.requisitesTitle}>
        <CounterpartyFormNameField
          control={model.control}
          copy={form}
          mode={model.mode}
          originName={model.originName}
          editable={model.fieldsEditable}
          error={model.nameError}
          onFieldEdit={model.onFieldEdit}
        />
        <CounterpartyFormEdrpouField
          control={model.control}
          copy={form}
          mode={model.mode}
          originEdrpou={model.originEdrpou}
          editable={model.fieldsEditable}
          error={model.edrpouError}
          onFieldEdit={model.onFieldEdit}
        />
        <CounterpartyFormLegalAddressField
          control={model.control}
          copy={form}
          mode={model.mode}
          originLegalAddress={model.originLegalAddress}
          editable={model.fieldsEditable}
          error={model.legalAddressError}
          onFieldEdit={model.onFieldEdit}
        />
      </CounterpartyFormSection>
      <CounterpartyFormSection title={form.bankTitle}>
        <CounterpartyFormIbanField
          control={model.control}
          copy={form}
          mode={model.mode}
          originIban={model.originIban}
          editable={model.fieldsEditable}
          error={model.ibanError}
          onFieldEdit={model.onFieldEdit}
        />
        <CounterpartyFormBankNameField
          control={model.control}
          copy={form}
          mode={model.mode}
          originBankName={model.originBankName}
          editable={model.fieldsEditable}
          error={model.bankNameError}
          onFieldEdit={model.onFieldEdit}
        />
        <CounterpartyFormBankMfoField
          control={model.control}
          copy={form}
          mode={model.mode}
          originBankMfo={model.originBankMfo}
          editable={model.fieldsEditable}
          error={model.bankMfoError}
          onFieldEdit={model.onFieldEdit}
        />
      </CounterpartyFormSection>
      <CounterpartyFormSection title={form.contactsTitle}>
        <CounterpartyFormPhoneField
          control={model.control}
          copy={form}
          mode={model.mode}
          originPhone={model.originPhone}
          editable={model.fieldsEditable}
          error={model.phoneError}
          onFieldEdit={model.onFieldEdit}
        />
        <CounterpartyFormEmailField
          control={model.control}
          copy={form}
          mode={model.mode}
          originEmail={model.originEmail}
          editable={model.fieldsEditable}
          error={model.emailError}
          onFieldEdit={model.onFieldEdit}
        />
        <CounterpartyFormNotesField
          control={model.control}
          copy={form}
          mode={model.mode}
          originNotes={model.originNotes}
          editable={model.fieldsEditable}
          error={model.notesError}
          onFieldEdit={model.onFieldEdit}
        />
      </CounterpartyFormSection>
      {model.showDelete ? (
        <CounterpartyFormSection title={form.deleteTitle}>
          <Text style={styles.hint}>{form.deleteHelper}</Text>
          <Button
            variant="danger"
            fullWidth
            label={form.deleteAction}
            disabled={model.pending}
            icon={
              <Trash2Icon
                size={theme.iconSize.sm}
                color={theme.colors.destructive}
              />
            }
            onPress={() => {
              void model.remove();
            }}
          />
        </CounterpartyFormSection>
      ) : null}
      {model.banner !== null && model.banner.length > 0 ? (
        <Banner message={model.banner} />
      ) : null}
    </KeyboardAwareScrollView>
  );
}

function CounterpartyFormSection(props: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{props.title}</Text>
      <View style={styles.sectionCard}>{props.children}</View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  scroll: {
    flex: 1,
  },
  content: {
    paddingHorizontal: theme.spacing.lg,
    paddingTop: theme.spacing.sm,
    paddingBottom: theme.spacing.xl,
    gap: theme.spacing.xl,
  },
  section: {
    gap: theme.spacing.sm,
  },
  sectionTitle: {
    color: theme.colors.mutedForeground,
    fontSize: theme.typography.xs.fontSize,
    lineHeight: theme.typography.xs.lineHeight,
    fontWeight: "600",
    paddingHorizontal: theme.spacing.xs,
  },
  sectionCard: {
    backgroundColor: theme.colors.card,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.radii.card,
    ...theme.squircle,
    padding: theme.spacing.lg,
    gap: theme.spacing.md,
    ...theme.shadows.sm,
  },
  hint: {
    color: theme.colors.mutedForeground,
    fontSize: theme.typography.xs.fontSize,
    lineHeight: theme.typography.xs.lineHeight,
  },
}));
