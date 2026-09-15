import assert from "node:assert/strict";
import { test } from "node:test";

import { RuleTester } from "eslint";
import { builtinRules } from "eslint/use-at-your-own-risk";
import tseslint from "typescript-eslint";

import {
  SHOWZY_RESTRICTED_PROPERTIES,
  SHOWZY_RESTRICTED_SYNTAX,
  showzyRestrictedProperties,
} from "./restricted-syntax.mjs";

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

const propertiesRule = builtinRules.get("no-restricted-properties");
if (propertiesRule === undefined) {
  throw new Error("ESLint no longer ships no-restricted-properties");
}

test("no-restricted-properties refuses Zod internals outside packages/core", () => {
  const outsideCore = showzyRestrictedProperties("packages/modules/orders");
  assert.deepEqual(outsideCore, SHOWZY_RESTRICTED_PROPERTIES);
  assert.deepEqual(showzyRestrictedProperties("packages/core"), []);
  tester.run("no-restricted-properties", propertiesRule, {
    valid: [
      {
        name: "a public schema API",
        code: "declare const schema: { shape: object }; export const s = schema.shape;",
        options: outsideCore,
      },
    ],
    invalid: [
      {
        name: "mutating a registered field definition",
        code: "declare const field: { _zod: { def: { checks: unknown[] } } }; field._zod.def.checks = [];",
        options: outsideCore,
        errors: [{ messageId: "restrictedProperty" }],
      },
      {
        name: "destructuring the internals",
        code: "declare const field: { _zod: object }; export const { _zod } = field;",
        options: outsideCore,
        errors: [{ messageId: "restrictedProperty" }],
      },
    ],
  });
});
