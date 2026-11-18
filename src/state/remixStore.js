// Generic external store for Remix's React components. Values live here, not in
// React state, because RemixTab reads them synchronously right after writing
// them, before React has rendered. Components read through useSyncExternalStore
// (store.subscribe, store.get).

/**
 * @param {object} defaults  Every key the store holds, with its starting value.
 * @param {(key: string, value: any) => any} [normalize]  Cleans a value before it is stored (clamp, coerce).
 */
export function createStore(defaults, normalize = (_key, value) => value) {
  let values = { ...defaults }
  const listeners = new Set()
  return {
    get: () => values,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    // Unknown keys and undefined values are ignored. Notifies once per call,
    // and only when something actually changed, so get() keeps a stable
    // reference between changes (useSyncExternalStore needs that).
    set(patch) {
      let next = values
      for (const [key, value] of Object.entries(patch)) {
        if (!(key in defaults) || value === undefined) continue
        const clean = normalize(key, value)
        if (Object.is(next[key], clean)) continue
        if (next === values) next = { ...values }
        next[key] = clean
      }
      if (next === values) return
      values = next
      for (const listener of listeners) listener()
    }
  }
}
