import { implementAction, resolveEffectivePermissions } from "@showzy/core";
import {
  companies,
  companyMembers,
  rolePermissionDefaults,
  type CompanyMemberPermissions,
} from "@showzy/db/schema/companies";
import { parseDbEnum } from "@showzy/module-kit/parse-db-enum";
import { asc, eq } from "drizzle-orm";
import type { z } from "zod";

import {
  companyMemberRoleSchema,
  listMineContract,
} from "./list-mine.contract.js";

function parseRole(value: string): z.output<typeof companyMemberRoleSchema> {
  return parseDbEnum(
    companyMemberRoleSchema,
    value,
    `company_members row has illegal role "${value}"`,
  );
}

function sortedEffectivePermissions(
  overrides: CompanyMemberPermissions,
  roleDefaults: readonly string[],
): string[] {
  return [...resolveEffectivePermissions(overrides, roleDefaults)].sort(
    (left, right) => left.localeCompare(right),
  );
}

export const listMine = implementAction(listMineContract, {
  handler: async (_input, ctx) => {
    const rows = await ctx.db
      .select({
        membershipId: companyMembers.id,
        role: companyMembers.role,
        permissions: companyMembers.permissions,
        companyId: companies.id,
        companyName: companies.name,
        companySlug: companies.slug,
        companyPrefix: companies.prefix,
      })
      .from(companyMembers)
      .innerJoin(companies, eq(companyMembers.companyId, companies.id))
      .where(eq(companyMembers.userId, ctx.userId))
      .orderBy(asc(companyMembers.createdAt), asc(companyMembers.id));

    const defaultRows =
      rows.length === 0
        ? []
        : await ctx.db
            .select({
              role: rolePermissionDefaults.role,
              permission: rolePermissionDefaults.permission,
            })
            .from(rolePermissionDefaults)
            .orderBy(
              asc(rolePermissionDefaults.role),
              asc(rolePermissionDefaults.permission),
            );

    const defaultsByRole = new Map<string, string[]>();
    for (const row of defaultRows) {
      const existing = defaultsByRole.get(row.role);
      if (existing === undefined) {
        defaultsByRole.set(row.role, [row.permission]);
      } else {
        existing.push(row.permission);
      }
    }

    return {
      memberships: rows.map((row) => {
        const role = parseRole(row.role);
        return {
          membershipId: row.membershipId,
          role,
          permissions: sortedEffectivePermissions(
            row.permissions,
            defaultsByRole.get(role) ?? [],
          ),
          company: {
            id: row.companyId,
            name: row.companyName,
            slug: row.companySlug,
            prefix: row.companyPrefix,
          },
        };
      }),
    };
  },
});
