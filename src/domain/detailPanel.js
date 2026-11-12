// What the library's drill-in panel lists (owner, 2026-11-11; approved mock
// mock-noctivago-remix-detail, placement C "drill in", picked 2026-11-12).
// Group mode, a group picked: its members, each with its volume. Preset
// mode, a preset picked: its groups, then the sounds outside any group; a
// group opens the group panel, a sound its Volume and Pan. No DOM.
//
// A member's "volume inside the group" is its volume in the group's preset
// (preset.sounds[].volume): a sound sits in at most one group per preset,
// so that number only ever feeds this group's bus.
import { applySoundOverride, formatPan } from './mixSettings.js'

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

// The panel's fader is 0..1 with unity (100%) at the right end, linear, so
// the bar is as full as the percent beside it says (as the mock draws it).
// Boosting past 100% stays in the Mixer; a stored boost shows as a full
// fader with its real percent.
export function faderToGain(p) {
  return Math.min(1, Math.max(0, Number(p) || 0))
}

export function gainToFader(gain) {
  return Math.min(1, Math.max(0, Number(gain ?? 1)))
}

export const formatGain = (gain) => `${Math.round(Math.max(0, Number(gain) || 0) * 100)}%`
export { formatPan }

const nameOf = (library, id) => library.find((s) => s.id === id)?.name ?? 'Missing sound'

// volumeOf(soundId) lets the caller hand in the Mixer's live volumes when
// this preset is the one playing; otherwise the stored preset volume.
function volumeGetter(preset, volumeOf) {
  return (id) => {
    const live = volumeOf?.(id)
    if (Number.isFinite(live)) return live
    const v = preset?.sounds?.find((s) => s.soundId === id)?.volume
    return Number.isFinite(v) ? v : 1
  }
}

export function groupDetail(group, preset, library, volumeOf) {
  if (!group) return null
  const vol = volumeGetter(preset, volumeOf)
  // A member the preset's mix does not hold is listed, dimmed, with no fader.
  const inMix = new Set((preset?.sounds ?? []).map((s) => s.soundId))
  const members = (group.soundIds ?? []).map((id) => ({ id, name: nameOf(library, id), gain: vol(id), inMix: inMix.has(id), missing: !library.some((s) => s.id === id) }))
  return { kind: 'group', id: group.id, name: group.name, members, meta: `Group · ${plural(members.length, 'sound')}` }
}

export function presetDetail(preset, library, volumeOf) {
  if (!preset) return null
  const vol = volumeGetter(preset, volumeOf)
  const groups = (preset.groups ?? []).map((g) => ({ id: g.id, name: g.name, count: g.soundIds?.length ?? 0 }))
  const grouped = new Set((preset.groups ?? []).flatMap((g) => g.soundIds ?? []))
  const sounds = (preset.sounds ?? []).filter((s) => !grouped.has(s.soundId)).map((s) => ({ id: s.soundId, name: nameOf(library, s.soundId), gain: vol(s.soundId) }))
  const empty = !groups.length && !(preset.sounds ?? []).length
  return { kind: 'preset', id: preset.id, name: preset.name, groups, sounds, empty, meta: `Preset · ${empty ? 'empty' : `${plural(groups.length, 'group')}, ${plural(sounds.length, 'sound')}`}` }
}

// library here is the raw baseline (no override applied); the preset's own
// override for this sound decides its pan.
export function soundDetail(preset, soundId, library, volumeOf) {
  const item = preset?.sounds?.find((s) => s.soundId === soundId)
  const base = library.find((s) => s.id === soundId)
  if (!item || !base) return null
  const effective = applySoundOverride(base, item.overrides)
  return { kind: 'sound', id: soundId, name: base.name, gain: volumeGetter(preset, volumeOf)(soundId), pan: Number(effective.filters?.pan) || 0 }
}

// The override a Pan change writes: the preset's override with its filters'
// pan replaced. Filters start from the effective ones, so a sound with no
// filters override keeps its own baseline filters in this preset.
export function panOverride(preset, soundId, library, pan) {
  const item = preset?.sounds?.find((s) => s.soundId === soundId)
  const base = library.find((s) => s.id === soundId)
  if (!item || !base) return null
  const overrides = item.overrides ?? {}
  const filters = overrides.filters ?? base.filters ?? {}
  return { ...overrides, filters: { ...filters, pan: Math.min(1, Math.max(-1, Number(pan) || 0)) } }
}

// preset.sounds with one volume changed, or null when the preset does not
// hold that sound: preset.sounds is the mix, so adding one would turn it on.
export function withSoundVolume(preset, soundId, gain) {
  const sounds = preset?.sounds ?? []
  if (!sounds.some((s) => s.soundId === soundId)) return null
  const v = Math.max(0, Number(gain) || 0)
  return sounds.map((s) => (s.soundId === soundId ? { ...s, volume: v } : s))
}
