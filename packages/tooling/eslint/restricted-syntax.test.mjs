import { test } from "node:test";

import { RuleTester } from "eslint";
import { builtinRules } from "eslint/use-at-your-own-risk";
import tseslint from "typescript-eslint";

import { SHOWZY_RESTRICTED_SYNTAX } from "./restricted-syntax.mjs";

const rule = builtinRules.get("no-restricted-syntax");
if (rule === undefined) {
  throw new Error("ESLint no longer ships no-restricted-syntax");
}

const tester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
    },
  },
});

const [doubleAssertion, verifiedCallerAssertion] = SHOWZY_RESTRICTED_SYNTAX;

test("no-restricted-syntax refuses a double assertion and any assertion to VerifiedAssistantCaller", () => {
  tester.run("no-restricted-syntax", rule, {
    valid: [
      {
        name: "a caller assertion that is not the verified brand",
        code: "declare const x: unknown; export const c = x as AssistantKitCaller;",
        options: SHOWZY_RESTRICTED_SYNTAX,
      },
      {
        name: "a verified caller received as a typed parameter",
        code: "export function run(caller: VerifiedAssistantCaller) { return caller; }",
        options: SHOWZY_RESTRICTED_SYNTAX,
      },
      {
        name: "a verified caller taken from the read that produced it",
        code: "declare const found: { caller: VerifiedAssistantCaller | null }; export const c: VerifiedAssistantCaller | null = found.caller;",
        options: SHOWZY_RESTRICTED_SYNTAX,
      },
    ],
    invalid: [
      {
        name: "as VerifiedAssistantCaller",
        code: "declare const job: unknown; export const c = job as VerifiedAssistantCaller;",
        options: SHOWZY_RESTRICTED_SYNTAX,
        errors: [{ message: verifiedCallerAssertion?.message }],
      },
      {
        name: "an angle-bracket assertion",
        code: "declare const job: unknown; export const c = <VerifiedAssistantCaller>job;",
        options: SHOWZY_RESTRICTED_SYNTAX,
        errors: [{ message: verifiedCallerAssertion?.message }],
      },
      {
        name: "an assertion to a union containing it",
        code: "declare const job: unknown; export const c = job as VerifiedAssistantCaller | null;",
        options: SHOWZY_RESTRICTED_SYNTAX,
        errors: [{ message: verifiedCallerAssertion?.message }],
      },
      {
        name: "the double assertion stays refused",
        code: "declare const job: unknown; export const c = job as unknown as AssistantKitCaller;",
        options: SHOWZY_RESTRICTED_SYNTAX,
        errors: [{ message: doubleAssertion?.message }],
      },
    ],
  });
});
