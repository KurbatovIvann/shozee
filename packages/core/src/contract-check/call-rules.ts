/**
 * The per-target `ctx.call` rules (core.md §9, ADR-0015) and the per-edge
 * `ctx.callAtomic` rules (core.md §9, ADR-0021), shared verbatim between
 * the registry-walking contract check (fnd-T10 — proves every *declared*
 * edge in CI) and the runtime asserts inside `ctx.call`/`ctx.callAtomic`
 * (fnd-T19/T19A — re-prove the *actual* target object of every
 * invocation). One rule list with two enforcement points, so CI and
 * runtime cannot drift.
 */
import { moduleOf } from "../contract/module-of.js";
import type { ActionContract } from "../contract/types.js";

export { moduleOf };

export function describePrincipal(contract: ActionContract): string {
  if (contract.principal === "system") {
    return `system/${contract.systemScope ?? "unknown"}`;
  }
  return contract.principal;
}

/**
 * Whether a read call is principal-compatible (core.md §9, ADR-0015):
 * same principal mode by default, with the spec'd asymmetries — account
 * callers may also invoke consumer reads (global discovery), and a global
 * system caller cannot invoke a tenant-scoped system read because it has
 * no `companyId` to propagate (a tenant caller can invoke global system
 * reads, which need nothing tenant-specific).
 */
export function callPrincipalCompatible(
  caller: ActionContract,
  callee: ActionContract,
): boolean {
  if (caller.principal === callee.principal) {
    if (caller.principal === "system") {
      return caller.systemScope === "tenant" || callee.systemScope === "global";
    }
    return true;
  }
  return caller.principal === "account" && callee.principal === "consumer";
}

/**
 * Every §9 rule checkable from the caller/callee contract pair. Returns
 * all violations at once; an empty array means the target is callable.
 */
export function callTargetProblems(
  caller: ActionContract,
  callee: ActionContract,
): string[] {
  const problems: string[] = [];
  if (moduleOf(caller.name) === moduleOf(callee.name)) {
    problems.push(
      "same-module composition uses services/, not ctx.call (ADR-0015)",
    );
  }
  if (callee.risk !== "read") {
    problems.push(
      'only risk: "read" actions are callable cross-module (core.md §9, ADR-0015)',
    );
  }
  if (callee.consistency === "snapshot" && caller.consistency !== "snapshot") {
    problems.push(
      'a consistency: "snapshot" callee runs on its caller\'s transaction, so its caller must declare consistency: "snapshot" too (core.md §9, ADR-0042 L1)',
    );
  }
  if (caller.publicScope === "globalProjection") {
    problems.push(
      "public-global actions cannot use ctx.call — their read capability is limited to the declared projection grant (core.md §9)",
    );
    return problems;
  }
  if (callee.publicScope === "globalProjection") {
    problems.push(
      "a public-global action cannot be a ctx.call target — its projection grant binds only its own anonymous invocation (core.md §2, ADR-0020)",
    );
    return problems;
  }
  if (!callPrincipalCompatible(caller, callee)) {
    problems.push(
      `callee (${describePrincipal(callee)}) does not accept the caller's principal (${describePrincipal(caller)}) (core.md §9, ADR-0015)`,
    );
  }
  return problems;
}

/**
 * ADR-0021 requires the same principal mode and verified company scope on
 * both sides of an atomic edge; company equality is a runtime concern
 * (the callee context is re-derived from the caller's verified scope), but
 * mode — and, for system pairs, declared scope — is static. Unlike read
 * calls, no cross-mode asymmetry exists: separate thin capabilities are
 * required for different principals.
 */
export function atomicPrincipalCompatible(
  caller: ActionContract,
  callee: ActionContract,
): boolean {
  if (caller.principal !== callee.principal) {
    return false;
  }
  if (caller.principal === "system") {
    return caller.systemScope === callee.systemScope;
  }
  return true;
}

/**
 * Every ADR-0021 rule checkable from the caller/callee contract pair.
 * Returns all violations at once; an empty array means the edge is a
 * declared, well-shaped atomic capability. Caller/callee *shape* rules
 * repeat define-time validation on purpose: define time only validates
 * descriptors that themselves declare atomic fields, while the runtime
 * assert must also reject an arbitrary action object handed to
 * `ctx.callAtomic` without any declaration.
 */
export function atomicCallTargetProblems(
  caller: ActionContract,
  callee: ActionContract,
): string[] {
  const problems: string[] = [];
  if (moduleOf(caller.name) === moduleOf(callee.name)) {
    problems.push(
      "same-module composition uses services/, not ctx.callAtomic (ADR-0015, ADR-0021)",
    );
  }
  if (caller.risk === "read") {
    problems.push(
      "ctx.callAtomic is available only to writable root actions (ADR-0021)",
    );
  }
  if (!caller.idempotent) {
    problems.push(
      "atomic root actions must declare idempotent: true (ADR-0021)",
    );
  }
  if (!caller.atomicCalls.includes(callee.name)) {
    problems.push(
      `undeclared edge — "${caller.name}" does not list "${callee.name}" in atomicCalls (ADR-0021)`,
    );
  }
  if (!callee.atomicCallers.includes(caller.name)) {
    problems.push(
      `not mutually declared — "${callee.name}" does not list "${caller.name}" in atomicCallers (ADR-0021)`,
    );
  }
  if (callee.transport !== "internal") {
    problems.push(
      'atomic callees must declare transport: "internal" — no client or AI route may exist (ADR-0021)',
    );
  }
  if (callee.risk !== "write") {
    problems.push('atomic callees must declare risk: "write" (ADR-0021)');
  }
  if (callee.requiresConfirmation) {
    problems.push("atomic callees cannot require confirmation (ADR-0021)");
  }
  if (!atomicPrincipalCompatible(caller, callee)) {
    problems.push(
      `caller (${describePrincipal(caller)}) and callee (${describePrincipal(callee)}) must use the same principal mode (ADR-0021)`,
    );
  }
  return problems;
}
