// Where a sound's markers live: this app's localStorage, one key per sound id
// (a plugin has no store of its own, and markers are editing aids, not part
// of the baked audio). Every access is guarded - a blocked or full storage
// must leave Remix working, just without remembered markers.
import { normalizeMarkers } from './markers.js'

const KEY = (soundId) => `noctivago.remix.markers.${soundId}`

export function loadMarkers(soundId, duration = Infinity) {
  try {
    const raw = window.localStorage.getItem(KEY(soundId))
    return raw ? normalizeMarkers(JSON.parse(raw), duration) : []
  } catch {
    return []
  }
}

export function saveMarkers(soundId, markers) {
  try {
    if (markers.length) window.localStorage.setItem(KEY(soundId), JSON.stringify(markers))
    else window.localStorage.removeItem(KEY(soundId))
  } catch {
    // Storage unavailable: markers last for this session only.
  }
}
