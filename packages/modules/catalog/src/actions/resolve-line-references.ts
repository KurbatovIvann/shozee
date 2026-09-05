import { implementAction } from "@showzy/core";
import { CoreInvariantError } from "@showzy/core/errors";

import { resolveCatalogLineReferences } from "../services/resolve-line-references.js";
import { resolveLineReferencesContract } from "./resolve-line-references.contract.js";

export const resolveLineReferences = implementAction(
  resolveLineReferencesContract,
  {
    handler: async (input, ctx) => {
      const lines = await resolveCatalogLineReferences({
        db: ctx.db,
        companyId: ctx.companyId,
        lines: input.lines,
      });
      if (lines.length !== input.lines.length) {
        throw new CoreInvariantError(
          "catalog.resolveLineReferences returned a different line count than input",
        );
      }
      return { lines: [...lines] };
    },
  },
);
