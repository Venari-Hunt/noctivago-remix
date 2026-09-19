// Remix's settings rules: neutral values, defaults, clones and equality
// checks for sound, group and whole-mix filters and drift. No DOM.
import { normalizeFluctuationAxis } from '../audio/Modulator.js'


// Mirrors src/shared/constants.js's MAX_BUFFER_CLIP_SECONDS. Duplicated here
// since a plugin can't import files outside its own directory (see the
// path-traversal guard in src/main/plugins/protocol.js) — keep in sync with
// core if that value ever changes.
export const MAX_BUFFER_CLIP_SECONDS = 600

// Per-preset sound overrides (planned 2026-09-12, "presets as primary
// context"): mirrors src/shared/constants.js's OVERRIDABLE_SOUND_KEYS/
// applySoundOverride exactly - same cross-directory duplication reason as
// MAX_BUFFER_CLIP_SECONDS above. Keep in sync with core if that set ever
// changes.
export const OVERRIDABLE_SOUND_KEYS = ['loopStart', 'loopEnd', 'filters', 'crossfadeSeconds', 'speedPitch', 'playMode', 'scatter', 'schedule']

export function applySoundOverride(entry, override) {
  if (!override) return entry
  const patch = {}
  for (const key of OVERRIDABLE_SOUND_KEYS) {
    if (override[key] !== undefined) patch[key] = override[key]
  }
  return { ...entry, ...patch }
}

// Mirrors src/main/ffmpeg/loopClip.js's DEFAULT_CROSSFADE_SECONDS (0.2s),
// in ms since the slider works in ms - same cross-directory duplication
// reason as MAX_BUFFER_CLIP_SECONDS above. Shown on the crossfade slider for
// any sound that's never had it explicitly overridden (entry.
// crossfadeSeconds is null).
export const DEFAULT_CROSSFADE_MS = 200

// "Listen to the seam": how much plays before the crossfade and after it.
export const SEAM_LEAD_SECONDS = 2.5

export const SEAM_TAIL_SECONDS = 2.5

// Undo/Redo: how long to wait after the last change before recording a
// history point, and how many points to keep. A live drag or a rapid burst
// of wheel/keyboard nudges keeps resetting this timer, so only the settled
// end state gets recorded - not every intermediate frame - matching how a
// text editor's own undo groups fast typing into one step rather than one
// per keystroke.
export const HISTORY_COMMIT_DEBOUNCE_MS = 500

export const HISTORY_LIMIT = 100

// Autosave (v0.1.142): how long to sit idle after the last edit before
// auto-saving/re-baking. Debounced-idle, not a fixed interval - the owner's
// own inbox note offered both shapes ("interval-based, user-set, or
// debounced... wait a few idle moments"); debounce was picked because a
// fixed interval would either bake mid-drag (wasted renders, audible preview
// hiccups if that render's output is ever touched) or leave a long dead gap
// right after the user stops editing - exactly the moment Saved-audio
// preview should become available again. Longer than HISTORY_COMMIT_DEBOUNCE_MS
// since this triggers a real ffmpeg render, not a cheap in-memory snapshot.
export const AUTOSAVE_IDLE_MS = 3000

// Mirrors library.js's defaultEqBands() exactly - a fresh/reset EQ starts
// with zero bands now (user-managed via the graph's own +/trash controls),
// not a fixed preset. Same cross-directory duplication reason as
// MAX_BUFFER_CLIP_SECONDS above. A fresh function call each time, never a
// shared array, since callers mutate the objects they get back (the EQ
// editor controller clones on load() too, but this is cheap insurance).
export function defaultEqBands() {
  return []
}

// Mirrors library.js's defaultVolumeEnvelope() exactly - same cross-directory
// duplication reason as defaultEqBands() above. A fresh function call each
// time (never a shared array/object), since callers mutate what they get
// back - LoopEditor's own setEnvelope()/getEnvelope() clone on load too,
// same defensive-copy convention as the EQ editor's bands array.
export function defaultVolumeEnvelope() {
  return {
    enabled: false,
    points: [
      { position: 0, gain: 1 },
      { position: 1, gain: 1 }
    ]
  }
}

export const NEUTRAL_FILTERS = { highpassHz: 0, lowpassHz: 20000, gainDb: 0, pan: 0, gateThresholdDb: -80, gateRangeDb: 0, gateAttackMs: 10, gateReleaseMs: 150, denoiseEnabled: false, denoiseStrengthDb: 12, denoiseSampleStartSec: 0, denoiseSampleEndSec: 0, echoDelayMs: 0, echoDecay: 0, reverbSizeMs: 0, reverbMix: 0, eq: defaultEqBands(), volumeEnvelope: defaultVolumeEnvelope() }

