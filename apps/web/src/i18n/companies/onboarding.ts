/** Company onboarding copy namespace (uk/en). Shared strings live in `@showzy/copy/companies`. */
import { interpolate, selectCopy, type Locale } from "@showzy/copy/locale";
import {
  sharedCompaniesLegalCopy,
  sharedCompaniesOnboardingCopy,
  type SharedCompaniesLegalCopy,
  type SharedCompaniesOnboardingCopy,
} from "@showzy/copy/companies";

export type OnboardingCopy = {
  readonly companyTitle: string;
  readonly companySubtitle: string;
  readonly nameLabel: string;
  readonly namePlaceholder: string;
  readonly slugLabel: string;
  readonly slugPlaceholder: string;
  readonly slugPreview: string;
  readonly createSubmit: string;
  readonly createSubmitLoading: string;
  readonly legalTitle: string;
  readonly legalSubtitle: string;
  readonly legalSkip: string;
  readonly typeLabel: string;
  readonly typeFop: string;
  readonly typeTov: string;
  readonly companySection: string;
  readonly legalNameLabel: string;
  readonly legalNamePlaceholder: string;
  readonly edrpouLabel: string;
  readonly edrpouPlaceholder: string;
  readonly legalAddressLabel: string;
  readonly legalAddressPlaceholder: string;
  readonly bankSection: string;
  readonly ibanLabel: string;
  readonly ibanPlaceholder: string;
  readonly bankNameLabel: string;
  readonly bankNamePlaceholder: string;
  readonly bankMfoLabel: string;
  readonly bankMfoPlaceholder: string;
  readonly legalSubmit: string;
  readonly legalSubmitLoading: string;
  readonly stepLabel: string;
  readonly errors: {
    readonly nameRequired: string;
    readonly nameTooLong: string;
    readonly slugInvalid: string;
    readonly slugOccupied: string;
    readonly legalNameRequired: string;
    readonly legalNameTooLong: string;
    readonly tooLong: string;
    readonly validation: string;
    readonly network: string;
    readonly unavailable: string;
  };
};

type WebOnboardingExtension = {
  readonly slugPreview: string;
  readonly legalTitle: string;
  readonly legalSubtitle: string;
  readonly legalSkip: string;
  readonly edrpouPlaceholder: string;
  readonly legalSubmit: string;
  readonly legalSubmitLoading: string;
  readonly stepLabel: string;
  readonly errors: {
    readonly legalNameTooLong: string;
    readonly tooLong: string;
    readonly validation: string;
  };
};

const extraEn: WebOnboardingExtension = {
  slugPreview: "shozee.com.ua/{{slug}}",
  legalTitle: "Legal details",
  legalSubtitle:
    "Requisites for invoices and documents. You can fill them in later.",
  legalSkip: "Fill in later in settings",
  edrpouPlaceholder: "12345678",
  legalSubmit: "Save and continue",
  legalSubmitLoading: "Saving…",
  stepLabel: "Step {{step}} of {{total}}",
  errors: {
    legalNameTooLong: "Legal name is too long",
    tooLong: "This value is too long",
    validation: "Check the fields and try again.",
  },
};

const extraUk: WebOnboardingExtension = {
  slugPreview: "shozee.com.ua/{{slug}}",
  legalTitle: "Юридичні дані",
  legalSubtitle:
    "Реквізити для рахунків і документів. Можна заповнити пізніше.",
  legalSkip: "Заповнити пізніше в налаштуваннях",
  edrpouPlaceholder: "12345678",
  legalSubmit: "Зберегти та продовжити",
  legalSubmitLoading: "Зберігаємо…",
  stepLabel: "Крок {{step}} з {{total}}",
  errors: {
    legalNameTooLong: "Юридична назва занадто довга",
    tooLong: "Значення занадто довге",
    validation: "Перевірте поля і спробуйте ще раз.",
  },
};

export function onboardingCopy(locale: Locale): OnboardingCopy {
  const shared = sharedCompaniesOnboardingCopy(locale);
  const legal = sharedCompaniesLegalCopy(locale);
  const extra = selectCopy(locale, { uk: extraUk, en: extraEn });
  return composeWebOnboardingCopy(shared, legal, extra);
}

function composeWebOnboardingCopy(
  shared: SharedCompaniesOnboardingCopy,
  legal: SharedCompaniesLegalCopy,
  extra: WebOnboardingExtension,
): OnboardingCopy {
  return {
    companyTitle: shared.title,
    companySubtitle: shared.subtitle,
    nameLabel: shared.nameLabel,
    namePlaceholder: shared.namePlaceholder,
    slugLabel: shared.slugLabel,
    slugPlaceholder: shared.slugPlaceholder,
    slugPreview: extra.slugPreview,
    createSubmit: shared.submit,
    createSubmitLoading: shared.submitLoading,
    legalTitle: extra.legalTitle,
    legalSubtitle: extra.legalSubtitle,
    legalSkip: extra.legalSkip,
    typeLabel: legal.typeLabel,
    typeFop: legal.typeFop,
    typeTov: legal.typeTov,
    companySection: legal.companyTitle,
    legalNameLabel: legal.legalNameLabel,
    legalNamePlaceholder: legal.legalNamePlaceholder,
    edrpouLabel: legal.edrpouLabel,
    edrpouPlaceholder: extra.edrpouPlaceholder,
    legalAddressLabel: legal.legalAddressLabel,
    legalAddressPlaceholder: legal.legalAddressPlaceholder,
    bankSection: legal.bankTitle,
    ibanLabel: legal.ibanLabel,
    ibanPlaceholder: legal.ibanPlaceholder,
    bankNameLabel: legal.bankNameLabel,
    bankNamePlaceholder: legal.bankNamePlaceholder,
    bankMfoLabel: legal.bankMfoLabel,
    bankMfoPlaceholder: legal.bankMfoPlaceholder,
    legalSubmit: extra.legalSubmit,
    legalSubmitLoading: extra.legalSubmitLoading,
    stepLabel: extra.stepLabel,
    errors: {
      ...shared.errors,
      legalNameRequired: legal.errors.legalNameRequired,
      ...extra.errors,
    },
  };
}

export function slugPreviewCopy(copy: OnboardingCopy, slug: string): string {
  return interpolate(copy.slugPreview, {
    slug: slug.length === 0 ? "…" : slug,
  });
}

export function stepLabelCopy(
  copy: OnboardingCopy,
  step: number,
  total: number,
): string {
  return interpolate(copy.stepLabel, {
    step: String(step),
    total: String(total),
  });
}
