/**
 * Inherited-suite coverage (fnd-T22, core.md §12): the contract check
 * fails when a registered action or declared atomic edge has no matching
 * suite instantiation in the composition manifest.
 *
 * Event-consumer bindings are covered by `eventSuite` (delivery dedup),
 * not `idempotencySuite` — their idempotency reservation is the delivery
 * row, not a caller-supplied key.
 */
import type { ActionContract } from "../contract/types.js";
import { moduleOf } from "./call-rules.js";

/**
 * What composition must declare so CI can see that every module
 * instantiated the core.md §12 suites against its actions.
 */
export interface SuiteCoverageManifest {
  /** Action names passed to `crossTenantSuite`. */
  readonly isolation: readonly string[];
  /** Public-global action names passed to `publicProjectionSuite`. */
  readonly publicProjection: readonly string[];
  /** Consumer action names passed to `consumerIsolationSuite`. */
  readonly consumerIsolation: readonly string[];
  /** Account action names passed to `accountIsolationSuite`. */
  readonly accountIsolation: readonly string[];
  /** Share action names passed to `shareIsolationSuite`. */
  readonly shareIsolation: readonly string[];
  /**
   * Idempotent mutation names passed to `idempotencySuite`. Event-consumer
   * bindings may be omitted — `eventSuite` covers their dedup.
   */
  readonly idempotency: readonly string[];
  /**
   * Module prefixes (`<module>` of `<module>.<verb>`) that instantiated
   * `eventSuite` — every emitting or subscribing module.
   */
  readonly events: readonly string[];
  /** Declared atomic edges passed to `atomicCallSuite`. */
  readonly atomic: readonly {
    readonly caller: string;
    readonly callee: string;
  }[];
  readonly jobIsolation?: readonly string[];
}

/** Explicit empty coverage — the CI stage uses this until modules exist. */
export const emptySuiteCoverage: SuiteCoverageManifest = {
  isolation: [],
  publicProjection: [],
  consumerIsolation: [],
  accountIsolation: [],
  shareIsolation: [],
  idempotency: [],
  events: [],
  atomic: [],
  jobIsolation: [],
};

export function collectSuiteCoverageProblems(
  coverage: SuiteCoverageManifest,
  contracts: readonly ActionContract[],
  subscriptions: readonly { readonly action: string }[],
  problems: string[],
): void {
  const contractsByName = new Map(
    contracts.map((contract) => [contract.name, contract]),
  );
  const names = new Set(contractsByName.keys());
  const isolation = uniqueSet(
    coverage.isolation,
    "suiteCoverage.isolation",
    problems,
  );
  const publicProjection = uniqueSet(
    coverage.publicProjection,
    "suiteCoverage.publicProjection",
    problems,
  );
  const consumerIsolation = uniqueSet(
    coverage.consumerIsolation,
    "suiteCoverage.consumerIsolation",
    problems,
  );
  const accountIsolation = uniqueSet(
    coverage.accountIsolation,
    "suiteCoverage.accountIsolation",
    problems,
  );
  const shareIsolation = uniqueSet(
    coverage.shareIsolation,
    "suiteCoverage.shareIsolation",
    problems,
  );
  const idempotency = uniqueSet(
    coverage.idempotency,
    "suiteCoverage.idempotency",
    problems,
  );
  const events = uniqueSet(coverage.events, "suiteCoverage.events", problems);
  const atomic = uniqueEdges(coverage.atomic, problems);

  reportUnknownActions(isolation, names, "isolation", problems);
  reportUnknownActions(publicProjection, names, "publicProjection", problems);
  reportUnknownActions(consumerIsolation, names, "consumerIsolation", problems);
  reportUnknownActions(accountIsolation, names, "accountIsolation", problems);
  reportUnknownActions(shareIsolation, names, "shareIsolation", problems);
  reportUnknownActions(idempotency, names, "idempotency", problems);

  const subscriptionActions = new Set(
    subscriptions.map((subscription) => subscription.action),
  );
  const eventModules = modulesNeedingEventSuite(contracts, subscriptions);

  for (const contract of contracts) {
    if (!isolation.has(contract.name)) {
      problems.push(
        `action "${contract.name}": missing crossTenantSuite instantiation (core.md §12)`,
      );
    }
    collectModeSuiteProblems(
      contract,
      "publicProjection",
      publicProjection,
      contract.principal === "public" &&
        contract.publicScope === "globalProjection",
      'publicScope: "globalProjection"',
      problems,
    );
    collectModeSuiteProblems(
      contract,
      "consumerIsolation",
      consumerIsolation,
      contract.principal === "consumer",
      "principal: consumer",
      problems,
    );
    collectModeSuiteProblems(
      contract,
      "accountIsolation",
      accountIsolation,
      contract.principal === "account",
      "principal: account",
      problems,
    );
    collectModeSuiteProblems(
      contract,
      "shareIsolation",
      shareIsolation,
      contract.principal === "share",
      "principal: share",
      problems,
    );

    const needsIdempotency =
      contract.idempotent &&
      contract.risk !== "read" &&
      !subscriptionActions.has(contract.name);
    if (needsIdempotency && !idempotency.has(contract.name)) {
      problems.push(
        `action "${contract.name}": missing idempotencySuite instantiation (core.md §12)`,
      );
    }
    if (
      idempotency.has(contract.name) &&
      (contract.risk === "read" || !contract.idempotent)
    ) {
      problems.push(
        `action "${contract.name}": listed in idempotencySuite but is not an idempotent mutation (core.md §12)`,
      );
    }
  }

  for (const moduleName of eventModules) {
    if (!events.has(moduleName)) {
      problems.push(
        `module "${moduleName}": missing eventSuite instantiation (core.md §12)`,
      );
    }
  }
  for (const moduleName of events) {
    if (!eventModules.has(moduleName)) {
      problems.push(
        `suiteCoverage.events "${moduleName}" has no emitting or subscribing action (core.md §12)`,
      );
    }
  }

  for (const contract of contracts) {
    for (const callee of contract.atomicCalls) {
      if (!atomic.has(edgeKey(contract.name, callee))) {
        problems.push(
          `atomic edge "${contract.name}" → "${callee}": missing atomicCallSuite instantiation (core.md §12)`,
        );
      }
    }
  }
  for (const edge of coverage.atomic) {
    const caller = contractsByName.get(edge.caller);
    if (caller === undefined || !caller.atomicCalls.includes(edge.callee)) {
      problems.push(
        `suiteCoverage.atomic "${edge.caller}" → "${edge.callee}" is not a declared atomic edge (core.md §12)`,
      );
    }
  }
}

