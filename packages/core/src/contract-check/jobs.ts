import type { ActionContract } from "../contract/types.js";
import type { JobLifecycle, JobScope } from "../jobs/define-job.js";
import { moduleOf } from "./call-rules.js";

export interface JobDefinitionRef {
  readonly name: string;
  readonly scope: JobScope;
  readonly lifecycle: JobLifecycle;
  readonly onExhausted?: string;
}

export function collectJobProblems(
  jobs: readonly JobDefinitionRef[],
  contracts: readonly ActionContract[],
  jobIsolationCoverage: readonly string[],
  problems: string[],
): void {
  const jobsByName = new Map<string, JobDefinitionRef>();
  for (const job of jobs) {
    if (jobsByName.has(job.name)) {
      problems.push(
        `job "${job.name}": duplicate definition — exactly one module defines each job (ADR-0041 §3)`,
      );
      continue;
    }
    jobsByName.set(job.name, job);
  }
  const contractsByName = new Map(
    contracts.map((contract) => [contract.name, contract]),
  );

  for (const contract of contracts) {
    for (const jobName of contract.enqueues ?? []) {
      collectEnqueueProblems(
        contract,
        jobsByName.get(jobName),
        jobName,
        problems,
      );
    }
  }
  for (const job of jobsByName.values()) {
    if (job.lifecycle === "expires") {
      collectOnExhaustedProblems(job, contractsByName, problems);
    }
  }
  collectJobIsolationCoverageProblems(
    jobsByName,
    jobIsolationCoverage,
    problems,
  );
}

function collectEnqueueProblems(
  contract: ActionContract,
  job: JobDefinitionRef | undefined,
  jobName: string,
  problems: string[],
): void {
  if (job === undefined || moduleOf(job.name) !== moduleOf(contract.name)) {
    problems.push(
      `action "${contract.name}": enqueues "${jobName}", which is not a registered job of module "${moduleOf(contract.name)}" (ADR-0041 J4)`,
    );
    return;
  }
  if (job.lifecycle === "periodic") {
    problems.push(
      `action "${contract.name}": enqueues periodic job "${jobName}" — a periodic job runs only from its schedule (ADR-0041 §5)`,
    );
  }
}

function collectOnExhaustedProblems(
  job: JobDefinitionRef,
  contractsByName: ReadonlyMap<string, ActionContract>,
  problems: string[],
): void {
  const actionName = job.onExhausted ?? "";
  const action = contractsByName.get(actionName);
  if (
    action === undefined ||
    moduleOf(action.name) !== moduleOf(job.name) ||
    action.principal !== "system" ||
    action.risk === "read"
  ) {
    problems.push(
      `job "${job.name}": onExhausted "${actionName}" must be a registered system write action of module "${moduleOf(job.name)}" (ADR-0041 J9)`,
    );
    return;
  }
  if (action.systemScope !== job.scope) {
    problems.push(
      `job "${job.name}": onExhausted "${actionName}" has systemScope "${action.systemScope ?? ""}", but the job scope is "${job.scope}" (ADR-0041 J5)`,
    );
  }
}

function collectJobIsolationCoverageProblems(
  jobsByName: ReadonlyMap<string, JobDefinitionRef>,
  coverage: readonly string[],
  problems: string[],
): void {
  const jobModules = new Set(
    [...jobsByName.keys()].map((jobName) => moduleOf(jobName)),
  );
  const covered = new Set<string>();
  for (const moduleName of coverage) {
    if (covered.has(moduleName)) {
      problems.push(
        `suiteCoverage.jobIsolation lists "${moduleName}" more than once`,
      );
      continue;
    }
    covered.add(moduleName);
    if (!jobModules.has(moduleName)) {
      problems.push(
        `suiteCoverage.jobIsolation "${moduleName}" defines no job (core.md §12)`,
      );
    }
  }
  for (const moduleName of jobModules) {
    if (!covered.has(moduleName)) {
      problems.push(
        `module "${moduleName}": defines jobs but declares no jobIsolationCase coverage (core.md §12)`,
      );
    }
  }
}
