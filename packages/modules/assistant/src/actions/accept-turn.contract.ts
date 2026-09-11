/**
 * Staff write: accept a turn of a conversation, in one transaction
 * (SHO-560, ADR-0039).
 *
 * The turn row, the person's message (a chat accept only) and the assistant's
 * placeholder commit together or not at all. The row is both the conversation's
 * lease and the command's receipt:
 *
 * - `accepted` — nothing held the conversation and this command was new;
 * - `replayed` — this command was accepted before, whether or not its turn has
 *   ended; nothing is written and the stored turn is returned;
 * - `busy` — another turn holds the conversation; nothing is written.
 *
 * The messages are opaque payloads the runtime built; their ids are the
 * runtime's to derive from the command. Ids are compared without regard to
 * case and stored lowercase.
 *
 * Mechanical: `timeout: 5000` is three inserts and two indexed reads.
 * `idempotent: false` — the receipt is the row itself, and a replay store would
 * only hide a second write behind the first's response.
 */
import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

import {
  chatMessageBindSchema,
  chatMessagePayloadSchema,
} from "./chat-message-record.contract.js";
import { STAFF_CONVERSATION_AUTHOR_INVARIANT } from "./conversation-view.contract.js";
import {
  assistantTurnBudgetHoldSchema,
  assistantTurnKindSchema,
  assistantTurnViewSchema,
} from "./turn-record.contract.js";

const acceptTurnMessageSchema = z.strictObject({
  messageId: z.uuid(),
  bind: chatMessageBindSchema,
  message: chatMessagePayloadSchema,
});

function sameId(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

export const acceptTurnInputSchema = z
  .strictObject({
    conversationId: z.uuid(),
    kind: assistantTurnKindSchema,
    commandId: z.uuid(),
    /** The accepting request's session; the worker checks it is still live. */
    sessionId: z.string().min(1).max(256),
    userMessage: acceptTurnMessageSchema.optional(),
    placeholder: acceptTurnMessageSchema,
    budgetHold: assistantTurnBudgetHoldSchema,
    /** Продовжити: the interrupted turn's command. */
    continuesCommandId: z.uuid().optional(),
  })
  .refine(
    (input) => (input.kind === "chat") === (input.userMessage !== undefined),
    {
      message:
        "A chat accept stores the person's message; an answer accept stores none.",
      path: ["userMessage"],
    },
  )
  .refine(
    (input) =>
      input.userMessage === undefined ||
      !sameId(input.userMessage.messageId, input.placeholder.messageId),
    {
      message: "The placeholder needs its own message id.",
      path: ["placeholder", "messageId"],
    },
  )
  .refine(
    (input) =>
      input.continuesCommandId === undefined ||
      !sameId(input.continuesCommandId, input.commandId),
    {
      message: "A turn cannot continue itself.",
      path: ["continuesCommandId"],
    },
  );

export const acceptTurnOutputSchema = z.discriminatedUnion("outcome", [
  z.strictObject({
    outcome: z.literal("accepted"),
    conversationId: z.uuid(),
    turn: assistantTurnViewSchema,
  }),
  z.strictObject({
    outcome: z.literal("replayed"),
    conversationId: z.uuid(),
    turn: assistantTurnViewSchema,
  }),
  z.strictObject({
    outcome: z.literal("busy"),
    conversationId: z.uuid(),
  }),
]);

export const acceptTurnContract = defineActionContract({
  name: "assistant.acceptTurn",
  description: `${STAFF_CONVERSATION_AUTHOR_INVARIANT} Accept one turn of a conversation in a single transaction: the turn row, the person's message for a chat accept, and the assistant's placeholder message commit together. The outcome is accepted when the command is new and no other turn holds the conversation; replayed, with nothing written, when this command was accepted before; busy, with nothing written, when another turn is queued or running. A continuation names an interrupted turn's command, and a command that is not an interrupted turn of this conversation is a conflict. Message payloads are opaque and owned by the assistant runtime. A conversation belonging to another author or another company is not-found. Company id is never input.`,
  principal: "staff",
  transport: "internal",
  input: acceptTurnInputSchema,
  output: acceptTurnOutputSchema,
  permissions: ["assistant:use"],
  aiExposure: "internal",
  risk: "write",
  requiresConfirmation: false,
  idempotent: false,
  emits: [],
  atomicCalls: [],
  atomicCallers: [],
  errors: ["VALIDATION", "NOT_FOUND", "CONFLICT"],
  audit: true,
  timeout: 5_000,
});
