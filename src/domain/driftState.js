import { normalizeFluctuationAxis } from '../audio/Modulator.js'
import { defaultFluctuation } from './mixSettings.js'

// Pure drift (fluctuation) helpers for the Remix tab. The tab keeps the
// controls and the debounced library write; this keeps the data rules.

// The normalized config a sound's saved drift loads as. A sound saved before
// pan drift existed gets the default spread, not three circles at center.
export function loadedFluctuation(fluctuation) {
  return {
    volume: normalizeFluctuationAxis(fluctuation?.volume, 1),
    pitch: normalizeFluctuationAxis(fluctuation?.pitch, 0),
    pan: fluctuation?.pan ? normalizeFluctuationAxis(fluctuation.pan, 0) : { ...defaultFluctuation().pan }
  }
}

// Fingerprint used for the dirty check (never includes the pan default above).
export function fluctuationFingerprint(fluctuation) {
  return JSON.stringify({
    volume: normalizeFluctuationAxis(fluctuation?.volume, 1),
    pitch: normalizeFluctuationAxis(fluctuation?.pitch, 0),
    pan: normalizeFluctuationAxis(fluctuation?.pan, 0)
  })
}

export function isFluctuationDirty(fluctuation, savedFingerprint) {
  return savedFingerprint != null && fluctuationFingerprint(fluctuation) !== savedFingerprint
}

// The sound's Sound Group drift settings that replace its own in the Mixer
// and exports, or null. Mirrors groupDrift.js's BUS_CAPABLE_AXES (it cannot be
// imported: plugin sandbox).
export function groupDriftFor(soundId, presets, editingPresetId) {
  if (!soundId) return null
  const preset = presets?.find((p) => p.id === editingPresetId)
  const group = preset?.groups?.find((g) => g.soundIds?.includes(soundId))
  const f = group?.filters?.fluctuation
  if (!f) return null
  const perSound = ['volume', 'pitch', 'pan'].filter((a) => f[a]?.enabled && (f[a].perSound || a === 'pitch'))
  const sharedAxes = ['volume', 'pan'].filter((a) => f[a]?.enabled && !f[a].perSound)
  return perSound.length || sharedAxes.length ? { group, perSound, sharedAxes } : null
}

// The two note texts under Drift and Scatter/Schedule ('' hides a note).
export function groupOverrideNotes(info) {
  const list = (axes) => axes.join(' and ')
  let fluc = ''
  let shot = ''
  if (info) {
    const name = `"${info.group.name}"`
    if (info.perSound.length) {
      fluc = `In the Mixer and exports, this sound's ${list(info.perSound)} drift comes from its group ${name} (each sound on its own), not from the bars below.`
      shot = `In the Mixer and exports, the ${list(info.perSound)} range comes from this sound's group ${name}'s drift settings, not from the bars below.`
    }
    const overridden = info.sharedAxes.filter((a) => !info.perSound.includes(a))
    if (overridden.length) {
      fluc = `${fluc ? `${fluc} ` : ''}Its group ${name} drifts ${list(overridden)} for the whole group, so this sound's own ${list(overridden)} drift is switched off there.`
    }
  }
  return { fluc, shot }
}
