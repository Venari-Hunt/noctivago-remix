// Timing markers: named points on a sound's own timeline (original-file
// seconds), the same time domain as loopStart/loopEnd. Rules only, no DOM.
// Decided with the owner's approved mock (mock-noctivago-remix-markers):
// auto names "Marker N", five muted colors in rotation, snap within 8 px.

export const MARKER_COLORS = ['#f0b429', '#7cc4ff', '#8fd694', '#f08fa8', '#b79cf5']

export const MARKER_SNAP_PX = 8

// Two markers closer than this count as the same spot (Ctrl+M twice).
export const MARKER_MIN_GAP_SECONDS = 0.05

const round1 = (t) => Math.round(t * 10) / 10

export function markerColor(marker) {
  const n = MARKER_COLORS.length
  return MARKER_COLORS[((marker.color % n) + n) % n]
}

// Lowest "Marker N" not already used, so deleting one and adding another
// never repeats a name.
function nextAutoName(markers) {
  const used = new Set(markers.map((m) => m.name))
  let n = 1
  while (used.has(`Marker ${n}`)) n++
  return `Marker ${n}`
}

// Returns { markers, added } - added is null when a marker already sits at
// that time (the caller shows "A marker is already at ...").
export function addMarker(markers, time, duration = Infinity) {
  const t = round1(Math.min(Math.max(time, 0), duration))
  if (markers.some((m) => Math.abs(m.time - t) < MARKER_MIN_GAP_SECONDS)) return { markers, added: null }
  const id = markers.reduce((max, m) => Math.max(max, m.id), 0) + 1
  const added = { id, time: t, name: nextAutoName(markers), color: markers.length % MARKER_COLORS.length }
  return { markers: [...markers, added], added }
}

export function removeMarker(markers, id) {
  return markers.filter((m) => m.id !== id)
}

export function updateMarker(markers, id, patch) {
  return markers.map((m) => (m.id === id ? { ...m, ...patch } : m))
}

export function moveMarker(markers, id, time, duration = Infinity) {
  return updateMarker(markers, id, { time: round1(Math.min(Math.max(time, 0), duration)) })
}

export function renameMarker(markers, id, name) {
  const clean = String(name ?? '').trim().slice(0, 40)
  return updateMarker(markers, id, { name: clean || 'Marker' })
}

export function sortedMarkers(markers) {
  return markers.slice().sort((a, b) => a.time - b.time)
}

// The marker nearest to `time` within `toleranceSeconds`, or null.
export function nearestMarker(markers, time, toleranceSeconds) {
  let best = null
  let bestDist = Infinity
  for (const m of markers) {
    const d = Math.abs(m.time - time)
    if (d <= toleranceSeconds && d < bestDist) {
      best = m
      bestDist = d
    }
  }
  return best
}

// Snap a dragged time to a marker. secondsPerPixel turns the 8 px reach into
// seconds for the current zoom. Returns { time, marker } (marker null = free).
export function snapToMarker(markers, time, secondsPerPixel, snapPx = MARKER_SNAP_PX) {
  if (!markers.length || !(secondsPerPixel > 0) || snapPx <= 0) return { time, marker: null }
  const marker = nearestMarker(markers, time, snapPx * secondsPerPixel)
  return marker ? { time: marker.time, marker } : { time, marker: null }
}

// Whatever was saved, keep only well-formed markers (a hand-edited or old
// value must never break the editor).
export function normalizeMarkers(raw, duration = Infinity) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const m of raw) {
    if (!m || !Number.isFinite(m.time) || m.time < 0 || m.time > duration) continue
    const idOk = Number.isInteger(m.id) && m.id > 0 && !out.some((o) => o.id === m.id)
    out.push({
      id: idOk ? m.id : 0,
      time: round1(m.time),
      name: typeof m.name === 'string' && m.name.trim() ? m.name.trim().slice(0, 40) : 'Marker',
      color: Number.isInteger(m.color) ? m.color : 0
    })
  }
  let nextId = out.reduce((max, m) => Math.max(max, m.id), 0) + 1
  for (const m of out) if (!m.id) m.id = nextId++
  return sortedMarkers(out)
}