function collectModeSuiteProblems(
  contract: ActionContract,
  field: string,
  covered: ReadonlySet<string>,
  applies: boolean,
  appliesLabel: string,
  problems: string[],
): void {
  if (applies && !covered.has(contract.name)) {
    problems.push(
      `action "${contract.name}": missing ${field}Suite instantiation (core.md §12)`,
    );
  }
  if (!applies && covered.has(contract.name)) {
    problems.push(
      `action "${contract.name}": listed in ${field}Suite but is not ${appliesLabel} (core.md §12)`,
    );
  }
}

function modulesNeedingEventSuite(
  contracts: readonly ActionContract[],
  subscriptions: readonly { readonly action: string }[],
): Set<string> {
  const modules = new Set<string>();
  for (const contract of contracts) {
    if (contract.emits.length > 0) {
      modules.add(moduleOf(contract.name));
    }
  }
  for (const subscription of subscriptions) {
    modules.add(moduleOf(subscription.action));
  }
  return modules;
}

function reportUnknownActions(
  listed: ReadonlySet<string>,
  registered: ReadonlySet<string>,
  field: string,
  problems: string[],
): void {
  for (const name of listed) {
    if (!registered.has(name)) {
      problems.push(
        `suiteCoverage.${field} "${name}" is not a registered action (core.md §12)`,
      );
    }
  }
}

function uniqueSet(
  values: readonly string[],
  field: string,
  problems: string[],
): Set<string> {
  const unique = new Set<string>();
  for (const value of values) {
    if (unique.has(value)) {
      problems.push(`${field} lists "${value}" more than once`);
      continue;
    }
    unique.add(value);
  }
  return unique;
}

function uniqueEdges(
  edges: readonly { readonly caller: string; readonly callee: string }[],
  problems: string[],
): Set<string> {
  const unique = new Set<string>();
  for (const edge of edges) {
    const key = edgeKey(edge.caller, edge.callee);
    if (unique.has(key)) {
      problems.push(
        `suiteCoverage.atomic lists "${edge.caller}" → "${edge.callee}" more than once`,
      );
      continue;
    }
    unique.add(key);
  }
  return unique;
}

function edgeKey(caller: string, callee: string): string {
  return `${caller}\0${callee}`;
}
