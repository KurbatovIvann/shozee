/**
 * Observation + enforcement of declared action error codes (SHO-485).
 *
 * `invokeAction` is the one choke point every module test drives. An
 * escaping `CoreError` whose code is in the declarable alphabet
 * (`VALIDATION` | `NOT_FOUND` | `CONFLICT`) must be listed on the
 * action's `errors` field. INTERNAL and pipeline codes are ignored.
 * Subclass identity is not flattened — the original throw is rethrown.
 *
 * Set `SHOWZY_DECLARED_ERRORS_REPORT` to a JSONL path to record observed
 * codes without failing (the fill-from-observation step). Unset, the
 * check enforces.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import {
  isDeclaredErrorCode,
  type DeclaredErrorCode,
} from "../contract/declared-error-codes.js";
import type { ActionContract } from "../contract/types.js";
import { CoreError } from "../errors/index.js";

/** Test-kit assertion — not part of the runtime §11 vocabulary. */
export class UndeclaredActionError extends Error {
  readonly actionName: string;
  readonly observedCode: DeclaredErrorCode;

  constructor(
    actionName: string,
    observedCode: DeclaredErrorCode,
    throwSite: string,
  ) {
    super(
      `action "${actionName}" escaped undeclared error code ${observedCode}\nThrow site:\n${throwSite}`,
    );
    this.name = "UndeclaredActionError";
    this.actionName = actionName;
    this.observedCode = observedCode;
  }
}

export function declaredErrorsReportPath(): string | undefined {
  const path = process.env.SHOWZY_DECLARED_ERRORS_REPORT;
  if (path === undefined || path.trim() === "") {
    return undefined;
  }
  return path;
}

export function assertDeclaredEscapingError(
  contract: ActionContract,
  error: unknown,
): void {
  if (!(error instanceof CoreError)) {
    return;
  }
  if (!isDeclaredErrorCode(error.code)) {
    return;
  }
  if (contract.errors.includes(error.code)) {
    return;
  }
  throw new UndeclaredActionError(
    contract.name,
    error.code,
    error.stack ?? "(no stack)",
  );
}

/** Record + optionally enforce. Report mode is `invokeAction`-only. */
export function checkInvokeActionError(
  contract: ActionContract,
  error: unknown,
): void {
  if (!(error instanceof CoreError)) {
    return;
  }
  if (!isDeclaredErrorCode(error.code)) {
    return;
  }
  recordObserved(contract.name, error.code);
  if (declaredErrorsReportPath() !== undefined) {
    return;
  }
  assertDeclaredEscapingError(contract, error);
}

function recordObserved(actionName: string, code: DeclaredErrorCode): void {
  const reportPath = declaredErrorsReportPath();
  if (reportPath === undefined) {
    return;
  }
  mkdirSync(dirname(reportPath), { recursive: true });
  appendFileSync(
    reportPath,
    `${JSON.stringify({ action: actionName, code })}\n`,
  );
}
