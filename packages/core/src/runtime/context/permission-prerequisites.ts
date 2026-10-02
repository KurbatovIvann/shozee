export const PERMISSION_PREREQUISITES: Readonly<
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

export function permissionPrerequisites(permission: string): readonly string[] {
  return PERMISSION_PREREQUISITES[permission] ?? [];
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
