// The library's drill-in view (approved mock mock-noctivago-remix-detail,
// placement C, owner 2026-11-12): picking a group or a preset replaces the
// list with its contents. The panel header reads like a library row (type
// tile, name, what it is) and carries the back arrow. Data comes from
// domain/detailPanel.js; every write goes through the handlers.
import { icon } from './icons.js'
import { formatGain, formatPan, gainToFader, faderToGain } from '../domain/detailPanel.js'

const ICON = { group: 'layers', preset: 'bookmark', sound: 'audio-waveform' }

function el(doc, tag, cls, html) {
  const n = doc.createElement(tag)
  if (cls) n.className = cls
  if (html != null) n.innerHTML = html
  return n
}

function iconButton(doc, name, label, onClick) {
  const b = el(doc, 'button', 'rx-i rx-dib', icon(name))
  b.type = 'button'
  b.title = label
  b.setAttribute('aria-label', label)
  b.addEventListener('click', onClick)
  return b
}

function header(doc, { kind, name, meta, back }) {
  const h = el(doc, 'div', 'rx-det-h' + (back ? ' rx-det-hb' : ''))
  if (back) h.appendChild(iconButton(doc, 'arrow-left', back.label, back.onClick))
  h.appendChild(el(doc, 'span', 'rx-thumb', icon(ICON[kind])))
  const t = el(doc, 'div', 'rx-det-t', '<b></b><div class="rx-det-kind"></div>')
  t.querySelector('b').textContent = name
  t.querySelector('b').title = name
  t.querySelector('.rx-det-kind').textContent = meta
  h.appendChild(t)
  return h
}

// A horizontal fader, 0..1. Volume fills from the left; pan from the center.
// Drag or arrow keys move it (onInput while moving, onCommit once at the
// end); double-click resets volume to 100% and pan to center.
function fader(doc, { value, pan = false, label, onInput, onCommit, onDragState }) {
  const f = el(doc, 'div', 'rx-fader' + (pan ? ' rx-fader-pan' : ''), '<i class="rx-ftr"></i><i class="rx-ffl"></i><i class="rx-fkn"></i>')
  f.tabIndex = 0
  f.setAttribute('role', 'slider')
  f.setAttribute('aria-label', label)
  f.setAttribute('aria-valuemin', '0')
  f.setAttribute('aria-valuemax', '100')
  let v = value
  const paint = () => {
    const p = v * 100
    f.querySelector('.rx-ffl').style.cssText = pan ? `left:${Math.min(50, p)}%;width:${Math.abs(p - 50)}%` : `left:0;width:${p}%`
    f.querySelector('.rx-fkn').style.left = `${p}%`
    f.setAttribute('aria-valuenow', String(Math.round(p)))
  }
  const set = (next, commit) => {
    v = Math.min(1, Math.max(0, next))
    paint()
    onInput?.(v)
    if (commit) onCommit?.(v)
  }
  paint()
  f.addEventListener('pointerdown', (evt) => {
    if (evt.button !== 0) return
    const at = (e) => {
      const r = f.getBoundingClientRect()
      return r.width ? (e.clientX - r.left) / r.width : v
    }
    f.setPointerCapture(evt.pointerId)
    onDragState?.(true)
    set(at(evt), false)
    const move = (e) => set(at(e), false)
    const up = () => {
      f.removeEventListener('pointermove', move)
      f.removeEventListener('pointerup', up)
      f.removeEventListener('pointercancel', up)
      onDragState?.(false)
      onCommit?.(v)
    }
    f.addEventListener('pointermove', move)
    f.addEventListener('pointerup', up)
    f.addEventListener('pointercancel', up)
  })
  f.addEventListener('dblclick', () => set(pan ? 0.5 : 1, true))
  f.addEventListener('keydown', (evt) => {
    const step = evt.shiftKey ? 0.1 : 0.02
    const keys = { ArrowLeft: -step, ArrowDown: -step, ArrowRight: step, ArrowUp: step }
    if (keys[evt.key] != null) {
      evt.preventDefault()
      set(v + keys[evt.key], true)
    } else if (evt.key === 'Home' || evt.key === 'End') {
      evt.preventDefault()
      set(evt.key === 'Home' ? 0 : 1, true)
    }
  })
  return f
}

function emptyNote(doc, title, text) {
  const n = el(doc, 'div', 'rx-det-empty', title ? '<b></b><span></span>' : '<span></span>')
  if (title) n.querySelector('b').textContent = title
  n.querySelector('span').textContent = text
  return n
}

// One member per two lines (approved mock, 2026-11-13): play/stop, the name,
// S (Solo, preview only) and the arrow on the first; the volume fader and its
// value under the name. Play previews that one sound from the library;
// S needs the preset loaded in the Mixer and the sound in its mix.
function memberRows(doc, group, h, status = {}) {
  if (!group.members.length) return emptyNote(doc, 'No sounds in this group yet', "Add sounds to it from a card's menu in the Mixer.")
  const rows = el(doc, 'div', 'rx-det-rows')
  for (const m of group.members) rows.appendChild(soundRow(doc, m, h, status))
  return rows
}

