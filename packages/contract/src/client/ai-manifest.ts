/**
 * The AI tool-manifest *source* (contract.md §2). Implementation lives in
 * `@showzy/core/contract` so the registry-wide contract check (SHO-467)
 * reuses the same derivation instead of a second filter.
 */
export {
  aiToolSourcesForPrincipal,
  deriveAiToolSources,
} from "@showzy/core/contract";
