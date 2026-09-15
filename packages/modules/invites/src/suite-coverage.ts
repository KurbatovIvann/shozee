import type { SuiteCoverageManifest } from "@showzy/core";

export const invitesSuiteCoverage = {
  isolation: [
    "invites.accept",
    "invites.create",
    "invites.get",
    "invites.list",
    "invites.revoke",
  ],
  publicProjection: [],
  consumerIsolation: [],
  accountIsolation: [],
  shareIsolation: [],
  idempotency: ["invites.accept", "invites.create", "invites.revoke"],
  events: ["invites"],
  atomic: [{ caller: "invites.accept", callee: "customers.applyInviteCrm" }],
  jobIsolation: [],
} as const satisfies SuiteCoverageManifest;