// One sound's two-line row. arrow overrides the default "Edit in Sound mode"
// (Preset mode opens the sound's own panel instead).
function soundRow(doc, m, h, status, arrow = null) {
  {
    const soloed = status.soloedId === m.id
    const r = el(doc, 'div', 'rx-mrow' + (m.inMix ? '' : ' rx-mrow-off') + (soloed ? ' rx-mrow-solo' : '') + (status.previewId === m.id ? ' rx-mrow-playing' : ''))
    if (!m.missing) {
      const playing = status.previewId === m.id
      const pv = iconButton(doc, playing ? 'square' : 'play', playing ? 'Stop ' + m.name : 'Play ' + m.name, () => h.preview(m.id))
      pv.classList.add('rx-mpv')
      r.appendChild(pv)
    } else r.appendChild(el(doc, 'span'))
    const nm = el(doc, 'span', 'rx-mnm')
    nm.textContent = m.name
    nm.title = m.inMix ? m.name : `${m.name} (not in this preset's mix)`
    const val = el(doc, 'span', 'rx-mval')
    val.textContent = m.inMix ? formatGain(m.gain) : 'off'
    r.appendChild(nm)
    const so = el(doc, 'button', 'rx-mso', 'S')
    so.type = 'button'
    so.setAttribute('aria-pressed', String(soloed))
    so.setAttribute('aria-label', 'Solo ' + m.name)
    so.title = !m.inMix ? "Not in this preset's mix" : !status.live ? 'Solo: loads this preset in the Mixer, then plays only this one (preview only, never saved)' : 'Solo: hear only this one while the preset plays (preview only, never saved)'
    so.disabled = !m.inMix || Boolean(m.missing)
    so.addEventListener('click', () => h.solo(m.id, !soloed))
    r.appendChild(so)
    if (m.missing) r.appendChild(el(doc, 'span'))
    else {
      const go = arrow
        ? iconButton(doc, 'arrow-right', arrow.label.replace('%s', m.name), () => arrow.onClick(m.id))
        : iconButton(doc, 'arrow-right', 'Edit ' + m.name + ' in Sound mode', () => h.editSound(m.id))
      go.title = arrow ? arrow.title : 'Edit in Sound mode'
      r.appendChild(go)
    }
    const mf = el(doc, 'div', 'rx-mf')
    if (m.inMix) {
      mf.appendChild(
        fader(doc, {
          value: gainToFader(m.gain),
          label: `${m.name} volume`,
          onInput: (p) => {
            val.textContent = formatGain(faderToGain(p))
            h.setVolume(m.id, faderToGain(p), false)
          },
          onCommit: (p) => h.setVolume(m.id, faderToGain(p), true),
          onDragState: h.dragging
        })
      )
    } else mf.appendChild(el(doc, 'span', 'rx-fader-none'))
    mf.appendChild(val)
    r.appendChild(mf)
    return r
  }
}

function goButton(doc, kind, text, onClick) {
  const b = el(doc, 'button', 'rx-b rx-det-go', `${icon(ICON[kind])}<span></span>`)
  b.type = 'button'
  b.querySelector('span').textContent = text
  b.addEventListener('click', onClick)
  return b
}

function groupPanel(doc, group, parent, h, status) {
  const frag = doc.createDocumentFragment()
  frag.appendChild(
    header(doc, {
      kind: 'group',
      name: group.name,
      meta: parent ? `Group in ${parent}` : group.meta,
      back: parent ? { label: `Back to ${parent}`, onClick: h.back } : { label: 'Back to all groups', onClick: h.up }
    })
  )
  frag.appendChild(memberRows(doc, group, h, status))
  if (parent) frag.appendChild(goButton(doc, 'group', 'Edit in Group mode', () => h.editGroup(group.id)))
  return frag
}

function control(doc, label, faderEl, valEl) {
  const c = el(doc, 'div', 'rx-ctl')
  const l = el(doc, 'span')
  l.textContent = label
  c.append(l, faderEl, valEl)
  return c
}

