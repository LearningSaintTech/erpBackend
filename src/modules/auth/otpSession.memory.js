const store = new Map();

function prune(key) {
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() > entry.exp) {
    store.delete(key);
    return null;
  }
  return entry;
}

export function memorySet(key, value, ttlSec) {
  store.set(key, { value, exp: Date.now() + Number(ttlSec) * 1000 });
}

export function memoryGet(key) {
  const entry = prune(key);
  return entry ? entry.value : null;
}

export function memoryDel(key) {
  store.delete(key);
}

export function memoryIncr(key, windowSec) {
  const entry = prune(key);
  const next = entry ? Number(entry.value) + 1 : 1;
  const ttlMs = entry ? Math.max(1, entry.exp - Date.now()) : Number(windowSec) * 1000;
  store.set(key, { value: next, exp: Date.now() + ttlMs });
  return next;
}