// Mirrors library.js's defaultFluctuation() - same cross-directory
// duplication reason as MAX_BUFFER_CLIP_SECONDS. volume rides 0..1
// (attenuation only, never boosts past the sound's set level); pitch is a
// semitone offset. Both axes off by default.
export const FLUC_VOL_MIN = 0

export const FLUC_VOL_MAX = 1

export const FLUC_PITCH_MIN = -6

export const FLUC_PITCH_MAX = 6

// Pan drift (v0.1.217): -1 (left) .. 1 (right).
export const FLUC_PAN_MIN = -1

export const FLUC_PAN_MAX = 1

export const PAN_DRIFT_DEFAULTS = { min: -0.5, bias: 0, max: 0.5 }

export function formatPan(v) {
  const r = Math.round(v * 100)
  return r === 0 ? 'C' : `${r < 0 ? 'L' : 'R'}${Math.abs(r)}`
}

// v0.1.176: timing is flat seconds the user reads directly (changeMinSeconds
// / changeMaxSeconds = the random gap before a new target is picked;
// transitionSeconds = how long the glide there takes). fullyRandom bypasses
// the 3 circles and roams the whole axis. Pre-v0.1.176 saves with
// changeRate/transition (0..1) are migrated by normalizeFluctuationAxis.
export const FLUC_DEFAULT_TIMING = { changeMinSeconds: 6, changeMaxSeconds: 14, transitionSeconds: 8 }

export function defaultFluctuation() {
  return {
    volume: { enabled: false, fullyRandom: false, min: 0.5, max: 1, bias: 0.8, ...FLUC_DEFAULT_TIMING },
    pitch: { enabled: false, fullyRandom: false, min: -1, max: 1, bias: 0, ...FLUC_DEFAULT_TIMING },
    pan: { enabled: false, fullyRandom: false, ...PAN_DRIFT_DEFAULTS, ...FLUC_DEFAULT_TIMING }
  }
}

// Curated highpass/lowpass/gain/echo combos for the one-click preset
// buttons. "Underwater" needs the lowpass slider's range extended below its
// old 500Hz floor (see the HTML below) to sound convincing; everything else
// fits the controls' original range.
//
// "Echo" uses echoDelayMs/echoDecay (a feedback delay line - clear, separated
// slapback repeats). "Reverb" used to be just a short-delay/high-decay
// approximation of the same knobs, since this ffmpeg build has no dedicated
// `reverb` filter - it's now real convolution reverb (reverbSizeMs/
// reverbMix, a synthetic impulse response via afir/ConvolverNode - see
// reverbIR.js), owner-requested ("if you need to write a better way to work
// with echo and delay you should absolutely do it"). Echo and Reverb are
// independent, stackable effects now, not two presets sharing one engine.
export const FILTER_PRESETS = {
  muffled: { label: 'Muffled', highpassHz: 0, lowpassHz: 700, gainDb: 0, echoDelayMs: 0, echoDecay: 0 },
  phone: { label: 'Over the Phone', highpassHz: 300, lowpassHz: 3400, gainDb: 0, echoDelayMs: 0, echoDecay: 0 },
  radio: { label: 'On the Radio', highpassHz: 150, lowpassHz: 6000, gainDb: 0, echoDelayMs: 0, echoDecay: 0 },
  distant: { label: 'Distant', highpassHz: 0, lowpassHz: 2500, gainDb: -8, echoDelayMs: 0, echoDecay: 0 },
  underwater: { label: 'Underwater', highpassHz: 0, lowpassHz: 250, gainDb: -3, echoDelayMs: 0, echoDecay: 0 },
  echo: { label: 'Echo', highpassHz: 0, lowpassHz: 20000, gainDb: 0, echoDelayMs: 350, echoDecay: 0.4 },
  reverb: { label: 'Reverb', highpassHz: 0, lowpassHz: 20000, gainDb: 0, echoDelayMs: 0, echoDecay: 0, reverbSizeMs: 1500, reverbMix: 0.35 }
}

// --- Preset mode / Group mode (v0.1.147) ---
// Bundled into this same plugin/tab per direct feedback ("I want preset
// remix to work exactly as a copy of the remix tab" / "streamline the remix
// experience to the remix tab... a way to change modes... between sounds,
// presets and groups") - previously two separate plugins (this one, and
// `plugins/preset-remix/`, now deleted). The three modes share this file's
// sticky bar / autosave-adjacent Save pattern and this EQ canvas look, but
// deliberately don't share Sound mode's waveform/trim/live-preview machinery
// - a preset or group is several sounds playing at once, with no single
// file to scrub, so "exact" parity stops at the parts that structurally
// apply to more than one sound (filters + EQ), matching the owner's own
// follow-up scoping ("waveform and single audio file controls should only
// show up on the single sound mode... if you're not on sound mode only the
// eq modules should show up").
export const NEUTRAL_WHOLE_MIX = { highpassHz: 0, lowpassHz: 20000, gainDb: 0, fadeInSeconds: 0, echoDelayMs: 0, echoDecay: 0, eq: [] }

