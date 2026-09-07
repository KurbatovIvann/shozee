/**
 * Nested key-path walk used by uk/en copy parity tests. Not a public
 * subpath — later namespace tests in this package import it relatively.
 */
export function leafPaths(value: unknown, prefix = ""): string[] {
  if (value === null || typeof value !== "object") {
    return prefix === "" ? [] : [prefix];
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) {
    return prefix === "" ? [] : [prefix];
  }
  return entries.flatMap(([key, child]) =>
    leafPaths(child, prefix === "" ? key : `${prefix}.${key}`),
  );
}

export function leafAt(root: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => {
    if (current === null || typeof current !== "object") {
      return undefined;
    }
    return (current as Record<string, unknown>)[key];
  }, root);
}
