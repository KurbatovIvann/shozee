import { createAuditTarget, pickString } from "@showzy/module-kit/audit-target";
import { z } from "zod";

/**
 * Writes audit the conversation aggregate. Create returns `{ id }`; the message
 * and history writes carry `conversationId` on input and output.
 */
export const conversationAuditTarget = createAuditTarget({
  type: "conversation",
  fallback: "uncreated",
  steps: [
    {
      source: "output",
      schema: z.object({ conversationId: z.string() }),
      pick: (data) => pickString("conversationId", data),
    },
    {
      source: "output",
      schema: z.object({ id: z.string() }),
      pick: (data) => pickString("id", data),
    },
    {
      source: "input",
      schema: z.object({ conversationId: z.string() }),
      pick: (data) => pickString("conversationId", data),
    },
  ],
});
