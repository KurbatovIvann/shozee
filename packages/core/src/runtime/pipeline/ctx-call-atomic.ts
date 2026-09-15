/**
 * `ctx.callAtomic` — declared same-transaction cross-module writes
 * (fnd-T19A — core.md §9, ADR-0021).
 *
 * ADR-0015's default composition channels stay untouched: effects go
 * through events, synchronous reads through `ctx.call`. This is the
 * fourth, exceptional channel for the rare cross-module write that must
 * commit or roll back **with** the root action (the canonical case:
 * `orders.confirm` revalidating and decrementing catalog-owned stock).
 * The callee runs:
 *
 *  - in the **root physical transaction** — the same Drizzle `Tx` object
 *    the root handler holds, handed on as the writable capability. No
 *    savepoint wraps it: a callee failure propagates and rolls the whole
 *    root back, and the callee cannot commit, roll back, or open a
 *    transaction of its own because it never sees anything that could;
 *  - under the **same principal**, re-authorized through the normal
 *    context factories exactly like a nested read: staff membership and
 *    the callee's declared permissions re-verified, a customer callee's
 *    resolver re-run with the caller's verified `inheritedCompanyId` —
 *    a company mismatch is a `CoreInvariantError` (tenant protocol);
 *  - with input and output validated against the callee's schemas, and
 *    the callee's own events and audit row written **in the root
 *    transaction**, so they commit only if everything commits;
 *  - under the root's shared timeout budget and correlation-nested
 *    logs/spans.
 *
 * The root owns rate limiting, confirmation, idempotency
 * reservation/finalization, and the transaction lifecycle — the callee
 * never touches a protocol hook and owns no idempotency reservation of
 * its own. Only one atomic edge is allowed below the root: the latch here
 * rejects a second invocation, nested callees carry a rejecting
 * `callAtomic` (`rejectNestedCallAtomic`), and the callee's ordinary
 * reads extend the root's depth/cycle path. The per-edge rules (mutual
 * declaration, callee shape, principal compatibility) are asserted from
 * the same list the contract check proves in CI
 * (`contract-check/call-rules.ts`), so runtime and CI cannot drift.
 */
import type { Tx } from "@showzy/db";
import type { z } from "zod";

import { atomicCallTargetProblems } from "../../contract-check/call-rules.js";
import { CoreInvariantError } from "../../errors/index.js";
import type { AnyActionContract } from "../action-registry.js";
import {
  type ActionRequestMeta,
  type ContextRuntime,
} from "../context/factories.js";
import type { ActionCtx, CtxCallAtomic } from "../context/types.js";
import { createEmitBuffer } from "../events/emit.js";
import { rejectNestedEnqueue } from "../jobs/enqueue.js";
import type { ImplementedAction } from "../implement-action.js";
import {
  constructCalleeContext,
  createCtxCall,
  rejectNestedCallAtomic,
} from "./ctx-call.js";
import {
  ATOMIC_CALL,
  assertNestedDeadline,
  requireNestedAuditTarget,
  startNestedInvocation,
  toNestedInvocationError,
  validateNestedInput,
  validateNestedOutput,
} from "./nested-invocation.js";
import type { ActionPipelineDeps } from "./types.js";

/** What one root invocation's `callAtomic` closure needs. */
export interface CtxCallAtomicEnv {
  readonly deps: ActionPipelineDeps;
  /** The root action — the caller side of every ADR-0021 edge rule. */
  readonly callerContract: AnyActionContract;
  /** The root's request meta; correlation fields propagate unchanged. */
  readonly request: ActionRequestMeta;
  /** Envelope `causationId` for events the callee emits (core.md §6). */
  readonly causationId: string;
  /** Whole-pipeline deadline (epoch ms), shared with the callee. */
  readonly deadline: number;
  readonly signal: AbortSignal;
  readonly now: () => number;
  /**
   * The root's execution transaction and constructed context —
   * `undefined` outside handler execution (preflight, after commit), so a
   * context that escapes the handler carries a `callAtomic` that refuses
   * to run. Same boxing pattern as `ctx.call`.
   */
  readonly getExecution: () =>
    { readonly tx: Tx; readonly ctx: ActionCtx } | undefined;
  /** `[rootName]` — the callee's ordinary reads extend this path. */
  readonly path: readonly string[];
}

