/**
 * `defineActionContract` — the client-safe half of one logical action
 * (ADR-0016). Validates every rule that is checkable from a single
 * descriptor in isolation and freezes the result. Registry-wide rules
 * (duplicate names, event definitions existing, atomic edges being
 * mutually declared, projection grants existing) need the full registry
 * and land with the contract check (fnd-T10).
 */
import { z } from "zod";

import { moduleOf } from "./module-of.js";
import type {
  ActionContract,
  ActionContractDefinition,
  ActionPrincipal,
} from "./types.js";

/**
 * Thrown when a descriptor violates core.md §2 at define time. This is a
 * developer/CI error surfaced at module load — it is not part of the
 * runtime error vocabulary (core.md §11, fnd-T9) and never reaches a
 * client.
 */
export class ActionContractDefinitionError extends Error {
  readonly actionName: string;
  readonly problems: readonly string[];

  constructor(actionName: string, problems: readonly string[]) {
    const details = problems.map((problem) => `  - ${problem}`).join("\n");
    super(`Invalid action contract "${actionName}":\n${details}`);
    this.name = "ActionContractDefinitionError";
    this.actionName = actionName;
    this.problems = problems;
  }
}

/** `<module>.<verb>` — camelCase segments, e.g. `featureFlags.setOverride`. */
const ACTION_NAME_PATTERN = /^[a-z][a-zA-Z0-9]*\.[a-z][a-zA-Z0-9]*$/;
/** `<module>.<pastVerb>` — structurally identical to an action name. */
const EVENT_NAME_PATTERN = ACTION_NAME_PATTERN;
/** `<module>:<verb>` permission strings (conventions.mdc). */
const PERMISSION_PATTERN = /^[a-z][a-zA-Z0-9]*:[a-z][a-zA-Z0-9]*$/;

/** Principals behind confirmation dialogs/cards (core.md §7). */
const HUMAN_PRINCIPALS: ReadonlySet<ActionPrincipal> = new Set([
  "staff",
  "customer",
  "account",
]);

/** Principals whose actions are strict read-only subsets (core.md §2). */
const READ_ONLY_PRINCIPALS: ReadonlySet<ActionPrincipal> = new Set([
  "public",
  "consumer",
]);

/**
 * Validates and freezes a client-safe action descriptor. Throws
 * `ActionContractDefinitionError` listing **all** violations, so a broken
 * contract is fixed in one round instead of error-by-error.
 */
export function defineActionContract<const T extends ActionContractDefinition>(
  definition: T,
): ActionContract<T["input"], T["output"], T["principal"]> & Readonly<T> {
  const problems = collectDefinitionProblems(definition);
  if (problems.length > 0) {
    throw new ActionContractDefinitionError(definition.name, problems);
  }
  // The brand is a compile-time marker for descriptors that passed this
  // validation, so the single assertion is backed by the checks above.
  return Object.freeze({ ...definition }) as ActionContract<
    T["input"],
    T["output"],
    T["principal"]
  > &
    Readonly<T>;
}

function collectDefinitionProblems(
  definition: ActionContractDefinition,
): string[] {
  const problems: string[] = [];
  const { name, principal } = definition;

  if (!ACTION_NAME_PATTERN.test(name)) {
    problems.push(
      `name "${name}" must be "<module>.<verb>" with camelCase segments (e.g. "orders.confirm")`,
    );
  }
  if (definition.description.trim() === "") {
    problems.push(
      "description must be a non-empty instruction written for an AI model",
    );
  }
  if (!(definition.input instanceof z.ZodType)) {
    problems.push("input must be a Zod v4 schema");
  }
  if (!(definition.output instanceof z.ZodType)) {
    problems.push("output must be a Zod v4 schema");
  }

  validatePermissions(definition, problems);
  validateTransport(definition, problems);
  validateConditionalScopes(definition, problems);

  if (
    definition.aiExposure === "exposed" &&
    definition.transport !== "client"
  ) {
    problems.push(
      'aiExposure "exposed" requires transport "client" — internal actions never become AI tools',
    );
  }

  if (READ_ONLY_PRINCIPALS.has(principal)) {
    validateReadOnlySubset(definition, problems);
  }
  if (principal === "share") {
    validateShareSubset(definition, problems);
  }
  validateConfirmation(definition, problems);

  if (
    (definition.risk === "write" || definition.risk === "high") &&
    !definition.audit
  ) {
    problems.push('risk "write" and "high" actions must declare audit: true');
  }

  validateEmits(definition, problems);
  validateAtomicEdges(definition, problems);

  if (!Number.isInteger(definition.timeout) || definition.timeout <= 0) {
    problems.push("timeout must be a positive integer of milliseconds");
  }
  if (definition.rateLimit !== undefined) {
    if (
      !Number.isInteger(definition.rateLimit.limit) ||
      definition.rateLimit.limit <= 0
    ) {
      problems.push("rateLimit.limit must be a positive integer");
    }
    if (
      !Number.isInteger(definition.rateLimit.windowSec) ||
      definition.rateLimit.windowSec <= 0
    ) {
      problems.push("rateLimit.windowSec must be a positive integer");
    }
  }

  return problems;
}

