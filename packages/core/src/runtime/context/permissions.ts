/**
 * Staff permission evaluation (companies-foundation.md §2): owner has all
 * known permissions implicitly; for other roles an explicit deny wins,
 * then an explicit grant, then the role default. The precedence lives in
 * exactly one place — the staff factory resolves the effective set when it
 * loads the membership, and `staffHasPermission` is the only read API.
 */
import type { CompanyMemberPermissions } from "@showzy/db";

import { PermissionDeniedError } from "../../errors/index.js";
import {
  expandPermissionPrerequisites,
  permissionRequiresDenied,
} from "./permission-prerequisites.js";
import type { CompanyRole, StaffMembership } from "./types.js";

export const COMPANY_ROLES = ["owner", "admin", "manager", "employee"] as const;

export function isCompanyRole(value: string): value is CompanyRole {
  return (COMPANY_ROLES as readonly string[]).includes(value);
}

export function resolveEffectivePermissions(
  overrides: CompanyMemberPermissions,
  roleDefaults: readonly string[],
): readonly string[] {
  const denied = new Set(overrides.denied);
  const held = [...roleDefaults, ...overrides.granted].filter(
    (permission) => !permissionRequiresDenied(permission, denied),
  );
  return expandPermissionPrerequisites(held);
}

/**
 * The single permission check for staff contexts. Owner short-circuits to
 * every permission (companies-foundation.md §2 — an explicit deny row does
 * not bind the owner); other roles consult the resolved effective set.
 */
export function staffHasPermission(
  membership: StaffMembership,
  permission: string,
): boolean {
  if (membership.role === "owner") {
    return true;
  }
  return membership.permissions.includes(permission);
}

/**
 * Staff authorization beyond membership: every permission the action
 * declares must be held (core.md §2 `permissions`). The pipeline runs
 * this in the preflight and again in the execution transaction; `ctx.call`
 * (core.md §9) re-runs it for the callee's own declared permissions.
 */
export function assertDeclaredPermissions(
  membership: StaffMembership,
  contract: {
    readonly name: string;
    readonly permissions: readonly string[];
  },
): void {
  for (const permission of contract.permissions) {
    if (!staffHasPermission(membership, permission)) {
      throw new PermissionDeniedError(undefined, {
        internalMessage: `staff caller lacks "${permission}" declared by "${contract.name}"`,
      });
    }
  }
}