function soundPanel(doc, sound, parent, h, status) {
  const frag = doc.createDocumentFragment()
  frag.appendChild(header(doc, { kind: 'sound', name: sound.name, meta: `Sound in ${parent}`, back: { label: `Back to ${parent}`, onClick: h.back } }))
  const vv = el(doc, 'span', 'rx-mval')
  vv.textContent = formatGain(sound.gain)
  frag.appendChild(
    control(
      doc,
      'Volume',
      fader(doc, {
        value: gainToFader(sound.gain),
        label: 'Volume',
        onInput: (p) => {
          vv.textContent = formatGain(faderToGain(p))
          h.setVolume(sound.id, faderToGain(p), false)
        },
        onCommit: (p) => h.setVolume(sound.id, faderToGain(p), true),
        onDragState: h.dragging
      }),
      vv
    )
  )
  const pv = el(doc, 'span', 'rx-mval')
  pv.textContent = formatPan(sound.pan)
  frag.appendChild(
    control(
      doc,
      'Pan',
      fader(doc, {
        value: (sound.pan + 1) / 2,
        pan: true,
        label: 'Pan',
        onInput: (p) => {
          pv.textContent = formatPan(p * 2 - 1)
        },
        onCommit: (p) => h.setPan(sound.id, Math.round((p * 2 - 1) * 100) / 100),
        onDragState: h.dragging
      }),
      pv
    )
  )
  // Mute and Solo act on the Mixer's live mix, so they need this preset to
  // be the one loaded there.
  const pair = el(doc, 'div', 'rx-det-pair')
  const playing = status.previewId === sound.id
  const play = el(doc, 'button', 'rx-b rx-ghost', `${icon(playing ? 'square' : 'play')}<span>${playing ? 'Stop' : 'Play'}</span>`)
  play.type = 'button'
  play.title = 'Hear this sound alone, from the library'
  play.addEventListener('click', () => h.preview(sound.id))
  const live = status.live
  const mute = el(doc, 'button', 'rx-b rx-ghost', `${icon('volume-x')}<span>Mute</span>`)
  mute.type = 'button'
  mute.setAttribute('aria-pressed', String(status.muted))
  const solo = el(doc, 'button', 'rx-b rx-ghost', '<span class="rx-det-s">S</span><span>Solo</span>')
  solo.type = 'button'
  solo.setAttribute('aria-pressed', String(status.soloed))
  for (const b of [mute, solo]) {
    b.disabled = b === mute && (!live || !status.canMute)
    if (b === mute && !live) b.title = 'Load this preset in the Mixer first'
    else if (b === mute && !status.canMute) b.title = 'Update Noctívago to mute from here'
    else if (b === solo && !live) b.title = 'Loads this preset in the Mixer, then plays only this one (preview only, never saved)'
  }
  mute.addEventListener('click', () => h.mute(sound.id))
  solo.addEventListener('click', () => h.solo(sound.id, !status.soloed))
  pair.append(play, mute, solo)
  frag.appendChild(pair)
  frag.appendChild(goButton(doc, 'sound', 'Edit in Sound mode', () => h.editSound(sound.id)))
  return frag
}

function subRow(doc, kind, name, meta, onClick) {
  const b = el(doc, 'button', 'rx-grow', `<span class="rx-thumb">${icon(ICON[kind])}</span><span class="rx-gtxt"><span class="rx-gnm"></span><small></small></span>${icon('chevron-right')}`)
  b.type = 'button'
  b.title = name
  b.querySelector('.rx-gnm').textContent = name
  b.querySelector('small').textContent = `· ${meta}`
  b.addEventListener('click', onClick)
  return b
}

function section(doc, label, count) {
  const s = el(doc, 'div', 'rx-det-sec', '<span></span><span></span>')
  s.firstChild.textContent = label
  s.lastChild.textContent = String(count)
  return s
}

function presetPanel(doc, preset, h, status = {}) {
  const frag = doc.createDocumentFragment()
  frag.appendChild(header(doc, { kind: 'preset', name: preset.name, meta: preset.meta, back: { label: 'Back to all presets', onClick: h.up } }))
  if (preset.empty) {
    frag.appendChild(emptyNote(doc, 'This preset is empty', 'Turn sounds on in the Mixer while it is loaded.'))
    return frag
  }
  const rows = el(doc, 'div', 'rx-det-rows')
  if (preset.groups.length) {
    rows.appendChild(section(doc, 'Groups', preset.groups.length))
    for (const g of preset.groups) rows.appendChild(subRow(doc, 'group', g.name, `${g.count} sound${g.count === 1 ? '' : 's'}`, () => h.openSub('group', g.id)))
  }
  rows.appendChild(section(doc, 'Sounds outside groups', preset.sounds.length))
  const arrow = { label: 'Open %s', title: 'Open this sound', onClick: (id) => h.openSub('sound', id) }
  if (preset.sounds.length) for (const s of preset.sounds) rows.appendChild(soundRow(doc, { id: s.id, name: s.name, gain: s.gain, inMix: true, missing: Boolean(s.missing) }, h, status, arrow))
  else rows.appendChild(emptyNote(doc, null, 'Every sound here is in a group.'))
  frag.appendChild(rows)
  return frag
}

// view: { top, sub, parentName, status } (see buildStudio). Returns false
// when there is nothing to drill into, so the caller shows the list.
export function renderDetail(host, view, h) {
  const doc = host.ownerDocument
  const { top, sub } = view
  if (!top) return false
  const wrap = el(doc, 'div', 'rx-drill')
  if (top.kind === 'group') wrap.appendChild(groupPanel(doc, top, null, h, view.status))
  else if (sub?.kind === 'group') wrap.appendChild(groupPanel(doc, sub, top.name, h, view.status))
  else if (sub?.kind === 'sound') wrap.appendChild(soundPanel(doc, sub, top.name, h, view.status))
  else wrap.appendChild(presetPanel(doc, top, h, view.status))
  host.replaceChildren(wrap)
  return true
}
