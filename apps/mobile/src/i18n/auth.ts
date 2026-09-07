/** Auth copy namespace (uk/en). Shared strings live in `@showzy/copy/auth`. */
import { selectCopy, type Locale } from "@showzy/copy/locale";
import { sharedAuthCopy, type SharedAuthCopy } from "@showzy/copy/auth";

import type { AuthErrorKind } from "../auth/errors";

export type AuthCopy = SharedAuthCopy & {
  readonly welcomeMessage: string;
};

type MobileAuthExtension = {
  readonly welcomeMessage: string;
};

const extraEn: MobileAuthExtension = {
  welcomeMessage: "Discover amazing products and companies",
};

const extraUk: MobileAuthExtension = {
  welcomeMessage: "Відкривайте чудові товари та компанії",
};

export function authCopy(locale: Locale): AuthCopy {
  const shared = sharedAuthCopy(locale);
  const extra = selectCopy(locale, { uk: extraUk, en: extraEn });
  return { ...shared, ...extra };
}

export type VerifyMessageParts = {
  readonly before: string;
  readonly after: string;
};

const DESTINATION_PLACEHOLDER = "{{destination}}";

/**
 * Split a verify template around the first `{{destination}}` so the screen
 * can render the destination as a nested selectable `Text`. Extra
 * occurrences stay in `after` (`.split` would drop the tail).
 */
export function verifyMessageParts(template: string): VerifyMessageParts {
  const index = template.indexOf(DESTINATION_PLACEHOLDER);
  if (index === -1) {
    return { before: template, after: "" };
  }
  return {
    before: template.slice(0, index),
    after: template.slice(index + DESTINATION_PLACEHOLDER.length),
  };
}

export function errorCopy(copy: AuthCopy, kind: AuthErrorKind): string {
  return copy.errors[kind];
}
