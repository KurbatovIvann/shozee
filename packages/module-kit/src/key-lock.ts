/**
 * Per-key mutex over overlapping awaits. JavaScript is single-threaded, but
 * an await between read and write still races two overlapping calls for the
 * same key. Cross-process atomicity is Redis Lua, not this helper.
 */
export function withKeyLock<T>(
  tails: Map<string, Promise<void>>,
  key: string,
  work: () => Promise<T>,
): Promise<T> {
  const previous = tails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  tails.set(
    key,
    previous.then(
      () => gate,
      () => gate,
    ),
  );
  return previous.then(work, work).finally(release);
}
