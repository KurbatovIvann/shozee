/** Auth copy namespace (uk/en). Shared strings live in `@showzy/copy/auth`. */
import { interpolate, selectCopy, type Locale } from "@showzy/copy/locale";
import { sharedAuthCopy, type SharedAuthCopy } from "@showzy/copy/auth";

import type { AuthErrorKind } from "../auth/errors";
import type { AuthChannel } from "../auth/otp/identifiers";

export type AuthCopy = SharedAuthCopy & {
  readonly otpDigit: string;
};

type WebAuthExtension = {
  readonly otpDigit: string;
};

const extraEn: WebAuthExtension = {
  otpDigit: "Digit {{n}}",
};

const extraUk: WebAuthExtension = {
  otpDigit: "Цифра {{n}}",
};

export function authCopy(locale: Locale): AuthCopy {
  const shared = sharedAuthCopy(locale);
  const extra = selectCopy(locale, { uk: extraUk, en: extraEn });
  return { ...shared, ...extra };
}

export function verifyMessage(
  copy: AuthCopy,
  channel: AuthChannel,
  destination: string,
): string {
  const template =
    channel === "phone" ? copy.verifyPhoneMessage : copy.verifyEmailMessage;
  return interpolate(template, { destination });
}

export function errorCopy(copy: AuthCopy, kind: AuthErrorKind): string {
  return copy.errors[kind];
}