function validatePermissions(
  definition: ActionContractDefinition,
  problems: string[],
): void {
  for (const permission of definition.permissions) {
    if (!PERMISSION_PATTERN.test(permission)) {
      problems.push(`permission "${permission}" must be "<module>:<verb>"`);
    }
  }
  if (hasDuplicates(definition.permissions)) {
    problems.push("permissions must not contain duplicates");
  }
  if (definition.principal === "staff") {
    if (definition.permissions.length === 0) {
      problems.push("staff actions must declare at least one permission");
    }
  } else if (definition.permissions.length > 0) {
    problems.push(
      `${definition.principal} actions must declare permissions: [] — their authorization is ownership/visibility/published-read/own-user/valid token, not RBAC (core.md §4)`,
    );
  }
}

function validateTransport(
  definition: ActionContractDefinition,
  problems: string[],
): void {
  const { principal, transport } = definition;
  if (principal === "system" && transport !== "internal") {
    problems.push('system actions must declare transport: "internal"');
  }
  if (
    (principal === "public" ||
      principal === "consumer" ||
      principal === "account" ||
      principal === "share") &&
    transport !== "client"
  ) {
    problems.push(`${principal} actions must declare transport: "client"`);
  }
}

function validateConditionalScopes(
  definition: ActionContractDefinition,
  problems: string[],
): void {
  const { principal } = definition;

  if (principal === "public") {
    if (definition.publicScope === undefined) {
      problems.push(
        'public actions must declare publicScope ("target" | "globalProjection")',
      );
    }
  } else if (definition.publicScope !== undefined) {
    problems.push("publicScope is allowed only on public actions");
  }

  if (definition.publicScope === "globalProjection") {
    if (
      definition.projectionGrant === undefined ||
      definition.projectionGrant.trim() === ""
    ) {
      problems.push(
        'publicScope "globalProjection" requires a projectionGrant declared by the projection owner',
      );
    }
  } else if (definition.projectionGrant !== undefined) {
    problems.push(
      'projectionGrant is allowed only with publicScope: "globalProjection"',
    );
  }

  if (principal === "system") {
    if (definition.systemScope === undefined) {
      problems.push(
        'system actions must declare systemScope ("tenant" | "global")',
      );
    }
  } else if (definition.systemScope !== undefined) {
    problems.push("systemScope is allowed only on system actions");
  }
}

/** Public and consumer actions are strict read-only subsets (core.md §2). */
function validateReadOnlySubset(
  definition: ActionContractDefinition,
  problems: string[],
): void {
  const { principal } = definition;
  if (definition.risk !== "read") {
    problems.push(
      `${principal} actions are read-only and must declare risk: "read"`,
    );
  }
  if (definition.audit) {
    problems.push(`${principal} actions must declare audit: false`);
  }
  if (definition.idempotent) {
    problems.push(`${principal} actions must declare idempotent: false`);
  }
  if (definition.requiresConfirmation) {
    problems.push(
      `${principal} actions must declare requiresConfirmation: false`,
    );
  }
  if (definition.emits.length > 0) {
    problems.push(`${principal} actions must not emit events`);
  }
}

/**
 * Share actions (ADR-0022): unauthenticated capability-token subset.
 * `resolveTarget` is an implement-time callback; writes also require
 * `auditSnapshot` there. Serializable rules live here.
 */
