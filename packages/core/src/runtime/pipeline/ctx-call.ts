/**
 * `ctx.call` — synchronous cross-module reads (fnd-T19 — core.md §9,
 * ADR-0015).
 *
 * A handler composes another module's `risk: "read"` action by passing
 * the implemented action object (imported from that module's `index.ts` —
 * actions are already its public API) together with input. The callee
 * runs:
 *
 *  - in the **caller's execution transaction** — it sees the caller's
 *    uncommitted writes — but behind the `ReadTx` facade even when that
 *    transaction is writable, so a callee can neither compile nor execute
 *    a mutation;
 *  - under the **caller's principal**, re-authorized through the normal
 *    context factories (defense in depth): staff membership and the
 *    callee's declared permissions re-verified, customer/public-target
 *    resolvers re-run with the caller's verified `inheritedCompanyId` —
 *    a company mismatch is a `CoreInvariantError`, never a user error;
 *  - under the caller's **shared timeout budget** (same deadline and
 *    abort signal; the caller's transaction-local statement timeout
 *    already bounds every query the callee runs);
 *  - with input and output validated against the callee's schemas,
 *    exactly like a transport invocation.
 *
 * The target rules (cross-module, read-only, principal-compatible, no
 * public-global on either side) are asserted from the same rule list the
 * contract check proves in CI (`contract-check/call-rules.ts`), so the
 * runtime and CI layers cannot drift. Depth is limited to
 * `CALL_DEPTH_LIMIT` nested calls below the root and cycles are detected
 * by action name — exceeding either is a `CoreInvariantError` (a bug in
 * the calling module, never a user error).
 */
import { createReadTx, type ReadTx, type Tx } from "@showzy/db";
import type { z } from "zod";

import { callTargetProblems } from "../../contract-check/call-rules.js";
import { CoreInvariantError } from "../../errors/index.js";
import type { AnyActionContract } from "../action-registry.js";
import {
  createAccountContext,
  createConsumerContext,
  createCustomerContext,
  createPublicContext,
  createShareContext,
  createStaffContext,
  createSystemContext,
  type ActionRequestMeta,
  type ContextRuntime,
} from "../context/factories.js";
import { assertDeclaredPermissions } from "../context/permissions.js";
import type { ActionCtx, CtxCall, CtxCallAtomic } from "../context/types.js";
import { createEmitBuffer } from "../events/emit.js";
import { rejectNestedEnqueue } from "../jobs/enqueue.js";
import type { ImplementedAction } from "../implement-action.js";
import type { TargetResolver } from "../types.js";
import {
  assertNestedDeadline,
  NESTED_CALL,
  requireNestedAuditTarget,
  startNestedInvocation,
  toNestedInvocationError,
  validateNestedInput,
  validateNestedOutput,
} from "./nested-invocation.js";
import type { ActionPipelineDeps } from "./types.js";

/** Max nested `ctx.call` levels below the root action (core.md §9). */
export const CALL_DEPTH_LIMIT = 3;

/**
 * The `callAtomic` every nested callee receives: atomic calls may
 * originate only from the root action (ADR-0021 — one atomic edge below
 * the root, no nesting), so a read callee — or the atomic callee itself —
 * invoking `ctx.callAtomic` is a `CoreInvariantError` naming the callee
 * that broke the rule.
 */
export function rejectNestedCallAtomic(calleeName: string): CtxCallAtomic {
  return (action) => {
    throw new CoreInvariantError(
      `nested callee "${calleeName}" invoked ctx.callAtomic("${action.contract.name}") — atomic calls may originate only from the root action (core.md §9, ADR-0021)`,
    );
  };
}

