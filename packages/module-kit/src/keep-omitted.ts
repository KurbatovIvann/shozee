export function keepOmitted<T>(value: T | undefined, current: T): T {
  return value === undefined ? current : value;
}
