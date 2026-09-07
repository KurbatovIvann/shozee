/** Company onboarding copy namespace (uk/en). Shared strings live in `@showzy/copy/companies`. */
import { selectCopy, type Locale } from "@showzy/copy/locale";
import {
  sharedCompaniesOnboardingCopy,
  type SharedCompaniesOnboardingCopy,
} from "@showzy/copy/companies";

export type OnboardingCopy = SharedCompaniesOnboardingCopy & {
  readonly slugHint: string;
  readonly errors: SharedCompaniesOnboardingCopy["errors"] & {
    readonly validation: string;
    readonly offline: string;
  };
};

type MobileOnboardingExtension = {
  readonly slugHint: string;
  readonly errors: {
    readonly validation: string;
    readonly offline: string;
  };
};

const extraEn: MobileOnboardingExtension = {
  slugHint: "The address of your public page on Shozee.",
  errors: {
    validation: "Check the name and address and try again.",
    offline: "You're offline. Check your connection and try again.",
  },
};

const extraUk: MobileOnboardingExtension = {
  slugHint: "Адреса вашої публічної сторінки на Шозі.",
  errors: {
    validation: "Перевірте назву та адресу і спробуйте ще раз.",
    offline: "Немає мережі. Перевірте з’єднання і спробуйте ще раз.",
  },
};

export function onboardingCopy(locale: Locale): OnboardingCopy {
  const shared = sharedCompaniesOnboardingCopy(locale);
  const extra = selectCopy(locale, { uk: extraUk, en: extraEn });
  return {
    ...shared,
    ...extra,
    errors: { ...shared.errors, ...extra.errors },
  };
}