/** What one caller's `call` closure needs from its pipeline invocation. */
export interface CtxCallEnv {
  readonly deps: ActionPipelineDeps;
  /** The calling action — the caller side of every §9 target rule. */
  readonly callerContract: AnyActionContract;
  /** The caller's request meta; correlation fields propagate unchanged. */
  readonly request: ActionRequestMeta;
  /** Whole-pipeline deadline (epoch ms), shared across nesting levels. */
  readonly deadline: number;
  readonly signal: AbortSignal;
  readonly now: () => number;
  /**
   * The caller's execution transaction and constructed context —
   * `undefined` outside handler execution (preflight, after commit). The
   * pipeline fills its box after §4 step 7 constructs the context, so a
   * context that escapes the handler carries a `call` that refuses to run.
   */
  readonly getExecution: () =>
    { readonly tx: Tx; readonly ctx: ActionCtx } | undefined;
  /** Action names from the root to the caller — depth/cycle detection. */
  readonly path: readonly string[];
}

/** Builds one invocation's `ctx.call`; the pipeline is the only caller. */
export function createCtxCall(env: CtxCallEnv): CtxCall {
  return async function call<
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
        `"${caller.name}" invoked ctx.call("${callee.name}") outside its handler execution — nested calls run only inside the execution transaction (core.md §9)`,
      );
    }

    // The §9 target rules the contract check proves for declared edges,
    // re-asserted on the actual object handed in (runtime assert + CI
    // check, ADR-0015). A violation is a bug in the calling module.
    const problems = callTargetProblems(caller, callee);
    if (problems.length > 0) {
      throw new CoreInvariantError(
        `ctx.call ${chain} violates core.md §9: ${problems.join("; ")}`,
      );
    }

    // Cycle detection by action name, then the depth limit (§9).
    if (env.path.includes(callee.name)) {
      throw new CoreInvariantError(
        `ctx.call cycle detected: ${chain} (core.md §9)`,
      );
    }
    if (env.path.length > CALL_DEPTH_LIMIT) {
      throw new CoreInvariantError(
        `ctx.call depth limit of ${String(CALL_DEPTH_LIMIT)} exceeded: ${chain} (core.md §9)`,
      );
    }

    assertNestedDeadline({
      kind: NESTED_CALL,
      chain,
      signal: env.signal,
      deadline: env.deadline,
      now: env.now,
    });

    const parsedInput = await validateNestedInput({
      kind: NESTED_CALL,
      schema: action.contract.input,
      input,
      chain,
    });

    const invocation = startNestedInvocation({
      kind: NESTED_CALL,
      deps: env.deps,
      callerRequest: env.request,
      callerName: caller.name,
      calleeName: callee.name,
      now: env.now,
    });
    const { request } = invocation;

    let calleeCtx: ActionCtx | undefined;

    try {
      // The callee sees only the ReadTx facade over the caller's
      // transaction (§9) — the writable capability never travels down.
      const runtime: ContextRuntime<ReadTx> = {
        db: createReadTx(execution.tx),
        logger: env.deps.logger,
        deadline: env.deadline,
        signal: env.signal,
        // Only reads are callable, so any emit throws the precise §4
        // read-action message; the buffer is never flushed.
        emit: createEmitBuffer({ contract: callee, now: env.now }).emit,
        enqueue: rejectNestedEnqueue(callee.name),
        call: createCtxCall({
          ...env,
          callerContract: callee,
          request,
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
        kind: NESTED_CALL,
        schema: action.contract.output,
        calleeName: callee.name,
        raw,
      });

      // §9: audit gets a child entry only when the callee itself declares
      // audit: true. Callable targets are reads, so §8's audited-read rule
      // applies — a separate short transaction, best-effort, never masking
      // the result. (The read happened even if the caller rolls back.)
      const auditHook = env.deps.hooks?.audit;
      if (callee.audit && auditHook !== undefined) {
        const auditTarget = requireNestedAuditTarget(NESTED_CALL, action);
        try {
          await env.deps.db.transaction(async (auditTx) => {
            await auditHook.recordSuccess({
              tx: auditTx,
              ctx,
              contract: callee,
              input: parsedInput,
              output: parsedOutput,
              durationMs: env.now() - invocation.startedAt,
              auditTarget,
              auditSnapshot: action.auditSnapshot,
            });
          });
        } catch (auditError) {
          invocation.log.error({ err: auditError }, "nested call audit failed");
        }
      }

      invocation.finish("ok", calleeCtx);
      return parsedOutput;
    } catch (error) {
      const coreError = toNestedInvocationError(
        NESTED_CALL,
        error,
        callee.name,
      );
      invocation.recordError(coreError);
      invocation.finish(coreError.code, calleeCtx);
      throw coreError;
    }
  };
}

