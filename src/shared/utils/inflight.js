/**
 * Share one in-flight computation between concurrent identical calls.
 *
 * The dashboard fires several report endpoints at once and each of them recomputes the same
 * factory-wide stats (inventory, production …). Callers that arrive while a computation for the
 * same key is running get that same promise. Nothing is cached once it settles, so results are
 * never stale.
 */
export function dedupeInflight(fn, keyOf = (...args) => String(args[0])) {
  const running = new Map();
  return function deduped(...args) {
    const key = keyOf(...args);
    const existing = running.get(key);
    if (existing) return existing;
    const p = Promise.resolve()
      .then(() => fn(...args))
      .finally(() => running.delete(key));
    running.set(key, p);
    return p;
  };
}
