import { implementAction } from "@showzy/core";
import { readStaffPendingSigningObject } from "../services/read-pending-signing-object.js";
import { readPendingSigningObjectContract } from "./read-pending-signing-object.contract.js";

export const readPendingSigningObject = implementAction(
  readPendingSigningObjectContract,
  {
    handler: async (input, ctx) => {
      return readStaffPendingSigningObject({ ctx, input });
    },
  },
);
