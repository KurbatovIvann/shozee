import { implementAction } from "@showzy/core";
import { listLayoutsContract } from "./list-layouts.contract.js";
import { listDocumentLayouts } from "../services/layouts.js";

export const listLayouts = implementAction(listLayoutsContract, {
  handler: (input) => {
    return Promise.resolve({ layouts: [...listDocumentLayouts(input.type)] });
  },
});
