/**
 * The shared preset's `no-restricted-syntax` entries, in their own module so a
 * RuleTester runs exactly what `base.mjs` configures.
 */

/** Where the one legitimate `VerifiedAssistantCaller` is made (SHO-561). */
export const VERIFIED_ASSISTANT_CALLER_PRODUCER =
  "packages/assistant-runtime/src/stores/assistant-turn-for-job.ts";

export const SHOWZY_RESTRICTED_SYNTAX = [
  // No `x as unknown as Y` escape hatch (prohibitions.mdc).
  {
    selector: "TSAsExpression > TSAsExpression",
    message:
      "Double assertions (`as unknown as`) are prohibited. Fix the types instead.",
  },
  // The brand is a module-private symbol, but `x as VerifiedAssistantCaller`
  // still compiles because the shapes overlap. Its producer builds one without
  // any assertion, so none is allowed anywhere.
  {
    selector:
      ":matches(TSAsExpression, TSTypeAssertion) TSTypeReference[typeName.name='VerifiedAssistantCaller']",
    message: `A VerifiedAssistantCaller comes only from reading the turn a job names (${VERIFIED_ASSISTANT_CALLER_PRODUCER}), never from a type assertion (SHO-561).`,
  },
];

export const ZOD_INTERNALS_OWNER = "packages/core";

export const SHOWZY_RESTRICTED_PROPERTIES = [
  {
    property: "_zod",
    message: `Zod internals (\`_zod\`) are read only inside ${ZOD_INTERNALS_OWNER}; mutating a registered job payload or field bypasses ADR-0041 J6 (SHO-677).`,
  },
];

export function showzyRestrictedProperties(packageDirectory) {
  return packageDirectory === ZOD_INTERNALS_OWNER
    ? []
    : SHOWZY_RESTRICTED_PROPERTIES;
}