/**
 * Re-authorizes the caller's principal for the callee through the normal
 * context factories (core.md §9): the callee's own permission set and
 * target resolver execute even though the caller was already authorized —
 * defense in depth, and the only way nested resolvers prove they stay in
 * the caller's verified company. Shared with `ctx.callAtomic` (fnd-T19A),
 * whose runtime carries the writable root `Tx` instead of the read facade.
 */
export async function constructCalleeContext<
  TInput extends z.ZodType,
  TOutput extends z.ZodType,
  TTarget,
  TDb extends ReadTx,
>(options: {
  readonly callerCtx: ActionCtx;
  readonly action: ImplementedAction<TInput, TOutput, TTarget>;
  readonly input: z.output<TInput>;
  readonly request: ActionRequestMeta;
  readonly runtime: ContextRuntime<TDb>;
}): Promise<ActionCtx> {
  const { callerCtx, action, input, request, runtime } = options;
  const callee = action.contract;
  switch (callerCtx.principal) {
    case "staff": {
      // The selector here is the caller's already verified companyId —
      // never transport input; membership is still re-read in this
      // transaction and the callee's declared permissions re-checked.
      const ctx = await createStaffContext({
        request,
        runtime,
        session: { userId: callerCtx.userId },
        companySelector: callerCtx.companyId,
      });
      assertDeclaredPermissions(ctx.membership, callee);
      return ctx;
    }
    case "customer":
      return await createCustomerContext({
        request,
        runtime,
        session: { userId: callerCtx.userId },
        input,
        resolveTarget: requireNestedResolver(action),
        inheritedCompanyId: callerCtx.target.companyId,
      });
    case "public": {
      // Public-global callers were rejected by the §9 target rules; only
      // the target scope can reach this construction.
      if (callerCtx.scope !== "target") {
        throw new CoreInvariantError(
          `public-global caller reached nested context construction for "${callee.name}" — the §9 target rules should have rejected it`,
        );
      }
      return await createPublicContext({
        request,
        runtime,
        publicScope: "target",
        input,
        resolveTarget: requireNestedResolver(action),
        inheritedCompanyId: callerCtx.target.companyId,
      });
    }
    case "system": {
      if (callee.systemScope === "global") {
        return createSystemContext(
          callerCtx.serviceName,
          { scope: "global" },
          { request, runtime },
        );
      }
      if (callerCtx.scope !== "tenant") {
        throw new CoreInvariantError(
          `global system caller reached nested context construction for tenant-scoped "${callee.name}" — the §9 compatibility rules should have rejected it`,
        );
      }
      return createSystemContext(
        callerCtx.serviceName,
        { scope: "tenant", companyId: callerCtx.companyId },
        { request, runtime },
      );
    }
    case "consumer":
      return createConsumerContext({
        request,
        runtime,
        session: { userId: callerCtx.userId },
      });
    case "account":
      // Account callers may also invoke consumer discovery reads (§9);
      // the callee's own principal decides the constructed context.
      return callee.principal === "consumer"
        ? createConsumerContext({
            request,
            runtime,
            session: { userId: callerCtx.userId },
          })
        : createAccountContext({
            request,
            runtime,
            session: { userId: callerCtx.userId },
          });
    case "share":
      return await createShareContext({
        request,
        runtime,
        input,
        resolveTarget: requireNestedResolver(action),
        inheritedCompanyId: callerCtx.target.companyId,
      });
  }
}

function requireNestedResolver<
  TInput extends z.ZodType,
  TOutput extends z.ZodType,
  TTarget,
>(
  action: ImplementedAction<TInput, TOutput, TTarget>,
): TargetResolver<TInput, TTarget> {
  const resolver = action.resolveTarget;
  if (resolver === undefined) {
    throw new CoreInvariantError(
      `nested call target "${action.contract.name}" requires a target resolver but none is bound — implementAction should have rejected this pairing`,
    );
  }
  return resolver;
}
