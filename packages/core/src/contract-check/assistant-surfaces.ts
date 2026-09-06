/**
 * SHO-471: every `ASSISTANT_SURFACE_REGISTRY` action/tool binding must
 * resolve against the live action registry and the staff-assistant
 * toolset. Exposure is `deriveAiToolSources` — do not re-filter
 * `aiExposure` here. The registry lives in `@showzy/validation` and
 * cannot import `packages/ai` or a module; composition supplies the
 * structural refs and façade names.
 */
import { deriveAiToolSources } from "../contract/ai-exposure.js";
import type { ActionContract } from "../contract/types.js";

/**
 * Structural subset of an assistant surface descriptor. Composition maps
 * the live registry; unit tests pass fixtures. `parse` / copy stay out.
 */
export interface AssistantSurfaceBindingRef {
  readonly kind: string;
  readonly actionNames: readonly string[];
  readonly toolNames: readonly string[];
}

/**
 * Same mapping as `@showzy/ai` `toProviderToolName` (`orders.get` →
 * `orders_get`). Core cannot import `packages/ai`; action names already
 * have exactly one dot.
 */
function toProviderToolName(actionName: string): string {
  return actionName.replaceAll(".", "_");
}

function levenshtein(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  if (left.length === 0) {
    return right.length;
  }
  if (right.length === 0) {
    return left.length;
  }
  const previous: number[] = [];
  const current: number[] = [];
  for (let column = 0; column <= right.length; column += 1) {
    previous[column] = column;
  }
  for (let row = 1; row <= left.length; row += 1) {
    current[0] = row;
    const leftChar = left[row - 1];
    for (let column = 1; column <= right.length; column += 1) {
      const substitution = leftChar === right[column - 1] ? 0 : 1;
      const deletion = (previous[column] ?? 0) + 1;
      const insertion = (current[column - 1] ?? 0) + 1;
      const swap = (previous[column - 1] ?? 0) + substitution;
      current[column] = Math.min(deletion, insertion, swap);
    }
    for (let column = 0; column <= right.length; column += 1) {
      previous[column] = current[column] ?? 0;
    }
  }
  return previous[right.length] ?? right.length;
}

function nearestName(
  query: string,
  candidates: readonly string[],
): string | undefined {
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const distance = levenshtein(query, candidate);
    if (
      distance < bestDistance ||
      (distance === bestDistance && (best === undefined || candidate < best))
    ) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

function withNearest(
  message: string,
  query: string,
  candidates: readonly string[],
): string {
  const nearest = nearestName(query, candidates);
  if (nearest === undefined) {
    return message;
  }
  return `${message} (nearest: "${nearest}")`;
}

function validToolNames(
  exposed: readonly ActionContract[],
  facadeToolNames: readonly string[],
): string[] {
  const names = new Set<string>();
  for (const contract of exposed) {
    names.add(contract.name);
    names.add(toProviderToolName(contract.name));
  }
  for (const facadeName of facadeToolNames) {
    names.add(facadeName);
  }
  return [...names];
}

function unknownActionProblem(
  kind: string,
  actionName: string,
  registeredNames: readonly string[],
): string {
  return withNearest(
    `assistant surface "${kind}": action "${actionName}" is not registered`,
    actionName,
    registeredNames,
  );
}

function notExposedActionProblem(
  kind: string,
  actionName: string,
  contract: ActionContract,
  exposedNames: readonly string[],
): string {
  const nearest = nearestName(actionName, exposedNames);
  const exposure = `aiExposure: "${contract.aiExposure}"`;
  const hint =
    nearest === undefined ? exposure : `${exposure}; nearest: "${nearest}"`;
  return `assistant surface "${kind}": action "${actionName}" is not an AI-exposed contract (${hint})`;
}

function unknownToolProblem(
  kind: string,
  toolName: string,
  knownToolNames: readonly string[],
): string {
  return withNearest(
    `assistant surface "${kind}": tool "${toolName}" does not resolve to a provider name of an exposed action, an exposed action name, or a registered façade`,
    toolName,
    knownToolNames,
  );
}

export function collectAssistantSurfaceBindingProblems(
  contracts: readonly ActionContract[],
  surfaces: readonly AssistantSurfaceBindingRef[],
  facadeToolNames: readonly string[],
  problems: string[],
): void {
  const contractsByName = new Map(
    contracts.map((contract) => [contract.name, contract]),
  );
  const exposed = deriveAiToolSources(contracts);
  const exposedNames = exposed.map((contract) => contract.name);
  const exposedNameSet = new Set(exposedNames);
  const registeredNames = contracts.map((contract) => contract.name);
  const knownTools = validToolNames(exposed, facadeToolNames);
  const knownToolSet = new Set(knownTools);

  for (const surface of surfaces) {
    for (const actionName of surface.actionNames) {
      const contract = contractsByName.get(actionName);
      if (contract === undefined) {
        problems.push(
          unknownActionProblem(surface.kind, actionName, registeredNames),
        );
        continue;
      }
      if (!exposedNameSet.has(actionName)) {
        problems.push(
          notExposedActionProblem(
            surface.kind,
            actionName,
            contract,
            exposedNames,
          ),
        );
      }
    }
    for (const toolName of surface.toolNames) {
      if (!knownToolSet.has(toolName)) {
        problems.push(unknownToolProblem(surface.kind, toolName, knownTools));
      }
    }
  }
}
