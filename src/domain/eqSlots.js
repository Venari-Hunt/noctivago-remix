// Fixed EQ band slots (LYNX, owner 2026-11-11). The editor always shows
// EQ_SLOT_COUNT slots; the unused ones are Off and wait to be turned on.
// Saved data does not change: it stays a plain list of bands. Slots are
// padded in on load and the untouched trailing ones are stripped on read,
// so old presets, the core engine and the phone player see the same shape.

export const EQ_SLOT_COUNT = 8
// Soft ceiling kept from the list days (each band is a real filter node).
export const EQ_MAX_BANDS = 20
export const EMPTY_SLOT = Object.freeze({ freqHz: 1000, gainDb: 0, q: 1, type: 'off', slope: 'gentle', muted: false })

// An Off slot nobody has touched: hidden on the graph, dropped on save.
export function isEmptySlot(band) {
  if (!band) return false
  return Object.keys(EMPTY_SLOT).every((k) => band[k] === EMPTY_SLOT[k]) &&
    Object.keys(band).every((k) => k in EMPTY_SLOT)
}

export function padEqSlots(bands, count = EQ_SLOT_COUNT) {
  const out = (bands ?? []).map((b) => ({ ...b }))
  while (out.length < count) out.push({ ...EMPTY_SLOT })
  return out
}

// Drops trailing empty slots only, so the index of every kept band stays
// the same (callers index bands by the selected slot).
export function compactEqSlots(bands) {
  let end = bands.length
  while (end > 0 && isEmptySlot(bands[end - 1])) end--
  return bands.slice(0, end).map((b) => ({ ...b }))
}

// First slot that is free to turn on: an empty slot first, then any Off one.
export function freeSlotIndex(bands) {
  const empty = bands.findIndex(isEmptySlot)
  return empty !== -1 ? empty : bands.findIndex((b) => b.type === 'off')
}
