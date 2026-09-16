import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";

import type {
  ActionContract,
  ActionContractDefinition,
} from "../contract/index.js";
import { defineActionContract } from "../contract/index.js";
import { defineJob, type JobDefinition } from "../jobs/define-job.js";
import { jobField, jobPayload } from "../jobs/job-payload.js";
import { ActionRegistry } from "../runtime/action-registry.js";
import { implementAction } from "../runtime/implement-action.js";
import { runContractCheck } from "./contract-check.js";
import type { JobDefinitionRef } from "./jobs.js";
import {
  emptySuiteCoverage,
  type SuiteCoverageManifest,
} from "./suite-coverage.js";

describe("suiteCoverage.jobIsolation", () => {
  it("is a required list on every manifest, like the other suites", () => {
    expectTypeOf<Pick<SuiteCoverageManifest, "jobIsolation">>().toEqualTypeOf<{
      readonly jobIsolation: readonly string[];
    }>();
  });
});

const io = z.object({});

function systemWrite(
  overrides: Partial<ActionContractDefinition> & { name: string },
): ActionContract {
  return defineActionContract({
    description: "Job contract-check fixture action.",
    principal: "system",
    systemScope: "tenant",
    transport: "internal",
    input: io,
    output: io,
    permissions: [],
    aiExposure: "internal",
    risk: "write",
    requiresConfirmation: false,
    idempotent: false,
    emits: [],
    atomicCalls: [],
    atomicCallers: [],
    errors: [],
    audit: true,
    timeout: 5_000,
    ...overrides,
  });
}

function job(overrides: Partial<JobDefinition> = {}) {
  return defineJob({
    name: "assistant.runTurn",
    scope: "tenant",
    payload: jobPayload({ turnId: jobField.uuid() }),
    discriminator: ["turnId"],
    lifecycle: "expires",
    onExhausted: "assistant.interruptTurn",
    retries: 0,
    attemptTimeoutMs: 120_000,
    concurrency: 1,
    ...overrides,
  });
}

function periodic(name: string) {
  return defineJob({
    name,
    scope: "global",
    payload: jobPayload({}),
    discriminator: [],
    lifecycle: "periodic",
    retries: 0,
    attemptTimeoutMs: 60_000,
    concurrency: 1,
    cron: "0 * * * *",
  });
}

const START_TURN = systemWrite({
  name: "assistant.startTurn",
  enqueues: ["assistant.runTurn"],
});
const INTERRUPT_TURN = systemWrite({ name: "assistant.interruptTurn" });

function problemsOf(
  contracts: readonly ActionContract[],
  jobs: readonly JobDefinitionRef[],
  jobIsolation: readonly string[] = ["assistant"],
): readonly string[] {
  const registry = new ActionRegistry();
  for (const contract of contracts) {
    registry.registerContract(contract);
    registry.registerImplementation(
      implementAction(contract, {
        handler: () => Promise.resolve({}),
        ...(contract.audit
          ? { auditTarget: () => ({ type: "fixture", id: "1" }) }
          : {}),
      }),
    );
  }
  return runContractCheck({
    registry,
    events: [],
    subscriptions: [],
    callEdges: [],
    projectionGrants: new Set<string>(),
    readModelGrants: [],
    schemaImports: [],
    schemaTables: [],
    assistantSurfaces: [],
    assistantFacadeToolNames: [],
    jobs,
    suiteCoverage: {
      ...emptySuiteCoverage,
      isolation: contracts.map((contract) => contract.name),
      jobIsolation,
    },
  }).problems;
}

describe("contract check — jobs (ADR-0041)", () => {
  it("passes a valid declaration: enqueued expiring job, on-exhausted action, coverage", () => {
    expect(problemsOf([START_TURN, INTERRUPT_TURN], [job()])).toEqual([]);
  });

  it("reports an enqueued job that is not registered", () => {
    expect(problemsOf([START_TURN, INTERRUPT_TURN], [], [])).toEqual([
      'action "assistant.startTurn": enqueues "assistant.runTurn", which is not a registered job of module "assistant" (ADR-0041 J4)',
    ]);
  });

  it("reports an action that enqueues a periodic job", () => {
    expect(
      problemsOf([INTERRUPT_TURN, START_TURN], [periodic("assistant.runTurn")]),
    ).toEqual([
      'action "assistant.startTurn": enqueues periodic job "assistant.runTurn" — a periodic job runs only from its schedule (ADR-0041 §5)',
    ]);
  });

  it("reports a duplicate job definition", () => {
    expect(problemsOf([START_TURN, INTERRUPT_TURN], [job(), job()])).toEqual([
      'job "assistant.runTurn": duplicate definition — exactly one module defines each job (ADR-0041 §3)',
    ]);
  });

  it.each([
    ["is not registered", [START_TURN]],
    [
      "is not a system action",
      [
        START_TURN,
        defineActionContract({
          name: "assistant.interruptTurn",
          description: "Job contract-check fixture staff action.",
          principal: "staff",
          transport: "client",
          input: io,
          output: io,
          permissions: ["assistant:interrupt"],
          aiExposure: "internal",
          risk: "write",
          requiresConfirmation: false,
          idempotent: false,
          emits: [],
          atomicCalls: [],
          atomicCallers: [],
          errors: [],
          audit: true,
          timeout: 5_000,
        }),
      ],
    ],
    [
      "is a read",
      [
        START_TURN,
        systemWrite({
          name: "assistant.interruptTurn",
          risk: "read",
          audit: false,
        }),
      ],
    ],
  ] as const)(
    "reports an expiring job whose on-exhausted action %s",
    (_label, contracts) => {
      expect(problemsOf(contracts, [job()])).toEqual([
        'job "assistant.runTurn": onExhausted "assistant.interruptTurn" must be a registered system write action of module "assistant" (ADR-0041 J9)',
      ]);
    },
  );

  it("reports an on-exhausted action whose system scope differs from the job scope", () => {
    expect(
      problemsOf(
        [
          START_TURN,
          systemWrite({
            name: "assistant.interruptTurn",
            systemScope: "global",
          }),
        ],
        [job()],
      ),
    ).toEqual([
      'job "assistant.runTurn": onExhausted "assistant.interruptTurn" has systemScope "global", but the job scope is "tenant" (ADR-0041 J5)',
    ]);
  });

  it("reports a module with jobs and no job isolation coverage, and coverage without jobs", () => {
    expect(
      problemsOf(
        [START_TURN, INTERRUPT_TURN],
        [job(), periodic("files.sweepAbandonedUploads")],
        ["assistant", "orders", "assistant"],
      ),
    ).toEqual([
      'suiteCoverage.jobIsolation "orders" defines no job (core.md §12)',
      'suiteCoverage.jobIsolation lists "assistant" more than once',
      'module "files": defines jobs but declares no jobIsolationCase coverage (core.md §12)',
    ]);
  });
});