function validateShareSubset(
  definition: ActionContractDefinition,
  problems: string[],
): void {
  if (definition.aiExposure !== "internal") {
    problems.push(
      'share actions must declare aiExposure: "internal" — capability-token writes never become AI tools (core.md §2, ADR-0022)',
    );
  }
  if (definition.requiresConfirmation) {
    problems.push(
      "share actions must declare requiresConfirmation: false — legal intent is on-device QES (core.md §2, ADR-0022)",
    );
  }
  if (definition.risk !== "read" && definition.risk !== "write") {
    problems.push(
      'share actions must declare risk: "read" | "write" — draft and high are forbidden (legal intent is on-device QES; core.md §2)',
    );
  }
  if (definition.risk === "write" && !definition.idempotent) {
    problems.push(
      "share writes must declare idempotent: true (core.md §2, ADR-0022)",
    );
  }
}

function validateConfirmation(
  definition: ActionContractDefinition,
  problems: string[],
): void {
  if (definition.requiresConfirmation) {
    if (!HUMAN_PRINCIPALS.has(definition.principal)) {
      problems.push(
        "requiresConfirmation applies to human principals (staff, customer, account) only",
      );
    }
    if (definition.risk !== "high") {
      problems.push('requiresConfirmation requires risk: "high"');
    }
    if (!definition.idempotent) {
      problems.push(
        "requiresConfirmation requires idempotent: true (confirmed retries must replay safely, core.md §5)",
      );
    }
  } else if (
    definition.risk === "high" &&
    HUMAN_PRINCIPALS.has(definition.principal)
  ) {
    problems.push(
      'human-invoked risk: "high" actions must declare requiresConfirmation: true (core.md §7)',
    );
  }
}

function validateEmits(
  definition: ActionContractDefinition,
  problems: string[],
): void {
  const module = moduleOf(definition.name);
  for (const event of definition.emits) {
    if (!EVENT_NAME_PATTERN.test(event)) {
      problems.push(`event "${event}" must be named "<module>.<pastVerb>"`);
    } else if (moduleOf(event) !== module) {
      problems.push(
        `event "${event}" must belong to this action's module "${module}" — a module emits only its own events`,
      );
    }
  }
  if (hasDuplicates(definition.emits)) {
    problems.push("emits must not contain duplicates");
  }
}

/**
 * Per-descriptor half of the ADR-0021 rules. Whether the referenced edges
 * are mutually declared (and exist at all) is a registry question for the
 * contract check (fnd-T10).
 */
function validateAtomicEdges(
  definition: ActionContractDefinition,
  problems: string[],
): void {
  const edgeFields = [
    ["atomicCalls", definition.atomicCalls],
    ["atomicCallers", definition.atomicCallers],
  ] as const;
  for (const [field, entries] of edgeFields) {
    for (const target of entries) {
      if (!ACTION_NAME_PATTERN.test(target)) {
        problems.push(
          `${field} entry "${target}" must be an action name "<module>.<verb>"`,
        );
      } else if (target === definition.name) {
        problems.push(`${field} must not reference the action itself`);
      }
    }
    if (hasDuplicates(entries)) {
      problems.push(`${field} must not contain duplicates`);
    }
  }

  const isRoot = definition.atomicCalls.length > 0;
  const isCallee = definition.atomicCallers.length > 0;
  if (isRoot && isCallee) {
    problems.push(
      "an action cannot be both an atomic root and an atomic callee (ADR-0021: one edge below the root; callees cannot call atomically)",
    );
  }
  if (isRoot) {
    if (definition.risk === "read") {
      problems.push(
        'atomic root actions must be writable (atomicCalls with risk: "read")',
      );
    }
    if (!definition.idempotent) {
      problems.push(
        "atomic root actions must declare idempotent: true (ADR-0021)",
      );
    }
  }
  if (isCallee) {
    if (definition.transport !== "internal") {
      problems.push('atomic callees must declare transport: "internal"');
    }
    if (definition.risk !== "write") {
      problems.push('atomic callees must declare risk: "write"');
    }
    if (definition.requiresConfirmation) {
      problems.push("atomic callees cannot require confirmation");
    }
  }
}

function hasDuplicates(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}
