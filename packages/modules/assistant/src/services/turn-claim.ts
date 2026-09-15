import { ConflictError } from "@showzy/core/errors";
import {
  assistantTurns,
  type AssistantTurnKind,
} from "@showzy/db/schema/assistant";
import { ASSISTANT_TURN_CLAIM_LOST_MESSAGE } from "@showzy/validation/assistant-turn-claim";
import { and, eq } from "drizzle-orm";

import type { WritableStaffDb } from "./writable.js";

export interface TurnClaim {
  readonly kind: AssistantTurnKind;
  readonly commandId: string;
}

export async function holdTurnClaim(
  db: WritableStaffDb,
  scope: {
    readonly companyId: string;
    readonly conversationId: string;
    readonly claim: TurnClaim | undefined;
  },
): Promise<void> {
  if (scope.claim === undefined) {
    return;
  }
  const held = await db
    .select({ id: assistantTurns.id })
    .from(assistantTurns)
    .where(
      and(
        eq(assistantTurns.companyId, scope.companyId),
        eq(assistantTurns.conversationId, scope.conversationId),
        eq(assistantTurns.kind, scope.claim.kind),
        eq(assistantTurns.commandId, scope.claim.commandId),
        eq(assistantTurns.status, "running"),
      ),
    )
    .limit(1)
    .for("share");
  if (held.length === 0) {
    throw new ConflictError(ASSISTANT_TURN_CLAIM_LOST_MESSAGE);
  }
}
