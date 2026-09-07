import { describe, expect, it } from "vitest";

import { sharedAuthCopy } from "./auth.js";
import { leafAt, leafPaths } from "./leaf-paths.js";

describe("shared auth copy", () => {
  it("keeps uk/en key parity across the shared tree", () => {
    const uk = sharedAuthCopy("uk");
    const en = sharedAuthCopy("en");
    expect(leafPaths(uk)).toEqual(leafPaths(en));
    for (const path of leafPaths(uk)) {
      const ukValue = leafAt(uk, path);
      const enValue = leafAt(en, path);
      expect(typeof ukValue, path).toBe("string");
      expect(typeof enValue, path).toBe("string");
      expect(String(ukValue).length, path).toBeGreaterThan(0);
      expect(String(enValue).length, path).toBeGreaterThan(0);
    }
  });

  it("does not absorb app-only auth keys", () => {
    const shared = sharedAuthCopy("uk");
    expect("welcomeMessage" in shared).toBe(false);
    expect("otpDigit" in shared).toBe(false);
  });

  it("owns string-literal error keys without app AuthErrorKind", () => {
    const shared = sharedAuthCopy("en");
    expect(Object.keys(shared.errors)).toEqual([
      "invalid_identifier",
      "invalid_otp",
      "resend_limited",
      "verify_locked",
      "unauthenticated",
      "unavailable",
      "network",
    ]);
  });

  it("pins shared auth strings byte-identical to both apps", () => {
    expect(sharedAuthCopy("uk")).toEqual({
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
    });
    expect(sharedAuthCopy("en")).toEqual({
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
    });
  });
});
