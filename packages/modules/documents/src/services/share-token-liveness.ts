import { documentShareTokens } from "@showzy/db/schema/documents";
import { and, gt, isNull, type SQL } from "drizzle-orm";

export interface ShareTokenLifetime {
  readonly revokedAt: Date | null;
  readonly expiresAt: Date;
}

export function liveShareToken(now: Date): SQL | undefined {
  return and(
    isNull(documentShareTokens.revokedAt),
    gt(documentShareTokens.expiresAt, now),
  );
}

export function isLiveShareToken(
  token: ShareTokenLifetime,
  now: Date,
): boolean {
  return token.revokedAt === null && token.expiresAt.getTime() > now.getTime();
}
