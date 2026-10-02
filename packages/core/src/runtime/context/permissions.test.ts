/**
 * Permission precedence (companies-foundation.md §2): owner-all, then
 * explicit deny wins, then explicit grant, then role default. These are
 * the pure rules; the staff factory's loading of the membership row and
 * role defaults is covered by the factories integration suite.
 */
import { describe, expect, it } from "vitest";

import {
  expandPermissionPrerequisites,
  PERMISSION_CATALOG,
} from "./permission-prerequisites.js";
import {
  isCompanyRole,
  resolveEffectivePermissions,
  staffHasPermission,
} from "./permissions.js";

describe("the same-resource rule over the permission catalog", () => {
  const catalog: readonly string[] = PERMISSION_CATALOG;
  const viewOf = (permission: string): string =>
    `${permission.split(":")[0] ?? ""}:view`;
  const isView = (permission: string): boolean =>
    permission.split(":")[1] === "view";

  it("names the only permissions with no :view sibling", () => {
    expect(
      catalog.filter(
        (permission) =>
          !isView(permission) && !catalog.includes(viewOf(permission)),
      ),
    ).toEqual(["assistant:use", "settings:payments"]);
  });

  it("every other non-view permission implies its own resource's view", () => {
    for (const permission of catalog) {
      if (isView(permission) || !catalog.includes(viewOf(permission))) {
        continue;
      }
      expect(expandPermissionPrerequisites([permission])).toContain(
        viewOf(permission),
      );
    }
  });
});

describe("resolveEffectivePermissions", () => {
  it("unions role defaults with explicit grants", () => {
    const effective = resolveEffectivePermissions(
      { granted: ["pricing:manage"], denied: [] },
      ["orders:view", "orders:create"],
    );
    expect([...effective].sort()).toEqual([
      "companies:view",
      "customers:view",
      "orders:create",
      "orders:view",
      "pricing:manage",
      "pricing:view",
      "products:view",
    ]);
  });

  it("a grant carries the prerequisites of the job it authorizes", () => {
    const effective = resolveEffectivePermissions(
      { granted: ["pricing:manage"], denied: [] },
      [],
    );
    expect([...effective].sort()).toEqual([
      "customers:view",
      "pricing:manage",
      "pricing:view",
      "products:view",
    ]);
  });

  it("a deny of a resource's view removes that resource's writes", () => {
    const effective = resolveEffectivePermissions(
      { granted: ["pricing:manage"], denied: ["pricing:view"] },
      ["chat:view"],
    );
    expect(effective).toEqual(["chat:view"]);
  });

  it("an explicit deny of a prerequisite removes every permission that requires it", () => {
    const effective = resolveEffectivePermissions(
      { granted: ["pricing:manage"], denied: ["products:view"] },
      ["pricing:view"],
    );
    expect(effective).toEqual([]);
  });

  it("a deny propagates through a transitive prerequisite", () => {
    const effective = resolveEffectivePermissions(
      { granted: [], denied: ["customers:view"] },
      ["orders:create", "orders:view", "companies:view"],
    );
    expect(effective).toEqual(["companies:view"]);
  });

  it("explicit deny wins over both the role default and an explicit grant", () => {
    const effective = resolveEffectivePermissions(
      // A row granting and denying the same key is contradictory input;
      // deny wins because deny always wins (companies-foundation.md §2).
      { granted: ["orders:create"], denied: ["orders:create", "orders:view"] },
      ["orders:view"],
    );
    expect(effective).toEqual([]);
  });

  it("deduplicates a grant that repeats a role default", () => {
    const effective = resolveEffectivePermissions(
      { granted: ["orders:view"], denied: [] },
      ["orders:view"],
    );
    expect([...effective].sort()).toEqual([
      "companies:view",
      "customers:view",
      "orders:view",
    ]);
  });

  it("leaves a permission with no declared prerequisites alone", () => {
    const effective = resolveEffectivePermissions({ granted: [], denied: [] }, [
      "chat:view",
      "assistant:use",
    ]);
    expect(effective).toEqual(["chat:view", "assistant:use"]);
  });
});

describe("staffHasPermission", () => {
  it("owner has every permission implicitly, even with an empty set", () => {
    const membership = { role: "owner" as const, permissions: [] };
    expect(staffHasPermission(membership, "orders:create")).toBe(true);
    expect(staffHasPermission(membership, "anything:atAll")).toBe(true);
  });

  it("owner keeps every permission even when a prerequisite is denied", () => {
    const permissions = resolveEffectivePermissions(
      { granted: ["pricing:manage"], denied: ["products:view"] },
      [],
    );
    const membership = { role: "owner" as const, permissions };
    expect(staffHasPermission(membership, "products:view")).toBe(true);
    expect(staffHasPermission(membership, "pricing:manage")).toBe(true);
  });

  it("non-owner roles consult only the resolved effective set", () => {
    const membership = {
      role: "manager" as const,
      permissions: ["orders:view"],
    };
    expect(staffHasPermission(membership, "orders:view")).toBe(true);
    expect(staffHasPermission(membership, "orders:create")).toBe(false);
  });
});

describe("isCompanyRole", () => {
  it("accepts exactly the four companies-foundation roles", () => {
    for (const role of ["owner", "admin", "manager", "employee"]) {
      expect(isCompanyRole(role)).toBe(true);
    }
    expect(isCompanyRole("superadmin")).toBe(false);
    expect(isCompanyRole("")).toBe(false);
  });
});