// A group's own filters (see AudioEngine.js's SoundGroupChain) are the same
// shape as the whole-mix's, minus fadeInSeconds - a group has no "on load"
// moment of its own to fade in on. `occlusion` (v0.1.182) is group-only -
// see src/shared/constants.js's applyOcclusionToFilters (duplicated here
// only as this plain default, per this plugin's own can't-import-outside-
// its-directory rule; the actual formula lives in that one shared place).
export const NEUTRAL_GROUP_FILTERS = { highpassHz: 0, lowpassHz: 20000, gainDb: 0, echoDelayMs: 0, echoDecay: 0, occlusion: 0, eq: [] }

// Shared by both the whole-mix (Preset mode) and group (Group mode) filter
// shapes below - self-review v0.1.149: these were originally two byte-for-
// byte-identical trios (clone/canonicalize/equal) differing only in whether
// fadeInSeconds is part of the shape, which meant the entire EQ-band
// normalization block was duplicated too. One parameterized set instead, so
// a future EQ-band field addition (this file already has direct history of
// exactly this bug class - the v0.1.91 Doppler/v0.1.135 speed-range
// "flattened field list, edit by hand" misses) only has one place to update.
// Fluctuation (v0.1.166) on a whole-mix / group bus - volume drift only
// (no pitch axis: a bus is a sum of sources, nothing to detune). Always
// held as an object in the plugin's working state ({ volume: {...} }, with
// enabled defaulting false) so the dirty-check and write path don't have to
// special-case null; presets.js collapses a disabled one back to null on
// save. Deep-copied by cloneMixFilters the same way `eq` is, so editing
// this.wholeMixCurrent.fluctuation never mutates the shared neutral/saved.
// v0.1.217: a Sound Group also has a pan axis (the whole group wandering
// left/right); the whole mix keeps volume only (presets.js drops pan there).
export function defaultMixFluctuation() {
  return {
    volume: { enabled: false, fullyRandom: false, biasEnabled: true, perSound: false, min: 0.5, max: 1, bias: 0.8, ...FLUC_DEFAULT_TIMING },
    // v0.1.218: pitch only ever works "each sound on its own" on a group.
    pitch: { enabled: false, fullyRandom: false, biasEnabled: true, perSound: true, min: -1, max: 1, bias: 0, ...FLUC_DEFAULT_TIMING },
    pan: { enabled: false, fullyRandom: false, biasEnabled: true, perSound: false, ...PAN_DRIFT_DEFAULTS, ...FLUC_DEFAULT_TIMING }
  }
}

export function cloneMixFluctuation(f) {
  // No saved fluctuation → start the bar/sliders at a sensible spread (not
  // all three handles collapsed at 1), same as Sound mode's defaultFluctuation.
  const d = defaultMixFluctuation()
  const axis = (name, neutral) => {
    const src = f?.[name] ?? d[name]
    return { ...d[name], ...normalizeFluctuationAxis(src, neutral), perSound: name === 'pitch' || Boolean(src.perSound) }
  }
  return { volume: axis('volume', 1), pitch: axis('pitch', 0), pan: axis('pan', 0) }
}

export function cloneMixFilters(obj, neutral) {
  return {
    ...neutral,
    ...(obj ?? {}),
    eq: (obj?.eq ?? []).map((b) => ({ ...b })),
    fluctuation: cloneMixFluctuation(obj?.fluctuation)
  }
}

// The flat-seconds timing row shared by every Fluctuation axis (Sound mode's
// volume + pitch, Preset/Group mode's volume) - v0.1.176. `idp` is the
// per-axis id prefix ('editor-fluc-vol', 'editor-mix-preset-fluc', ...); the
// controls are <idp>-changemin / -changemax / -transition (number inputs, in
// seconds) and <idp>-fullrandom (checkbox).
// A fluctuation seconds field - positive finite, else the fallback.
// `allowZero` is for Transition only, where 0 is a valid, meaningful value
// (instant/no glide) rather than an invalid one to fall back away from. A
// blank field must still fall back rather than read as 0 - Number('') is 0,
// so that check comes before the Number() coercion, not after it.
export function flucSeconds(raw, fallback, allowZero = false) {
  if (typeof raw === 'string' && raw.trim() === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n)) return fallback
  return (allowZero ? n >= 0 : n > 0) ? n : fallback
}

export function formatSemitones(v) {
  const r = Math.round(v * 10) / 10
  return `${r > 0 ? '+' : ''}${r} st`
}

