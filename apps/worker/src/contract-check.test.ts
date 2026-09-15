import { registeredJobs } from "@showzy/api/registry";
import {
  ActionRegistry,
  runContractCheck,
  type ContractCheckInput,
  type Job,
  type SuiteCoverageManifest,
} from "@showzy/core";
import { CoreInvariantError } from "@showzy/core/errors";
import { projectionGrants } from "@showzy/db";
import { sweepAbandonedUploadsJob } from "@showzy/files";
import { describe, expect, it } from "vitest";

import {
  cleanupIdempotencyKeysJob,
  mergeJobDeclarations,
  workerJobs,
  workerOwnedActions,
  workerOwnedJobs,
} from "./maintenance.js";
import { workerSuiteCoverage } from "./suite-coverage.js";

function workerContractCheckInput(
  overrides: {
    readonly jobs?: readonly Job[];
    readonly suiteCoverage?: SuiteCoverageManifest;
  } = {},
): ContractCheckInput {
  const registry = new ActionRegistry();
  for (const action of workerOwnedActions) {
    registry.registerContract(action.contract);
    registry.registerImplementation(action);
  }
  return {
    registry,
    events: [],
    subscriptions: [],
    callEdges: [],
    projectionGrants,
    readModelGrants: [],
    schemaImports: [],
    suiteCoverage: overrides.suiteCoverage ?? workerSuiteCoverage,
    schemaTables: [],
    assistantSurfaces: [],
    assistantFacadeToolNames: [],
    jobs: overrides.jobs ?? workerOwnedJobs,
  };
}

describe("worker contract check", () => {
  it("passes the worker-owned job, action and coverage through runContractCheck", () => {
    expect(runContractCheck(workerContractCheckInput())).toEqual({
      ok: true,
      problems: [],
    });
  });

  it("fails when the worker-owned job loses its job isolation coverage", () => {
    const result = runContractCheck(
      workerContractCheckInput({
        suiteCoverage: { ...workerSuiteCoverage, jobIsolation: [] },
      }),
    );

    expect(result.problems).toContain(
      'module "worker": defines jobs but declares no jobIsolationCase coverage (core.md §12)',
    );
  });

  it("runs the module jobs and the worker-owned jobs, each declared once", () => {
    expect(workerJobs).toEqual([...registeredJobs, cleanupIdempotencyKeysJob]);
    expect(new Set(workerJobs.map(({ name }) => name)).size).toBe(
      workerJobs.length,
    );
  });

  it("refuses a job declared by both sources", () => {
    expect(() =>
      mergeJobDeclarations(registeredJobs, [
        cleanupIdempotencyKeysJob,
        sweepAbandonedUploadsJob,
      ]),
    ).toThrow(CoreInvariantError);
    expect(() =>
      mergeJobDeclarations(registeredJobs, [
        cleanupIdempotencyKeysJob,
        sweepAbandonedUploadsJob,
      ]),
    ).toThrow(
      /"files.sweepAbandonedUploads" is declared by more than one source/,
    );
  });

  it("reports a duplicate job through runContractCheck too", () => {
    const result = runContractCheck(
      workerContractCheckInput({
        jobs: [cleanupIdempotencyKeysJob, cleanupIdempotencyKeysJob],
      }),
    );

    expect(result.problems).toContain(
      'job "worker.cleanupIdempotencyKeys": duplicate definition — exactly one module defines each job (ADR-0041 §3)',
    );
  });
});
