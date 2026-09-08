import type { Database } from "../src/client.js";
import { rolePermissionDefaults } from "../src/schema/companies.js";

/**
 * Phase-0 defaults carried from the v1 permission model. Catalog, customers,
 * pricing, orders, documents, chat, files, assistant, companies:view, and
 * settings:payments keys land here; later module schema tasks extend the
 * table alongside their actions.
 * Owners are absent because they implicitly hold every known permission.
 */
export const rolePermissionDefaultRows = [
  { role: "admin", permission: "companies:view" },
  { role: "admin", permission: "products:view" },
  { role: "admin", permission: "products:create" },
  { role: "admin", permission: "products:edit" },
  { role: "admin", permission: "products:delete" },
  { role: "admin", permission: "customers:view" },
  { role: "admin", permission: "customers:create" },
  { role: "admin", permission: "customers:edit" },
  { role: "admin", permission: "customers:delete" },
  { role: "admin", permission: "customers:invite" },
  { role: "admin", permission: "pricing:view" },
  { role: "admin", permission: "pricing:manage" },
  { role: "admin", permission: "orders:view" },
  { role: "admin", permission: "orders:create" },
  { role: "admin", permission: "orders:edit" },
  { role: "admin", permission: "documents:view" },
  { role: "admin", permission: "documents:create" },
  { role: "admin", permission: "documents:edit" },
  { role: "admin", permission: "chat:view" },
  { role: "admin", permission: "assistant:use" },
  { role: "admin", permission: "files:view" },
  { role: "admin", permission: "files:upload" },
  { role: "admin", permission: "settings:payments" },
  { role: "manager", permission: "companies:view" },
  { role: "manager", permission: "products:view" },
  { role: "manager", permission: "products:create" },
  { role: "manager", permission: "products:edit" },
  { role: "manager", permission: "customers:view" },
  { role: "manager", permission: "customers:create" },
  { role: "manager", permission: "customers:edit" },
  { role: "manager", permission: "customers:invite" },
  { role: "manager", permission: "pricing:view" },
  { role: "manager", permission: "pricing:manage" },
  { role: "manager", permission: "orders:view" },
  { role: "manager", permission: "orders:create" },
  { role: "manager", permission: "orders:edit" },
  { role: "manager", permission: "documents:view" },
  { role: "manager", permission: "documents:create" },
  { role: "manager", permission: "documents:edit" },
  { role: "manager", permission: "chat:view" },
  { role: "manager", permission: "assistant:use" },
  { role: "manager", permission: "files:view" },
  { role: "manager", permission: "files:upload" },
  { role: "employee", permission: "companies:view" },
  { role: "employee", permission: "products:view" },
  { role: "employee", permission: "customers:view" },
  { role: "employee", permission: "pricing:view" },
  { role: "employee", permission: "orders:view" },
  { role: "employee", permission: "orders:create" },
  { role: "employee", permission: "orders:edit" },
  { role: "employee", permission: "documents:view" },
  { role: "employee", permission: "chat:view" },
  { role: "employee", permission: "assistant:use" },
] satisfies readonly (typeof rolePermissionDefaults.$inferInsert)[];

/** Inserts missing defaults and leaves existing rows unchanged. */
export async function seedRolePermissionDefaults(db: Database) {
  return db
    .insert(rolePermissionDefaults)
    .values([...rolePermissionDefaultRows])
    .onConflictDoNothing()
    .returning();
}
