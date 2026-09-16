/**
 * Decide Turbo full vs affected execution for CI (SHO-335).
 *
 * PRs use the workspace package graph (`turbo run --affected`) when the
 * comparison base exists. `--affected` already includes dependents of a
 * changed package; do not add a synthetic `topo` / `^topo` task — this
 * workspace has package cycles (customers↔pricing, documents↔doc-generation)
 * and Turbo refuses `#topo` / `^build` walks on that graph. Pushes to `main`
 * and any unresolved/shallow base run the full workspace suite. Remote cache
 * is never required.
 *
 * CI never reads a cache entry (SHO-708). Because the graph is cyclic and no
 * task declares `^task` edges, a task hash covers only its own package's
 * files: a dependent keeps its hash when a dependency's source changes, so a
 * readable cache replays a stale pass and reports green while the dependent is
 * red. `local:w` writes entries and reads none, which is the same mode the
 * local gate uses (`.claude/scripts/verify.mjs`, SHO-699).
 */

export const TURBO_LOCAL_CACHE = "local:w";

/**
 * @typedef {"full" | "affected"} TurboExecutionMode
 *
 * @typedef {{
 *   mode: TurboExecutionMode,
 *   reason: string,
 *   scmBase?: string,
 *   scmHead?: string,
 * }} TurboExecutionDecision
 *
 * @typedef {{
 *   eventName: string | undefined,
 *   ref: string | undefined,
 *   baseRef: string | undefined,
 *   baseSha: string | undefined,
 *   mergeBase: string | null,
 * }} TurboExecutionInput
 */

/**
 * @param {string | undefined} ref
 */
export function isMainRef(ref) {
  return ref === "refs/heads/main" || ref === "main";
}

/**
 * @param {TurboExecutionInput} input
 * @returns {TurboExecutionDecision}
 */
export function resolveTurboExecutionMode(input) {
  const eventName = input.eventName ?? "";

  if (eventName === "push" && isMainRef(input.ref)) {
    return { mode: "full", reason: "push-to-main" };
  }

  if (eventName === "pull_request") {
    if (!input.mergeBase) {
      return { mode: "full", reason: "unresolved-base" };
    }
    return {
      mode: "affected",
      reason: "pull-request",
      scmBase: input.mergeBase,
      scmHead: "HEAD",
    };
  }

  return { mode: "full", reason: "non-pr-event" };
}

/**
 * @param {{
 *   eventName: string | undefined,
 *   baseRef: string | undefined,
 *   baseSha: string | undefined,
 *   objectExists: (rev: string) => boolean,
 *   mergeBase: (a: string, b: string) => string | null,
 * }} input
 * @returns {{ ok: true, mergeBase: string, resolvedFrom: string } | { ok: false, reason: string }}
 */
export function resolveComparisonBase(input) {
  if (input.eventName !== "pull_request") {
    return { ok: false, reason: "not-pull-request" };
  }

  /** @type {string[]} */
  const candidates = [];
  if (input.baseSha) {
    candidates.push(input.baseSha);
  }
  if (input.baseRef) {
    candidates.push(`origin/${input.baseRef}`);
    candidates.push(input.baseRef);
  }

  for (const candidate of candidates) {
    if (!input.objectExists(candidate)) {
      continue;
    }
    const mergeBase = input.mergeBase("HEAD", candidate);
    if (mergeBase) {
      return { ok: true, mergeBase, resolvedFrom: candidate };
    }
  }

  return { ok: false, reason: "unresolved-base" };
}

/**
 * @param {string} task
 * @param {TurboExecutionDecision} decision
 * @param {string[]} [extraArgs]
 * @returns {string[]}
 */
export function buildTurboRunArgs(task, decision, extraArgs = []) {
  const args = ["run", task, `--cache=${TURBO_LOCAL_CACHE}`, "--ui=stream"];
  if (decision.mode === "affected") {
    args.push("--affected");
  }
  args.push(...extraArgs);
  return args;
}

/**
 * @param {TurboExecutionDecision} decision
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {NodeJS.ProcessEnv}
 */
export function buildTurboRunEnv(decision, env = process.env) {
  if (decision.mode !== "affected" || !decision.scmBase) {
    return { ...env };
  }
  return {
    ...env,
    TURBO_SCM_BASE: decision.scmBase,
    TURBO_SCM_HEAD: decision.scmHead ?? "HEAD",
  };
}