/** Builds one invocation's `ctx.callAtomic`; the pipeline is the only caller. */
export function createCtxCallAtomic(env: CtxCallAtomicEnv): CtxCallAtomic {
  // The one-atomic-edge latch (core.md §9): per pipeline invocation, and
  // consumed even when the callee fails — the failed callee may have
  // written into the root transaction, so nothing may run "instead".
  let used = false;

  return async function callAtomic<
    TInput extends z.ZodType,
    TOutput extends z.ZodType,
    TTarget,
  >(
    action: ImplementedAction<TInput, TOutput, TTarget>,
    input: z.input<TInput>,
  ): Promise<z.output<TOutput>> {
    const caller = env.callerContract;
    const callee: AnyActionContract = action.contract;
    const chain = [...env.path, callee.name].join(" → ");

    const execution = env.getExecution();
    if (execution === undefined) {
      throw new CoreInvariantError(
        `"${caller.name}" invoked ctx.callAtomic("${callee.name}") outside its handler execution — atomic calls run only inside the root execution transaction (ADR-0021)`,
      );
    }

    // The ADR-0021 edge rules the contract check proves for declared
    // edges, re-asserted on the actual object handed in (runtime assert +
    // CI check). A violation is a bug in the calling module.
    const problems = atomicCallTargetProblems(caller, callee);
    if (problems.length > 0) {
      throw new CoreInvariantError(
        `ctx.callAtomic ${chain} violates ADR-0021: ${problems.join("; ")}`,
      );
    }

    if (used) {
      throw new CoreInvariantError(
        `"${caller.name}" invoked ctx.callAtomic("${callee.name}") after an earlier atomic call — only one atomic edge is allowed below the root (core.md §9, ADR-0021)`,
      );
    }
    used = true;

    assertNestedDeadline({
      kind: ATOMIC_CALL,
      chain,
      signal: env.signal,
      deadline: env.deadline,
      now: env.now,
    });

    const parsedInput = await validateNestedInput({
      kind: ATOMIC_CALL,
      schema: action.contract.input,
      input,
      chain,
    });

    const invocation = startNestedInvocation({
      kind: ATOMIC_CALL,
      deps: env.deps,
      callerRequest: env.request,
      callerName: caller.name,
      calleeName: callee.name,
      now: env.now,
    });
    const { request } = invocation;

    let calleeCtx: ActionCtx | undefined;

    try {
      // The callee's own emission buffer: it declares its own `emits`
      // (e.g. catalog.stockAdjusted) and the flush below inserts into the
      // root transaction, so its events commit only with the root.
      const emitBuffer = createEmitBuffer({ contract: callee, now: env.now });

      // The writable root transaction travels down as-is (ADR-0021,
      // db.md §3: "an atomic callee receives the root `Tx` object") —
      // schema confinement is the ESLint boundary + module review wall,
      // not a runtime facade. Ordinary reads from the callee extend the
      // root's depth/cycle path; a further atomic call is rejected.
      const runtime: ContextRuntime<Tx> = {
        db: execution.tx,
        logger: env.deps.logger,
        deadline: env.deadline,
        signal: env.signal,
        emit: emitBuffer.emit,
        enqueue: rejectNestedEnqueue(callee.name),
        call: createCtxCall({
          deps: env.deps,
          callerContract: callee,
          request,
          deadline: env.deadline,
          signal: env.signal,
          now: env.now,
          getExecution: () =>
            calleeCtx === undefined
              ? undefined
              : { tx: execution.tx, ctx: calleeCtx },
          path: [...env.path, callee.name],
        }),
        callAtomic: rejectNestedCallAtomic(callee.name),
      };
      const ctx = await constructCalleeContext({
        callerCtx: execution.ctx,
        action,
        input: parsedInput,
        request,
        runtime,
      });
      calleeCtx = ctx;

      const raw = await action.handler(parsedInput, ctx);
      const parsedOutput = await validateNestedOutput({
        kind: ATOMIC_CALL,
        schema: action.contract.output,
        calleeName: callee.name,
        raw,
      });

      // The callee's events flush into the root transaction now — a later
      // root failure rolls them back together with both modules' writes.
      await emitBuffer.flush({
        tx: execution.tx,
        ctx,
        causationId: env.causationId,
      });

      // The callee's audit row (its `risk: "write"` implies `audit: true`)
      // is written in the root transaction — unlike an audited read
      // callee's best-effort post-commit entry, a failure here must
      // propagate and roll everything back (ADR-0021: child audit commits
      // only with the root).
      const auditHook = env.deps.hooks?.audit;
      if (callee.audit && auditHook !== undefined) {
        const auditTarget = requireNestedAuditTarget(ATOMIC_CALL, action);
        await auditHook.recordSuccess({
          tx: execution.tx,
          ctx,
          contract: callee,
          input: parsedInput,
          output: parsedOutput,
          durationMs: env.now() - invocation.startedAt,
          auditTarget,
          auditSnapshot: action.auditSnapshot,
        });
      }

      invocation.finish("ok", calleeCtx);
      return parsedOutput;
    } catch (error) {
      const coreError = toNestedInvocationError(
        ATOMIC_CALL,
        error,
        callee.name,
      );
      invocation.recordError(coreError);
      invocation.finish(coreError.code, calleeCtx);
      throw coreError;
    }
  };
}
