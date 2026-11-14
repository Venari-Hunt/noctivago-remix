// Per-item preview in Group and Preset mode (owner, 2026-11-14; approved
// mock mock-noctivago-remix-detail). Play on a row previews that item with
// all its saved settings, one item at a time. A sound previews as it
// behaves: a natural loop loops until Stop; a Random or Scheduled one-shot
// plays once, and with Loop on keeps repeating with its own gap. A group
// previews as a group: each member with its own play mode and settings,
// the group's filters on top. No DOM, no audio.
import { applySoundOverride } from './mixSettings.js'

export const soundKey = (id) => `s:${id}`
export const groupKey = (id) => `g:${id}`

// 'loop' | 'random' | 'scheduled' (the stored playMode 'scatter' is Random).
export function previewKind(entry) {
  const mode = entry?.playMode ?? 'loop'
  if (mode === 'scatter') return 'random'
  if (mode === 'scheduled') return 'scheduled'
  return 'loop'
}

// A Scheduled sound waits minutes or hours in the mix; the preview repeats
// it after this short pause instead, so Loop is audible at all.
export const SCHEDULED_PREVIEW_GAP_SECONDS = 3

const lerp = (a, b, t) => a + (b - a) * t
const num = (v, d) => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d)

// Seconds of silence before a one-shot fires again. Random: anywhere in its
// Gap range (the bias, when on, pulls toward its value, as the mix does).
export function nextGapSeconds(entry, rand = Math.random) {
  if (previewKind(entry) !== 'random') return SCHEDULED_PREVIEW_GAP_SECONDS
  const s = entry.scatter ?? {}
  const lo = Math.max(0, num(s.minGapSeconds, 5))
  const hi = Math.max(lo, num(s.maxGapSeconds, 35))
  let t = rand()
  if (s.gapBiasEnabled && hi > lo) {
    const bias = Math.min(1, Math.max(0, (num(s.gapBiasSeconds, (lo + hi) / 2) - lo) / (hi - lo)))
    t = lerp(t, bias, 0.5)
  }
  return lerp(lo, hi, t)
}

// One shot's per-play variation: a volume factor and a pitch offset in
// semitones, each drawn from the sound's own range.
export function shotVariation(entry, rand = Math.random) {
  const kind = previewKind(entry)
  if (kind === 'loop') return { volume: 1, pitchSemitones: 0 }
  const s = (kind === 'random' ? entry.scatter : entry.schedule) ?? {}
  const vLo = num(s.minVolume, 1)
  const vHi = Math.max(vLo, num(s.maxVolume, 1))
  const pLo = num(s.minPitchSemitones, 0)
  const pHi = Math.max(pLo, num(s.maxPitchSemitones, 0))
  return { volume: lerp(vLo, vHi, rand()), pitchSemitones: lerp(pLo, pHi, rand()) }
}

// The sound as this preset hears it: the library entry with the preset's
// override applied. No preset → the library entry as is.
export function effectiveSound(library, preset, soundId) {
  const base = library.find((s) => s.id === soundId)
  if (!base) return null
  const item = preset?.sounds?.find((s) => s.soundId === soundId)
  return applySoundOverride(base, item?.overrides)
}

// What one sound preview plays: the effective entry and its mix volume.
// repeat: a one-shot keeps firing (the row's Loop, or always inside a group).
export function soundPlan(library, preset, soundId, { repeat = false, gain = null } = {}) {
  const entry = effectiveSound(library, preset, soundId)
  if (!entry) return null
  const stored = preset?.sounds?.find((s) => s.soundId === soundId)?.volume
  const kind = previewKind(entry)
  return { id: soundId, entry, kind, gain: num(gain, num(stored, 1)), repeat: kind === 'loop' ? true : Boolean(repeat) }
}

// A group previews its members in the preset's mix (a member the mix does
// not hold stays silent, as it would in the Mixer). Members repeat as in the
// mix, so a group of one-shots keeps firing until Stop.
export function groupPlan(library, preset, group, { gainOf = null } = {}) {
  if (!group) return null
  const inMix = new Set((preset?.sounds ?? []).map((s) => s.soundId))
  const members = (group.soundIds ?? [])
    .filter((id) => !preset || inMix.has(id))
    .map((id) => soundPlan(library, preset, id, { repeat: true, gain: gainOf?.(id) }))
    .filter(Boolean)
  return { id: group.id, members, filters: group.filters ?? null }
}
