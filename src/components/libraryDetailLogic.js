// Pure rules behind LibraryDetail.jsx (kept apart so unit tests can import
// them without React): the row classes, the Play and Loop button states and
// the fader's paint and keys.
import { soundKey } from '../domain/itemPreview.js'

export const KIND_TXT = { loop: 'natural loop', random: 'random one-shot', scheduled: 'scheduled one-shot' }

export const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export function memberRowClass(m, status) {
  return 'rx-mrow' + (m.inMix ? '' : ' rx-mrow-off') + (status.soloedId === m.id ? ' rx-mrow-solo' : '') + (status.previewKey === soundKey(m.id) ? ' rx-mrow-playing' : '')
}

// Play previews the item; the same button stops it.
export function playState(key, name, what, status) {
  const playing = status.previewKey === key
  return { playing, label: (playing ? 'Stop ' : 'Play ') + name, title: playing ? 'Stop ' + name : 'Play ' + name + what }
}

// A one-shot loops on demand; a natural loop always loops (button disabled).
export function loopState(id, name, status) {
  const kind = status.kinds?.[id] ?? 'loop'
  if (kind === 'loop') return { disabled: true, pressed: null, label: 'Loop (always on for a natural loop)', title: name + ' is a natural loop: it always loops' }
  const on = (status.loops ?? []).includes(id)
  return { disabled: false, pressed: on, label: 'Loop ' + name, title: 'Loop: keep repeating ' + name + ' as it does in the mix (' + KIND_TXT[kind] + ')' }
}

export function soloTitle(m, status) {
  if (!m.inMix) return "Not in this preset's mix"
  return !status.live ? 'Solo: loads this preset in the Mixer, then plays only this one (preview only, never saved)' : 'Solo: hear only this one while the preset plays (preview only, never saved)'
}

export function memberNameTitle(m, status) {
  return m.inMix ? `${m.name} · ${KIND_TXT[status.kinds?.[m.id] ?? 'loop']}` : `${m.name} (not in this preset's mix)`
}

// Volume fills from the left; pan from the center. v is 0..1.
export function faderPaint(v, pan) {
  const p = v * 100
  return { fill: pan ? `left:${Math.min(50, p)}%;width:${Math.abs(p - 50)}%` : `left:0;width:${p}%`, knob: p, now: Math.round(p) }
}

export const clamp01 = (v) => Math.min(1, Math.max(0, v))

// The value a key press moves a fader to, or null when the key is not one.
export function faderKeyValue(v, key, shift) {
  const step = shift ? 0.1 : 0.02
  const keys = { ArrowLeft: -step, ArrowDown: -step, ArrowRight: step, ArrowUp: step }
  if (keys[key] != null) return clamp01(v + keys[key])
  if (key === 'Home') return 0
  if (key === 'End') return 1
  return null
}
