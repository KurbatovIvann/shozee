/**
 * Staff auth copy shared by mobile and web (SHO-481).
 *
 * This is the intersection of byte-identical uk+en strings. Keys that
 * exist in only one app (`welcomeMessage`, `otpDigit`) stay in that app
 * as a typed extension of `SharedAuthCopy`. Do not "harmonise" those
 * leftovers here. Error keys are string literals — apps map
 * `AuthErrorKind` onto this record; this package must not import app
 * types. Verify helpers (`verifyMessageParts`, `verifyMessage`) stay in
 * the apps.
 */
import { selectCopy, type Locale } from "./locale.js";

export type SharedAuthErrorKey =
  | "invalid_identifier"
  | "invalid_otp"
  | "resend_limited"
  | "verify_locked"
  | "unauthenticated"
  | "unavailable"
  | "network";

export type SharedAuthErrorCopy = Readonly<Record<SharedAuthErrorKey, string>>;

export type SharedAuthCopy = {
  readonly welcome: string;
  readonly tagline: string;
  readonly phone: string;
  readonly email: string;
  readonly phoneLabel: string;
  readonly emailLabel: string;
  readonly phonePlaceholder: string;
  readonly emailPlaceholder: string;
  readonly continue: string;
  readonly continueLoading: string;
  readonly verifyTitle: string;
  readonly verifyPhoneMessage: string;
  readonly verifyEmailMessage: string;
  readonly verifyCode: string;
  readonly verifyLoading: string;
  readonly resendCode: string;
  readonly resendCodeIn: string;
  readonly wrongNumber: string;
  readonly wrongEmail: string;
  readonly loading: string;
  readonly retry: string;
  readonly errors: SharedAuthErrorCopy;
};

const en: SharedAuthCopy = {
  welcome: "Welcome",
  tagline: "Manage orders easily and confidently",
  phone: "Phone",
  email: "Email",
  phoneLabel: "Phone number",
  emailLabel: "Email address",
  phonePlaceholder: "XX XXX XX XX",
  emailPlaceholder: "your@email.com",
  continue: "Continue",
  continueLoading: "Please wait…",
  verifyTitle: "Confirm sign-in",
  verifyPhoneMessage: "We've sent a 6-digit code to {{destination}}",
  verifyEmailMessage: "We've sent a 6-digit code to {{destination}}",
  verifyCode: "Verify",
  verifyLoading: "Verifying…",
  resendCode: "Resend code",
  resendCodeIn: "Resend in {{seconds}}s",
  wrongNumber: "Change number",
  wrongEmail: "Change email",
  loading: "Loading",
  retry: "Retry",
  errors: {
    invalid_identifier: "Enter a valid phone number or email.",
    invalid_otp: "Invalid code. Check the digits and try again.",
    resend_limited: "Too many OTP requests. Try again later.",
    verify_locked: "Too many attempts. Request a new code.",
    unauthenticated: "Please sign in to continue",
    unavailable: "Something went wrong",
    network: "Network error. Please check your connection.",
  },
};

const uk: SharedAuthCopy = {
  welcome: "Ласкаво просимо",
  tagline: "Керуйте замовленнями легко та впевнено",
  phone: "Телефон",
  email: "Email",
  phoneLabel: "Номер телефону",
  emailLabel: "Email-адреса",
  phonePlaceholder: "XX XXX XX XX",
  emailPlaceholder: "ваш@email.com",
  continue: "Продовжити",
  continueLoading: "Зачекайте…",
  verifyTitle: "Підтвердження входу",
  verifyPhoneMessage: "Ми надіслали 6-значний код на {{destination}}",
  verifyEmailMessage: "Ми надіслали 6-значний код на {{destination}}",
  verifyCode: "Підтвердити",
  verifyLoading: "Перевіряємо…",
  resendCode: "Надіслати код повторно",
  resendCodeIn: "Надіслати повторно через {{seconds}} с",
  wrongNumber: "Змінити номер",
  wrongEmail: "Змінити email",
  loading: "Завантаження",
  retry: "Повторити",
  errors: {
    invalid_identifier: "Введіть коректний номер телефону або email.",
    invalid_otp: "Невірний код. Перевірте цифри та спробуйте ще раз.",
    resend_limited: "Забагато запитів коду. Спробуйте пізніше.",
    verify_locked: "Забагато спроб. Запросіть новий код.",
    unauthenticated: "Увійдіть, щоб продовжити",
    unavailable: "Щось пішло не так",
    network: "Помилка мережі. Перевірте з’єднання.",
  },
};

export function sharedAuthCopy(locale: Locale): SharedAuthCopy {
  return selectCopy(locale, { uk, en });
}
