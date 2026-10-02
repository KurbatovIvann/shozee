export const PERMISSION_CATALOG = [
  "assistant:use",
  "chat:view",
  "companies:view",
  "customers:create",
  "customers:delete",
  "customers:edit",
  "customers:invite",
  "customers:view",
  "documents:create",
  "documents:edit",
  "documents:view",
  "files:upload",
  "files:view",
  "orders:create",
  "orders:edit",
  "orders:view",
  "pricing:manage",
  "pricing:view",
  "products:create",
  "products:delete",
  "products:edit",
  "products:view",
  "settings:payments",
] as const;

const knownPermissions = new Set<string>(PERMISSION_CATALOG);

export const PERMISSION_CALL_PREREQUISITES: Readonly<
  Record<string, readonly string[]>
> = {
  "customers:create": ["pricing:view"],
  "customers:edit": ["pricing:view"],
  "customers:invite": ["customers:view", "pricing:view"],
  "documents:create": [
    "companies:view",
    "customers:view",
    "documents:view",
    "orders:view",
  ],
  "documents:edit": ["documents:view", "files:view"],
  "documents:view": ["companies:view"],
  "orders:create": [
    "companies:view",
    "customers:view",
    "pricing:view",
    "products:view",
  ],
  "orders:view": ["companies:view", "customers:view"],
  "pricing:manage": ["products:view"],
  "pricing:view": ["customers:view", "products:view"],
  "products:edit": ["files:view"],
};

export function sameResourceViewPermission(
  permission: string,
): string | undefined {
  const [resource, verb] = permission.split(":");
  if (resource === undefined || verb === undefined || verb === "view") {
    return undefined;
  }
  const view = `${resource}:view`;
  return knownPermissions.has(view) ? view : undefined;
}

export function permissionPrerequisites(permission: string): readonly string[] {
  const fromCallEdges = PERMISSION_CALL_PREREQUISITES[permission] ?? [];
  const view = sameResourceViewPermission(permission);
  if (view === undefined || fromCallEdges.includes(view)) {
    return fromCallEdges;
  }
  return [view, ...fromCallEdges];
}

export function expandPermissionPrerequisites(
  permissions: Iterable<string>,
): readonly string[] {
  const expanded = new Set<string>();
  const pending = [...permissions];
  for (let index = 0; index < pending.length; index += 1) {
    const permission = pending[index];
    if (permission === undefined || expanded.has(permission)) {
      continue;
    }
    expanded.add(permission);
    pending.push(...permissionPrerequisites(permission));
  }
  return [...expanded];
}

export function permissionRequiresDenied(
  permission: string,
  denied: ReadonlySet<string>,
): boolean {
  return expandPermissionPrerequisites([permission]).some((required) =>
    denied.has(required),
  );
}
