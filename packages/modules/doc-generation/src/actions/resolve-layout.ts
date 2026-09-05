import { implementAction } from "@showzy/core";
import { resolveLayoutContract } from "./resolve-layout.contract.js";
import { resolveDocumentLayout } from "../services/layouts.js";

export const resolveLayout = implementAction(resolveLayoutContract, {
  handler: (input) => {
    return Promise.resolve(resolveDocumentLayout(input));
  },
});
