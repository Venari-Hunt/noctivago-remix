// Pure knob math, shared by Knob.jsx and its tests.
export const DRAG_PX_FULL_RANGE = 160 // same as the mock: 160 px of drag = the whole range

export function knobFraction(value, min, max) {
  if (!(max > min)) return 0
  return Math.min(1, Math.max(0, (value - min) / (max - min)))
}

// Snaps a 0..1 position to the input's own step grid.
export function knobValueAt(fraction, min, max, step) {
  const raw = min + Math.min(1, Math.max(0, fraction)) * (max - min)
  const s = step > 0 ? step : 1
  const snapped = min + Math.round((raw - min) / s) * s
  return Math.min(max, Math.max(min, Number(snapped.toFixed(6))))
}