// Per-play random axes: bar range + reset defaults + config field names
// (mirrors src/shared/groupDrift.js's SHOT_AXIS_FIELDS).
export const SHOT_AXES = {
  pitch: { lo: -12, hi: 12, defaults: { min: 0, bias: 0, max: 0 }, format: formatSemitones, round: 10, fields: ['minPitchSemitones', 'maxPitchSemitones', 'pitchBiasSemitones', 'pitchBiasEnabled', 'pitchFullyRandom'] },
  volume: { lo: 0, hi: 1, defaults: { min: 1, bias: 1, max: 1 }, format: (v) => `${Math.round(v * 100)}%`, round: 100, fields: ['minVolume', 'maxVolume', 'volumeBias', 'volumeBiasEnabled', 'volumeFullyRandom'] },
  pan: { lo: -1, hi: 1, defaults: { min: 0, bias: 0, max: 0 }, format: formatPan, round: 100, fields: ['minPan', 'maxPan', 'panBias', 'panBiasEnabled', 'panFullyRandom'] },
  // v0.1.227: Speed joined the bars (it used to be two min/max sliders).
  speed: { lo: 0.5, hi: 2, defaults: { min: 1, bias: 1, max: 1 }, format: (v) => `${Math.round(v * 100)}%`, round: 100, fields: ['minSpeed', 'maxSpeed', 'speedBias', 'speedBiasEnabled', 'speedFullyRandom'] }
}

// What the bar shows for a missing bias: the middle of the range, rounded
// the way readShotAxes rounds it (v0.1.227 - the snapshot used to assume
// 0/1, so loading such a sound read as an unsaved edit and auto-saved).
export function shotBiasDefault(bias, min, max, round) {
  if (bias != null) return bias
  return Math.round(((min + max) / 2) * round) / round
}

export const SHOT_AXIS_NAMES = ['pitch', 'volume', 'pan', 'speed']

// Order-insensitive value compare - the EQ editor and the persisted store
// build band objects with different key orders, so a plain JSON.stringify
// would report a false "dirty" after an edit that lands back on the saved
// values.
export function canonicalMixFilters(obj, { includeFadeIn }) {
  const o = obj ?? {}
  return JSON.stringify({
    highpassHz: Number(o.highpassHz) || 0,
    lowpassHz: Number(o.lowpassHz ?? 20000),
    gainDb: Number(o.gainDb) || 0,
    echoDelayMs: Number(o.echoDelayMs) || 0,
    echoDecay: Number(o.echoDecay) || 0,
    // BUG FIX (v0.1.182): reverbSizeMs/reverbMix were missing from this
    // fingerprint entirely, so a Preset/Group-mode edit that touched only
    // Reverb never marked the panel dirty and the Save button never lit -
    // the edit was silently lost the moment you navigated away. occlusion
    // is new here, group-only (always 0 on a whole-mix object, harmless).
    reverbSizeMs: Number(o.reverbSizeMs) || 0,
    reverbMix: Number(o.reverbMix) || 0,
    occlusion: Number(o.occlusion) || 0,
    ...(includeFadeIn ? { fadeInSeconds: Number(o.fadeInSeconds) || 0 } : {}),
    fluctuation: (() => {
      const axis = (a, neutral) => {
        if (!a?.enabled) return null
        const n = normalizeFluctuationAxis(a, neutral)
        return {
          fullyRandom: n.fullyRandom,
          biasEnabled: n.biasEnabled,
          perSound: Boolean(a.perSound),
          min: n.min,
          max: n.max,
          bias: n.bias,
          changeMinSeconds: n.changeMinSeconds,
          changeMaxSeconds: n.changeMaxSeconds,
          transitionSeconds: n.transitionSeconds
        }
      }
      const volume = axis(o.fluctuation?.volume, 1)
      const pan = axis(o.fluctuation?.pan, 0)
      const pitch = axis(o.fluctuation?.pitch && { ...o.fluctuation.pitch, perSound: true }, 0)
      return volume || pan || pitch ? { volume, pitch, pan } : null
    })(),
    eq: (o.eq ?? []).map((b) => ({
      freqHz: Math.round(Number(b.freqHz) || 0),
      gainDb: Number(b.gainDb) || 0,
      q: Number(b.q) || 1,
      type: b.type ?? 'peaking',
      slope: b.slope === 'steep' ? 'steep' : 'gentle',
      muted: Boolean(b.muted)
    }))
  })
}

export function cloneWholeMix(mix) {
  return cloneMixFilters(mix, NEUTRAL_WHOLE_MIX)
}

export function wholeMixEqual(a, b) {
  return canonicalMixFilters(a, { includeFadeIn: true }) === canonicalMixFilters(b, { includeFadeIn: true })
}

export function cloneGroupFilters(filters) {
  return cloneMixFilters(filters, NEUTRAL_GROUP_FILTERS)
}

export function groupFiltersEqual(a, b) {
  return canonicalMixFilters(a, { includeFadeIn: false }) === canonicalMixFilters(b, { includeFadeIn: false })
}
