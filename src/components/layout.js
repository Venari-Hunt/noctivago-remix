// Desktop 2.0 layout for the Remix tab: one screen, the big view on the left,
// folded settings on the right, one bar on top. mount() and mountSticky()
// still build the controls; this file only wraps and moves those nodes, so
// every id and every listener stays as it was.
//
// Folding never uses the `hidden` class: the tab's own code toggles `hidden`
// on sections by play mode, and the two would fight. Accordions fold with
// data-open, canvas views with data-view on the panel.
import { icon } from './icons.js'
import { attachKnob } from './Knob.js'
import { filterSummaries } from './filterSummary.js'
import { renderDetail } from './libraryDetail.js'

const el = (doc, tag, className, html) => {
  const node = doc.createElement(tag)
  if (className) node.className = className
  if (html != null) node.innerHTML = html
  return node
}

// Canvases here redraw on the window's resize event; a folded or resized
// column changes their box without one. One coalesced event covers them all.
function requestRedraw(win) {
  if (win.__rxRedrawQueued) return
  win.__rxRedrawQueued = true
  win.requestAnimationFrame(() => {
    win.__rxRedrawQueued = false
    win.dispatchEvent(new Event('resize'))
  })
}

// The side column holds settings only; anything with a big drawing (EQ graph,
// spectrogram) is a canvas view on the left, as in the approved mock.
const ACCORDIONS = [
  ['playback', 'Playback'],
  ['envelope', 'Volume envelope'],
  ['speed', 'Speed and pitch'],
  ['tone', 'Tone'],
  ['eq', 'Parametric EQ'],
  ['clean', 'Cleanup'],
  ['space', 'Space'],
  ['drift-vol', 'Volume drift'],
  ['drift-pitch', 'Pitch drift'],
  ['drift-pan', 'Pan drift'],
  ['looks', 'Effect presets']
]

// A checkbox label becomes the look's settings row: title and a small line
// on the left, the switch on the right.
function toSwitchRow(doc, label, title, sub) {
  const input = label.querySelector('input')
  label.className = 'rx-srow'
  const text = el(doc, 'span', 'rx-sl')
  text.appendChild(el(doc, 'span', '', title))
  if (sub) text.appendChild(el(doc, 'small', '', sub))
  if (!input.getAttribute('aria-label')) input.setAttribute('aria-label', title)
  label.replaceChildren(text, input)
  return label
}

// Drift: each axis is a switch row that opens its range bar, timing and
// toggles (folded in CSS while the switch is off).
const DRIFT_AXES = [
  ['editor-fluc-vol', 'Volume drift', "Rides below the sound's set volume"],
  ['editor-fluc-pitch', 'Pitch drift', 'Small shifts read as a gentle wobble'],
  ['editor-fluc-pan', 'Pan drift', 'Wanders left and right from the Pan setting']
]
const SOUND_DRIFT_NOTE = 'Slow, random drift while the sound loops: wind gusting, rain swelling. Plays in Live edit here and always in the Mixer. Saves on its own.'
// Group and Preset drift (mock screens remix-group and remix-preset). The
// fourth item is the "Each sound on its own" line, group axes only.
const SCOPE_DRIFT = {
  group: {
    note: "Slow, random drift on this group's sounds. Applies live in the Mixer and is baked into exports.",
    axes: [
      ['editor-mix-group-fluc', 'Volume drift', 'Only ever dips below the current level', "Every sound drifts separately, so they don't move together"],
      ['editor-mix-group-flucpitch', 'Pitch drift', 'Small shifts read as a gentle wobble', 'Always on for pitch'],
      ['editor-mix-group-flucpan', 'Pan drift', 'The whole group wanders together', 'Every sound wanders separately']
    ]
  },
  preset: {
    note: 'Slow, random drift on the whole mix: weather rolling through. Applies live in the Mixer and is baked into exports.',
    axes: [['editor-mix-preset-fluc', 'Volume drift', 'Only ever dips below the current level']]
  }
}
function arrangeDrift(doc, section, axes = DRIFT_AXES, noteText = SOUND_DRIFT_NOTE) {
  const head = section.querySelector('.editor-fluctuation-head')
  const note = el(doc, 'p', 'rx-hint rx-hint-l', noteText)
  note.title = head.querySelector('.editor-fluctuation-hint').textContent.trim()
  head.replaceWith(note)
  for (const n of section.querySelectorAll(':scope > .editor-fluctuation-hint')) {
    n.classList.remove('editor-fluctuation-hint')
    n.classList.add('rx-hint', 'rx-hint-l')
  }
  for (const [idp, title, sub, perSoundSub] of axes) {
    const $ = (id) => section.querySelector(`#${idp}-${id}`)
    const axis = $('enabled').closest('.editor-fluctuation-axis')
    axis.className = 'rx-axis rx-drift-axis'
    const row = toSwitchRow(doc, $('enabled').closest('label'), title, sub)
    const body = el(doc, 'div', 'rx-axb')
    // Change every [6] to [14] s, Transition [8] s
    const changeRow = el(doc, 'div', 'rx-trow', '<span>Change every</span>')
    changeRow.append($('changemin'), el(doc, 'span', '', 'to'), $('changemax'), el(doc, 'span', '', 's'))
    const transitionRow = el(doc, 'div', 'rx-trow', '<span>Transition</span>')
    transitionRow.append($('transition'), el(doc, 'span', '', 's'))
    const fullRandom = toSwitchRow(doc, $('fullrandom').closest('label'), 'Fully random', 'Ignore the circles and roam the whole range')
    const bias = toSwitchRow(doc, $('bias').closest('label'), 'Bias', 'The middle circle wins most of the time')
    body.append($('bar'))
    if (perSoundSub && $('persound')) body.append(toSwitchRow(doc, $('persound').closest('label'), 'Each sound on its own', perSoundSub))
    body.append(changeRow, transitionRow, fullRandom, bias)
    axis.replaceChildren(row, body)
  }
}

// EQ tools under the graph, as in the mock: Add band, Delete band, Invert,
// zoom, Mute band, Solo band, then the selected band's fields. Sound, Group
// and Preset share the markup, only the id prefix differs. A/B and Reset are
// settings, so they are handed back for the side column.
function arrangeEqTools(eq, p) {
  const $ = (id) => eq.querySelector(`#${p}-${id}`)
  const header = eq.querySelector('.editor-eq-header')
  const compare = header.querySelector('.editor-eq-compare')
  compare.classList.add('rx-seg')
  const reset = $('reset')
  reset.className = 'rx-b rx-ghost'
  reset.textContent = 'Reset'
  reset.title = 'Remove every band'
  const set = (node, className, html, label) => {
    node.className = className
    node.innerHTML = html
    if (label) node.setAttribute('aria-label', label)
    return node
  }
  const add = set($('add-band'), 'rx-b', `${icon('plus')}<span>Add band</span>`)
  const del = set($('remove-band'), 'rx-b rx-ghost', `${icon('trash-2')}<span>Delete band</span>`)
  del.title = 'Delete the selected band, or drag a node here'
  const invert = set($('invert'), 'rx-b rx-ghost', '<span>Invert</span>')
  invert.title = 'Boosts become cuts and vice versa'
  const zoomOut = set($('zoom-out'), 'rx-i', icon('minus'), 'Zoom out')
  const zoomIn = set($('zoom-in'), 'rx-i', icon('plus'), 'Zoom in')
  // The tab toggles editor-eq-mute-active / editor-eq-solo-active on these.
  const mute = $('mute')
  const solo = $('solo')
  mute.classList.replace('editor-eq-toggle-btn', 'rx-b')
  solo.classList.replace('editor-eq-toggle-btn', 'rx-b')
  mute.classList.add('rx-ghost')
  solo.classList.add('rx-ghost')
  mute.textContent = 'Mute band'
  solo.textContent = 'Solo band'
  // Step 13b: Spectrum / Both / Heatmap, as in the mock (EqEditor wires it).
  const doc = eq.ownerDocument
  const spec = doc.createElement('div')
  spec.className = 'rx-seg'
  spec.setAttribute('role', 'group')
  spec.setAttribute('aria-label', 'Spectrum display')
  for (const [mode, label] of [['spectrum', 'Spectrum'], ['both', 'Both'], ['heat', 'Heatmap']]) {
    const b = doc.createElement('button')
    b.type = 'button'
    b.dataset.spec = mode
    b.textContent = label
    b.setAttribute('aria-pressed', String(mode === 'both'))
    spec.appendChild(b)
  }
  // Step 13c: which signal the spectrum reads, like Pro-Q's Pre / Post /
  // Pre+Post. After (what you hear) is the default; EqEditor wires it.
  const tap = doc.createElement('div')
  tap.className = 'rx-seg'
  tap.setAttribute('role', 'group')
  tap.setAttribute('aria-label', 'Spectrum signal')
  for (const [mode, label, title] of [['before', 'Before', 'Spectrum before the EQ'], ['after', 'After', 'Spectrum after the EQ (what you hear)'], ['both', 'Both', 'Before dimmed behind After']]) {
    const b = doc.createElement('button')
    b.type = 'button'
    b.dataset.tap = mode
    b.textContent = label
    b.title = title
    b.setAttribute('aria-pressed', String(mode === 'after'))
    tap.appendChild(b)
  }
  // Step 13d: the mock's tools row, left-aligned with hairline separators;
  // the two display switches sit together at the end (they wrap as a pair).
  header.className = 'rx-tools rx-eq-tools'
  const sep = () => el(doc, 'span', 'rx-sep')
  const segs = el(doc, 'span', 'rx-tools-end')
  segs.append(tap, spec)
  header.replaceChildren(add, del, invert, sep(), zoomOut, zoomIn, sep(), mute, solo, segs)
  // Rulers above the graph: SUB to TREBLE, then the C of each octave.
  const ruler = doc.createElement('canvas')
  ruler.className = 'rx-eq-ruler'
  ruler.setAttribute('aria-hidden', 'true')
  $('canvas').before(ruler)

  const fields = eq.querySelector('.editor-eq-band-controls, .editor-mix-eq-fields')
  fields.className = 'rx-under rx-eq-fields'
  // Fixed band slots (LYNX): numbered chips at the start of the fields row;
  // EqEditor finds the strip by its canvas id and draws the chips.
  const slots = el(doc, 'div', 'rx-eq-slots')
  slots.setAttribute('role', 'group')
  slots.setAttribute('aria-label', 'Band slots')
  slots.dataset.eqSlotsFor = `${p}-canvas`
  fields.prepend(slots)
  for (const label of fields.querySelectorAll('label')) {
    label.classList.add('rx-fl')
    label.querySelector('.editor-filter-value')?.remove() // "Hz", "dB": the mock's fields carry no unit
    label.querySelector('select, input')?.classList.add('rx-field')
  }
  const type = $('type')
  const peaking = type.querySelector('option[value="peaking"]')
  if (peaking) type.prepend(peaking) // the mock lists Peaking first
  eq.querySelector('.editor-eq-hint')?.classList.add('rx-hint')
  return { toolbar: header, fields, compare, reset }
}

// The settings column: one card per [key, title], the body nodes from
// bodies[key]. One card is open at a time.
function buildAccordions(side, list, bodies) {
  const doc = side.ownerDocument
  const win = doc.defaultView
  const accordions = new Map()
  side.appendChild(el(doc, 'h3', 'rx-side-h', 'Settings'))
  const openAccordion = (key) => {
    for (const [k, acc] of accordions) {
      const open = k === key
      acc.dataset.open = String(open)
      acc.firstElementChild.setAttribute('aria-expanded', String(open))
    }
    requestRedraw(win)
  }
  for (const [key, title] of list) {
    const acc = el(doc, 'div', 'rx-acc')
    acc.dataset.acc = key
    acc.dataset.open = 'false'
    const head = el(doc, 'button', 'rx-acch', `<b>${title}</b><span class="rx-accv"></span>${icon('chevron-down')}`)
    head.type = 'button'
    head.setAttribute('aria-expanded', 'false')
    head.addEventListener('click', () => openAccordion(acc.dataset.open === 'true' ? null : key))
    const body = el(doc, 'div', 'rx-accb')
    body.append(...bodies[key])
    acc.append(head, body)
    accordions.set(key, acc)
    side.appendChild(acc)
  }
  // Head values ("100% · +1 st", "Off"); `on` lights the value in amber.
  const setSummaries = (map) => {
    for (const [key, [text, on]] of Object.entries(map)) {
      const span = accordions.get(key)?.querySelector('.rx-accv')
      if (!span) continue
      if (span.textContent !== text) span.textContent = text
      span.classList.toggle('rx-on', Boolean(on))
    }
  }
  return { accordions, openAccordion, setSummaries }
}

const SCOPE_ACCORDIONS = {
  // "Sounds in this group" (name and members) is not in the mock; the group
  // cannot work without it, so it leads the column.
  group: [
    ['members', 'Sounds in this group'],
    ['tone', 'Tone'],
    ['eq', 'Parametric EQ'],
    ['space', 'Space'],
    ['occl', 'Occlusion'],
    ['drift-vol', 'Volume drift'],
    ['drift-pitch', 'Pitch drift'],
    ['drift-pan', 'Pan drift'],
    ['looks', 'Effect presets']
  ],
  // The mock also shows Occlusion here; the engine has no whole-mix
  // occlusion yet (Board: mock features to decide in step 20).
  preset: [
    ['tone', 'Tone'],
    ['eq', 'Parametric EQ'],
    ['space', 'Space'],
    ['drift-vol', 'Volume drift'],
    ['looks', 'Effect presets']
  ]
}

// Drift is one dropdown per type (owner, 2026-11-13: "all together is
// confusing"; approved mock-noctivago-remix-drift). arrangeDrift leaves the
// note and each axis as children of the section; this turns them into the
// accordion bodies, the note on top of the first.
const DRIFT_KEYS = { 'Volume drift': 'drift-vol', 'Pitch drift': 'drift-pitch', 'Pan drift': 'drift-pan' }
function driftBodies(section, axes) {
  const axisEls = axes.map(([idp]) => section.querySelector(`#${idp}-enabled`).closest('.rx-axis'))
  const lead = [...section.children].filter((n) => !axisEls.includes(n))
  const bodies = {}
  axes.forEach(([, title], i) => {
    bodies[DRIFT_KEYS[title]] = i === 0 ? [...lead, axisEls[i]] : [axisEls[i]]
  })
  return bodies
}
// Head value for one drift type: "On · -8 to 0 dB" or "Off".
export function driftSummary(enabled, rangeText) {
  return enabled ? [rangeText ? `On · ${rangeText}` : 'On', true] : ['Off', false]
}

// Group and Preset (mock screens remix-group, remix-preset): the EQ graph is
// the only canvas view, the settings column holds knobs as in Sound.
function arrangeScope(root, kind, getBands) {
  const doc = root.ownerDocument
  const win = doc.defaultView
  const p = `editor-mix-${kind}`
  const $ = (sel) => root.querySelector(sel)
  const host = $(kind === 'preset' ? '#editor-mix-preset-controls' : '#editor-mix-group-editor')
  host.classList.add('rx-grid', 'rx-scope')

  // --- Left: the EQ, then the loudness strip (not in the mock, kept) ---
  const canvasCol = el(doc, 'div', 'rx-canvas')
  // One view (the EQ), drawn as the same underlined tab row as Sound.
  const tabs = el(doc, 'div', 'rx-tabs', `<div class="rx-vtabs" role="group" aria-label="View"><button type="button" aria-pressed="true" title="EQ for ${kind === 'group' ? 'this group' : 'the whole mix'}">EQ</button></div>`)
  const eqCanvas = $(`#${p}-eq-canvas`)
  const eq = eqCanvas.closest('.editor-eq')
  eq.classList.add('rx-scope-eq')
  const eqTools = arrangeEqTools(eq, `${p}-eq`)
  eqCanvas.after(eqTools.toolbar)
  const loudness = $(`#${p}-waveform`)
  const loudnessNote = loudness.previousElementSibling
  loudnessNote.classList.add('rx-hint')
  canvasCol.append(tabs, eq, loudnessNote, loudness)
  const presetHint = $('#editor-mix-preset-hint')
  if (kind === 'preset' && presetHint) {
    presetHint.classList.add('rx-hint')
    canvasCol.appendChild(presetHint)
  }

  // --- Right: settings ---
  const knobs = (list) => {
    const grid = el(doc, 'div', 'rx-kgrid')
    for (const [id, label] of list) {
      const input = $(`#${p}-${id}`)
      const row = input.closest('label')
      grid.appendChild(attachKnob(input, { label, valueEl: $(`#${p}-${id}-value`) }).el)
      row.remove()
    }
    return grid
  }
  const tone = el(doc, 'div', 'rx-filter-group')
  tone.appendChild(
    knobs([
      ['highpass', 'High-pass'],
      ['lowpass', 'Low-pass'],
      ['gain', 'Gain'],
      // Group pan (owner, 2026-11-11); a whole mix has no pan.
      ...(kind === 'group' ? [['pan', 'Pan']] : [])
    ])
  )
  if (kind === 'preset') {
    // Fade in is not in the mock; it sits under Tone as a time row.
    const fade = $('#editor-mix-preset-fadein')
    const fadeLabel = fade.closest('label')
    const fadeRow = el(doc, 'div', 'rx-trow', '<span>Fade in when the preset loads</span>')
    fade.setAttribute('aria-label', 'Fade in')
    fadeRow.append(fade, el(doc, 'span', '', 's'))
    fadeRow.title = 'Eases the whole mix up when the preset loads'
    fadeLabel.remove()
    tone.appendChild(fadeRow)
  }
  const space = el(doc, 'div', 'rx-filter-group')
  space.appendChild(
    knobs([
      ['echo-delay', 'Echo delay'],
      ['echo-decay', 'Echo decay'],
      ['reverb-size', 'Room size'],
      ['reverb-mix', 'Reverb mix']
    ])
  )
  let occl = null
  if (kind === 'group') {
    occl = el(doc, 'div', 'rx-filter-group', '<p class="rx-hint rx-hint-l">Sounds like this group is behind a wall or a door.</p>')
    occl.appendChild(knobs([['occlusion', 'Amount']]))
  }
  host.querySelector('.editor-filters')?.remove() // emptied above

  const openEq = el(doc, 'button', 'rx-b', '<span>Open EQ</span>')
  openEq.type = 'button'
  openEq.title = 'Show the EQ graph on the left'
  openEq.addEventListener('click', () => eqCanvas.scrollIntoView({ block: 'nearest' }))
  const eqSide = el(doc, 'div', 'rx-srow1 rx-eq-side')
  eqSide.append(eqTools.compare, openEq, eqTools.reset)

  const drift = host.querySelector('.editor-fluctuation')
  arrangeDrift(doc, drift, SCOPE_DRIFT[kind].axes, SCOPE_DRIFT[kind].note)

  const looks = host.querySelector(`.editor-presets:has([data-mix-${kind}-effect])`)
  looks.className = 'rx-looks'
  looks.querySelector('.editor-presets-label')?.remove()
  for (const btn of looks.querySelectorAll(`[data-mix-${kind}-effect]`)) btn.className = 'rx-chip'
  const resetFilters = $(`#${p}-reset-filters`)
  const resetRow = resetFilters.closest('.editor-actions')
  resetRow.className = 'rx-srow1'
  resetFilters.className = 'rx-b rx-ghost'
  resetFilters.innerHTML = `${icon('refresh-cw')}<span>Reset filters</span>`

  const bodies = { tone: [tone], eq: [eqSide], space: [space], ...driftBodies(drift, SCOPE_DRIFT[kind].axes), looks: [looks, resetRow] }
  let members = null
  if (kind === 'group') {
    const nameRow = host.querySelector('.editor-mix-row')
    nameRow.className = 'rx-trow rx-name-row'
    const nameInput = $('#editor-mix-group-name')
    nameInput.classList.add('rx-field')
    nameInput.setAttribute('aria-label', 'Group name')
    members = $('#editor-mix-group-members')
    const membersNote = members.previousElementSibling
    membersNote.className = 'rx-hint rx-hint-l'
    bodies.members = [nameRow, membersNote, members]
    bodies.occl = [occl]
  }

  const side = el(doc, 'aside', 'rx-side')
  side.setAttribute('aria-label', 'Settings')
  const { openAccordion, setSummaries } = buildAccordions(side, SCOPE_ACCORDIONS[kind], bodies)
  host.replaceChildren(canvasCol, side)
  openAccordion(kind === 'group' ? 'members' : 'tone')

  // Head values, read from the controls (the tab sets them without events).
  const num = (id) => Number($(`#${p}-${id}`)?.value ?? 0)
  const refresh = () => {
    const f = filterSummaries({
      highpassHz: num('highpass'),
      lowpassHz: num('lowpass'),
      gainDb: num('gain'),
      pan: kind === 'group' ? num('pan') / 100 : 0,
      gateThresholdDb: -80,
      gateRangeDb: 0,
      denoiseEnabled: false,
      echoDelayMs: num('echo-delay'),
      echoDecay: num('echo-decay'),
      reverbSizeMs: num('reverb-size'),
      reverbMix: num('reverb-mix')
    })
    const bands = getBands?.(kind) ?? []
    const activeBands = bands.filter((b) => (b.type ?? 'peaking') !== 'off' && !b.muted).length
    const driftMap = Object.fromEntries(SCOPE_DRIFT[kind].axes.map(([idp, title]) => [DRIFT_KEYS[title], driftSummary($(`#${idp}-enabled`)?.checked, $(`#${idp}-bar`)?.dataset.range)]))
    const map = {
      ...driftMap,
      tone: [f.tone, f.tone !== 'Off'],
      eq: [activeBands ? `${activeBands} band${activeBands === 1 ? '' : 's'}` : 'Off', activeBands > 0],
      space: [f.space, f.space !== 'Off'],
      looks: ['None', false]
    }
    if (kind === 'group') {
      const occlusion = num('occlusion')
      map.occl = [occlusion > 0 ? `${Math.round(occlusion * 100)}%` : 'Off', occlusion > 0]
      const count = members.querySelectorAll('input:checked').length
      map.members = [count ? `${count} sound${count === 1 ? '' : 's'}` : 'None', false]
    }
    setSummaries(map)
  }
  for (const type of ['input', 'change', 'pointerup']) host.addEventListener(type, () => win.requestAnimationFrame(refresh))
  if (win.ResizeObserver) new win.ResizeObserver(() => requestRedraw(win)).observe(canvasCol)
  refresh()
  return { refresh }
}

const VIEWS = [
  ['trim', 'Trim'],
  ['seam', 'Loop seam'],
  ['eq', 'EQ'],
  ['spec', 'Spectrum']
]

// Called once from mount(), right after the markup is written and before any
// element is looked up or wired.
export function arrangeLayout(root, { onView, onCompare, getBands, getStudio, onPick, detail } = {}) {
  const doc = root.ownerDocument
  const win = doc.defaultView
  const $ = (sel) => root.querySelector(sel)
  const tab = $('.editor-tab')
  const panel = $('#editor-panel')
  tab.classList.add('rx')
  panel.classList.add('rx-grid')
  panel.dataset.view = 'trim'

  // --- Left: the canvas column ---
  const canvasCol = el(doc, 'div', 'rx-canvas')
  const tabs = el(
    doc,
    'div',
    'rx-tabs',
    `<div class="rx-vtabs" role="group" aria-label="View">${VIEWS.map(([k, t]) => `<button type="button" data-rx-view="${k}" aria-pressed="${k === 'trim'}">${t}</button>`).join('')}</div>` +
      '<div class="rx-seg rx-compare" role="group" aria-label="Compare with last saved" title="Last saved shows and plays the settings as they were last saved. Read-only: switch back to Now to keep editing."><button type="button" data-rx-compare="now" aria-pressed="true">Now</button><button type="button" data-rx-compare="saved" aria-pressed="false">Last saved</button></div>'
  )
  const viewTrim = el(doc, 'div', 'rx-view rx-view-trim')
  const viewSeam = el(doc, 'div', 'rx-view rx-view-seam')
  const viewEq = el(doc, 'div', 'rx-view rx-view-eq')
  const viewSpec = el(doc, 'div', 'rx-view rx-view-spec')

  // Looked up before anything is detached: $ only sees nodes still under root.
  const syncRow = $('#editor-sync-group-row')
  const times = $('.editor-times')
  times.classList.add('rx-under')
  const dopplerLabel = $('#editor-doppler').closest('label')
  dopplerLabel.lastChild.textContent = ' Doppler pass-by'
  $('#editor-doppler').setAttribute('aria-label', 'Doppler pass-by')
  $('#editor-envelope-enabled').setAttribute('aria-label', 'Volume envelope')
  const segmentBtn = el(doc, 'button', 'rx-b', `${icon('copy')}<span>Save segment as new</span>`)
  segmentBtn.id = 'editor-save-segment'
  segmentBtn.type = 'button'
  segmentBtn.title = 'Trim out just this segment and save it as a brand-new sound, with every other setting at its default'
  times.appendChild(segmentBtn)

  // Doppler: switch, then its two knobs and the Reverse switch.
  const dopplerOptions = $('#editor-doppler-options')
  dopplerOptions.classList.remove('editor-speed-pitch')
  dopplerOptions.classList.add('rx-kgrid')
  for (const [id, label] of [
    ['editor-doppler-intensity', 'Intensity'],
    ['editor-doppler-sharpness', 'Sharpness']
  ]) {
    const input = $('#' + id)
    const row = input.closest('label')
    const valueEl = $(`#${id}-value`)
    const knob = attachKnob(input, { label, valueEl })
    row.replaceWith(knob.el)
  }
  const dopplerOpt = el(doc, 'div', 'rx-opt2')
  dopplerOpt.append(dopplerLabel, dopplerOptions)

  // The volume envelope has its own accordion (owner, 2026-11-11: under the
  // trim controls it was hard to find and Reset sat badly under the switch):
  // a switch row, then Reset and the how-to line while it is on.
  const crossfadeSection = $('#editor-crossfade-section')
  const envelopeReset = $('#editor-envelope-reset')
  const envelopeHint = envelopeReset.nextElementSibling
  const envelopeRow = toSwitchRow(doc, $('#editor-envelope-enabled').closest('label'), 'Shape the volume over time', 'With points on the Trim waveform')
  envelopeReset.className = 'rx-b rx-ghost'
  envelopeReset.innerHTML = `${icon('refresh-cw')}<span>Reset envelope</span>`
  envelopeHint.className = 'rx-hint rx-hint-l rx-envelope-hint'
  envelopeHint.textContent = 'Drag a point to change the volume there. Double-click the line to add a point, double-click a point to reset it to full, right-click a point to remove it. Only lowers the volume, never boosts it.'
  const envelopeActions = el(doc, 'div', 'rx-srow1 rx-envelope-actions')
  envelopeActions.appendChild(envelopeReset)
  const envelopeBody = el(doc, 'div', 'rx-envelope-body')
  envelopeBody.append(envelopeRow, envelopeActions, envelopeHint)
  const options = el(doc, 'div', 'rx-under rx-wrap2')
  options.append(dopplerOpt)

  const dopplerHint = $('#editor-doppler-hint')
  dopplerHint.classList.remove('editor-speed-pitch-hint')
  dopplerHint.classList.add('rx-hint')

  const seekSlot = el(doc, 'div', 'rx-seek-slot')
  seekSlot.id = 'rx-seek-slot'
  const transport = el(doc, 'div', 'rx-under rx-transport')
  transport.id = 'rx-transport'

  // Step 13d: the transport and the seek bar live in the preview module under
  // the library (buildStudio), not under the Trim canvas.
  viewTrim.append($('.editor-name-row'), $('#editor-canvas'), $('#editor-scrollbar'), $('#editor-waveform-status'), times, options, dopplerHint)

  // Loop seam view: what is left of the crossfade section.
  const seamCanvas = $('#editor-seam-canvas')
  const crossfade = $('#editor-crossfade')
  const crossfadeRow = crossfade.closest('label')
  const seamRow = $('.editor-seam-row')
  const seamListen = $('#editor-seam-listen')
  const seamStatus = $('#editor-seam-status')
  seamListen.className = 'rx-b'
  seamListen.innerHTML = `${icon('headphones')}<span>Listen to the seam</span>`
  const crossfadeValue = $('#editor-crossfade-value')
  const crossfadeKnob = attachKnob(crossfade, { label: 'Crossfade', valueEl: crossfadeValue })
  const seamUnder = el(doc, 'div', 'rx-under')
  seamUnder.append(seamListen, crossfadeKnob.el)
  crossfadeRow.remove()
  seamRow.remove()
  seamCanvas.after(seamUnder, seamStatus)
  crossfadeSection.querySelector('.editor-crossfade-hint').className = 'rx-hint'
  viewSeam.appendChild(crossfadeSection)

  // EQ view: the graph, then its tools and the selected band's fields under
  // it. A/B compare and Reset are settings, so they stay in the side column.
  const eq = $('#editor-eq-canvas').closest('.editor-eq')
  const eqTools = arrangeEqTools(eq, 'editor-eq')
  const eqHeader = eqTools.toolbar
  $('#editor-eq-canvas').after(eqHeader)
  viewEq.appendChild(eq)
  const openEq = el(doc, 'button', 'rx-b', '<span>Open EQ</span>')
  openEq.type = 'button'
  openEq.id = 'rx-open-eq'
  openEq.title = 'Show the EQ graph on the left'
  const eqSide = el(doc, 'div', 'rx-srow1 rx-eq-side')
  eqSide.append(eqTools.compare, openEq, eqTools.reset)

  // Spectrum view: the spectrogram, then Reduce by, Delete box and Clear all boxes.
  const spectral = $('#editor-spectral-section')
  const spectralControls = spectral.querySelector('.editor-spectral-controls')
  spectralControls.classList.add('rx-under')
  const reduction = $('#editor-spectral-reduction')
  const reductionLabel = reduction.closest('label')
  reduction.type = 'number' // the mock's small number field; the tab clamps it
  reduction.classList.add('rx-field', 'rx-numf')
  reductionLabel.className = 'rx-lrow2'
  $('#editor-spectral-reduction-value').classList.add('rx-visually-hidden')
  reductionLabel.appendChild(el(doc, 'span', 'rx-unit', 'dB'))
  const spectralDelete = $('#editor-spectral-delete')
  spectralDelete.className = 'rx-b rx-ghost'
  spectralDelete.innerHTML = `${icon('trash-2')}<span>Delete box</span>`
  const spectralClear = $('#editor-spectral-clear')
  spectralClear.className = 'rx-b rx-ghost'
  spectralClear.innerHTML = '<span>Clear all boxes</span>'
  spectralControls.append(spectralDelete, spectralClear)
  spectral.querySelector('.editor-eq-header').remove()
  spectral.querySelector('.editor-eq-hint').classList.add('rx-hint')
  viewSpec.appendChild(spectral)

  const saveStatus = $('#editor-save-status')
  canvasCol.append(tabs, viewTrim, viewSeam, viewEq, viewSpec, saveStatus)

  // --- Right: the settings column ---
  const side = el(doc, 'aside', 'rx-side')
  side.setAttribute('aria-label', 'Settings')

  // Playback: three tiles from the three radio labels.
  const playmode = $('.editor-playmode')
  const tiles = el(doc, 'div', 'rx-tiles3')
  tiles.setAttribute('role', 'radiogroup')
  tiles.setAttribute('aria-label', 'Playback mode')
  const TILE = {
    'editor-playmode-loop': ['repeat', 'Loop'],
    'editor-playmode-scatter': ['shuffle', 'Random'],
    'editor-playmode-scheduled': ['clock', 'Scheduled']
  }
  for (const [id, [ic, text]] of Object.entries(TILE)) {
    const input = $('#' + id)
    const label = input.closest('label')
    label.className = 'rx-tile'
    input.setAttribute('aria-label', text)
    label.replaceChildren(input, el(doc, 'span', 'rx-tile-face', `${icon(ic, 20)}${text}`))
    tiles.appendChild(label)
  }
  const hintRandom = el(doc, 'p', 'rx-hint rx-hint-l rx-only-random', 'Replays this clip at a random gap instead of looping. Good for a creak or a bird call inside a longer mix.')
  const hintScheduled = el(doc, 'p', 'rx-hint rx-hint-l rx-only-scheduled', 'Plays once at clock times, like a church bell at noon or an hourly chime.')
  playmode.remove()

  const loopBody = el(doc, 'div', 'rx-only-loop rx-loop-body')
  const suggestRow = $('.editor-suggest-loop-row')
  const suggestBtn = $('#editor-suggest-loop')
  suggestBtn.className = 'rx-b'
  suggestBtn.innerHTML = `${icon('sparkles')}<span>Suggest a loop point</span>`
  const openSeam = el(doc, 'button', 'rx-b', `${icon('headphones')}<span>Listen to the seam</span>`)
  openSeam.type = 'button'
  openSeam.id = 'rx-open-seam'
  openSeam.title = 'Open the Loop seam view'
  const loopButtons = el(doc, 'div', 'rx-srow1')
  loopButtons.append(suggestBtn, openSeam)
  suggestRow.prepend(loopButtons)
  loopBody.appendChild(suggestRow)

  // Random: Sync group sits with the other Random settings, after Gap.
  const scatter = $('#editor-scatter-section')
  scatter.querySelector('.editor-gap-axis').after(syncRow)
  const syncInput = syncRow.querySelector('input')
  syncRow.querySelector('span').innerHTML = `Sync group <span class="editor-fluctuation-sub">${syncInput.title.replace(' - one starts, all start.', '')}</span>`

  // Scheduled: Times and Every are two switches. Only one runs at a time for
  // now, so they stay one radio group: turning one on turns the other off and
  // the last one cannot be switched off.
  const schedule = $('#editor-schedule-section')
  const SCHEDULE = [
    ['editor-schedule-type-times', $('#editor-schedule-times-row'), 'Times (24h, comma-separated)', 'Plays once at each time, every day'],
    ['editor-schedule-type-interval', $('#editor-schedule-interval-row'), 'Every', 'Or repeat, lined up with the clock']
  ]
  let scheduleAnchor = null
  for (const [id, row, title, sub] of SCHEDULE) {
    const input = $('#' + id)
    const oldLabel = input.closest('label')
    const axis = el(doc, 'div', 'rx-axis')
    const head = el(doc, 'label', 'rx-srow', `<span class="rx-sl"><span>${title}</span><small>${sub}</small></span>`)
    input.setAttribute('aria-label', title)
    head.appendChild(input)
    row.querySelector('span')?.remove() // the row's own caption repeats the head
    row.classList.add('rx-trow')
    axis.append(head, row)
    if (scheduleAnchor) scheduleAnchor.after(axis)
    else schedule.prepend(axis)
    scheduleAnchor = axis
    oldLabel.remove()
  }

  const fade = $('#editor-fade-section')

  // Speed and pitch: two knobs, then Reverse as a switch row.
  const speedPitch = $('#editor-speed').closest('.editor-speed-pitch')
  const speedKnobs = el(doc, 'div', 'rx-kgrid')
  for (const [id, label] of [
    ['editor-speed', 'Speed'],
    ['editor-pitch', 'Pitch']
  ]) {
    const input = $('#' + id)
    const row = input.closest('label')
    const knob = attachKnob(input, { label, valueEl: $(`#${id}-value`) })
    row.remove()
    speedKnobs.appendChild(knob.el)
  }
  const reverseRow = toSwitchRow(doc, $('#editor-reverse').closest('label'), 'Reverse', 'Plays live for sounds up to 10 minutes')
  const speedHint = speedPitch.querySelector('.editor-speed-pitch-hint:not(#editor-reverse-status)')
  speedHint.className = 'rx-hint rx-hint-l'
  speedHint.textContent = 'Speed applies live. Pitch applies once saved (loops under 10 minutes) and previews roughly while you drag.'
  const reverseStatus = $('#editor-reverse-status')
  reverseStatus.classList.remove('editor-speed-pitch-hint')
  reverseStatus.classList.add('rx-hint', 'rx-hint-l')
  speedPitch.className = 'rx-speed-body'
  speedPitch.prepend(speedKnobs, reverseRow)

  // Tone, Cleanup and Space: FilterControls.jsx renders a group into each.
  const filters = $('#editor-filters')
  const filterTargets = {}
  for (const key of ['tone', 'clean', 'space']) {
    filterTargets[key] = el(doc, 'div', 'rx-filter-group')
    filterTargets[key].id = `rx-filters-${key}`
  }

  // Effect presets: chips, plus the app's Reset filters (not in the mock).
  const resetFilters = $('#editor-reset-filters').closest('.editor-actions')
  resetFilters.className = 'rx-srow1'
  const resetBtn = $('#editor-reset-filters')
  resetBtn.className = 'rx-b rx-ghost'
  resetBtn.innerHTML = `${icon('refresh-cw')}<span>Reset filters</span>`
  const looks = [...panel.querySelectorAll('.editor-presets')].find((n) => n.querySelector('[data-preset]'))
  looks.className = 'rx-looks'
  looks.querySelector('.editor-presets-label')?.remove()
  for (const btn of looks.querySelectorAll('[data-preset]')) btn.className = 'rx-chip'

  const driftSection = $('#editor-fluctuation-section')
  arrangeDrift(doc, driftSection)

  const BODIES = {
    playback: [tiles, hintRandom, hintScheduled, loopBody, scatter, schedule, fade],
    envelope: [envelopeBody],
    speed: [speedPitch],
    tone: [filterTargets.tone, filters],
    eq: [eqSide],
    clean: [filterTargets.clean],
    space: [filterTargets.space],
    looks: [looks, resetFilters],
    ...driftBodies(driftSection, DRIFT_AXES)
  }
  const { accordions, openAccordion, setSummaries } = buildAccordions(side, ACCORDIONS, BODIES)
  accordions.get('playback').querySelector('.rx-accv').classList.add('rx-on')
  accordions.get('playback').querySelector('.rx-accv').textContent = 'Loop'

  panel.replaceChildren(canvasCol, side)
  openAccordion('playback')

  // --- Views ---
  const setView = (view) => {
    if (panel.dataset.view === view) return
    panel.dataset.view = view
    for (const btn of tabs.querySelectorAll('[data-rx-view]')) btn.setAttribute('aria-pressed', String(btn.dataset.rxView === view))
    requestRedraw(win)
    onView?.(view)
  }
  tabs.addEventListener('click', (evt) => {
    const btn = evt.target.closest('[data-rx-view]')
    if (btn) setView(btn.dataset.rxView)
  })
  openSeam.addEventListener('click', () => setView('seam'))
  openEq.addEventListener('click', () => setView('eq'))

  // --- Compare with last saved ---
  // While Last saved is on screen everything that edits is inert; the view
  // tabs, the compare switch and the transport stay usable.
  const compareSeg = tabs.querySelector('.rx-compare')
  const setCompare = (which) => {
    const saved = which === 'saved'
    panel.dataset.compare = saved ? 'saved' : 'now'
    for (const btn of compareSeg.querySelectorAll('[data-rx-compare]')) btn.setAttribute('aria-pressed', String(btn.dataset.rxCompare === which))
    const locked = [side, viewSeam, viewSpec, eqHeader, eqTools.fields, ...viewTrim.children]
    for (const n of locked) n.inert = saved
  }
  compareSeg.addEventListener('click', (evt) => {
    const btn = evt.target.closest('[data-rx-compare]')
    if (btn && btn.getAttribute('aria-pressed') !== 'true') onCompare?.(btn.dataset.rxCompare)
  })

  // --- Empty state ---
  const oldEmpty = $('#editor-empty')
  const empty = el(
    doc,
    'div',
    'editor-empty rx-empty',
    `${icon('audio-waveform', 40)}<h2>Pick a sound to edit</h2><p>Trim it, make a clean loop, shape its tone. The original file is never changed.</p><div><button id="rx-pick-sound" class="rx-b rx-pri" type="button">${icon('search')}<span>Pick a sound</span></button></div>`
  )
  empty.id = 'editor-empty'
  oldEmpty.replaceWith(empty)
  empty.querySelector('#rx-pick-sound').addEventListener('click', () => doc.getElementById('rx-lib-search')?.focus())

  if (win.ResizeObserver) {
    const ro = new win.ResizeObserver(() => requestRedraw(win))
    ro.observe(canvasCol)
    ro.observe(side)
  }

  // Called by the tab whenever the play mode is set, by the user or by a load.
  const MODE_LABEL = { loop: 'Loop', scatter: 'Random', scheduled: 'Scheduled' }
  const playbackValue = accordions.get('playback').querySelector('.rx-accv')
  const setPlayMode = (mode) => {
    playbackValue.textContent = MODE_LABEL[mode] ?? MODE_LABEL.loop
    // The Loop seam view only exists for loops (its tab hides in CSS).
    if ((mode === 'scatter' || mode === 'scheduled') && panel.dataset.view === 'seam') setView('trim')
  }

  // Group and Preset get the same canvas + settings layout.
  const scopes = { preset: arrangeScope(root, 'preset', getBands), group: arrangeScope(root, 'group', getBands) }
  const refreshScopes = () => {
    scopes.preset.refresh()
    scopes.group.refresh()
  }

  const studio = buildStudio(root, { getStudio, onPick, seekSlot, transport, detail })

  // Drift has no meaning for Random / Scheduled one-shots (see RemixTab's
  // setPlayModeControls): hide its three dropdowns, not just their contents.
  const setDriftHidden = (hidden) => {
    for (const key of Object.values(DRIFT_KEYS)) accordions.get(key)?.classList.toggle('hidden', hidden)
  }

  return { setView, openAccordion, setDriftHidden, setPlayMode, setCompare, setSummaries, filterTargets, refreshScopes, refreshStudio: studio.refresh }
}

// Step 13d (mock-noctivago-remix-studio v2): three panes on the darkest
// ground. Left: the library (title, New group, Sound / Group / Preset chips,
// search, the list) over a small preview module. Center: kind, big name,
// meta and the save actions over the view tabs and the canvas. Right: the
// settings accordions. The tab element is the grid; the mode panels and
// their .rx-grid are display: contents, so each mode's canvas column and
// settings column land in the center and right cells.
const KIND = { sound: 'Sound', group: 'Group', preset: 'Preset' }
const SEARCH = { sound: 'Search sounds', group: 'Search groups', preset: 'Search presets' }
const NONE = { sound: 'No sounds match.', group: 'No groups yet. Make one with New group.', preset: 'No presets saved yet.' }

function buildStudio(root, { getStudio, onPick, seekSlot, transport, detail }) {
  const doc = root.ownerDocument
  const win = doc.defaultView
  const tab = root.querySelector('.editor-tab')

  const lcol = el(doc, 'div', 'rx-lcol')
  const lib = el(
    doc,
    'aside',
    'rx-pane rx-lib',
    `<div class="rx-lib-h"><h3>Remix</h3><button id="rx-new-group" class="rx-i rx-ib" type="button" title="New group" aria-label="New group">${icon('plus')}</button></div>` +
      '<div id="rx-chips" class="rx-chips" role="group" aria-label="What you remix"></div>' +
      '<label id="rx-in-preset" class="rx-in-preset"><span>In preset</span></label>' +
      `<label class="rx-search">${icon('search')}<input id="rx-lib-search" type="text" placeholder="Search sounds" aria-label="Search" autocomplete="off" /></label>` +
      '<div id="rx-lib-list" class="rx-list"></div>'
  )
  lib.setAttribute('aria-label', 'Library')
  const prev = el(
    doc,
    'section',
    'rx-pane rx-prev',
    '<div class="rx-prow"><span id="rx-pplay-slot" class="rx-slot"></span><b id="rx-now-name" class="rx-now"></b><span id="rx-prow-end" class="rx-slot"></span></div>' +
      '<div id="rx-pnote" class="rx-pnote" hidden>Playing this group only</div>' +
      '<div class="rx-pseek"><span id="rx-cur">0:00</span><span id="rx-total">0:00</span></div>' +
      '<div id="rx-pvol" class="rx-pvol"></div>'
  )
  prev.setAttribute('aria-label', 'Preview')
  prev.querySelector('#rx-total').before(seekSlot)
  prev.appendChild(transport) // emptied into the rows by arrangeBar
  lcol.append(lib, prev)

  const head = el(
    doc,
    'div',
    'rx-pane rx-head',
    '<div class="rx-ht"><div id="rx-kind" class="rx-kind">Sound</div><h2 id="rx-title" class="rx-title"></h2><div id="rx-meta" class="rx-meta"></div></div><div id="rx-acts" class="rx-acts"></div>'
  )
  // Controls the library replaces stay in the DOM (the tab still reads and
  // writes them), out of sight.
  const holder = el(doc, 'div', 'rx-holder')
  holder.hidden = true
  tab.prepend(lcol, head)
  tab.appendChild(holder)

  const search = lib.querySelector('#rx-lib-search')
  const list = lib.querySelector('#rx-lib-list')
  let state = null
  let highlight = -1
  let lastKey = ''
  const query = () => search.value.trim().toLowerCase()
  const shown = () => (state?.items ?? []).filter((it) => it.name.toLowerCase().includes(query()))

  // Drill in (mock-noctivago-remix-detail, placement C): a picked group or
  // preset replaces the list with its contents until its back arrow. sub is
  // the group or sound opened inside a preset.
  let drilled = true
  let sub = null
  let dragging = false
  const view = () => {
    if (!drilled || !state || state.mode === 'sound' || !state.currentId || query()) return null
    const v = detail?.get?.(state.mode, sub)
    if (!v?.top) return null
    if (sub && !v.sub) sub = null
    return v
  }
  const handlers = detail && {
    up: () => {
      drilled = false
      sub = null
      lastKey = ''
      renderList()
    },
    back: () => {
      sub = null
      lastKey = ''
      renderList()
    },
    openSub: (kind, id) => {
      sub = { kind, id }
      lastKey = ''
      renderList()
      list.scrollTop = 0
    },
    dragging: (on) => {
      dragging = on
      if (!on) win.queueMicrotask(() => renderList())
    },
    setVolume: (id, gain, commit) => detail.setVolume(state.mode, sub, id, gain, commit),
    setPan: (id, pan) => detail.setPan(id, pan),
    mute: (id) => detail.mute(id),
    solo: (id, on) => detail.solo(id, on),
    preview: (id) => detail.preview(id),
    editSound: (id) => detail.editSound(id),
    editGroup: (id) => detail.editGroup(id)
  }

  const renderList = () => {
    if (dragging) return
    const v = view()
    if (v) {
      const key = JSON.stringify(['drill', state.mode, state.currentId, sub, v])
      if (key === lastKey) return
      lastKey = key
      list.classList.add('rx-list-drill')
      // Keep keyboard focus on the same control across a redraw.
      const focused = list.contains(doc.activeElement) ? doc.activeElement.getAttribute('aria-label') : null
      renderDetail(list, v, handlers)
      if (focused) list.querySelector(`[aria-label="${CSS.escape(focused)}"]`)?.focus()
      return
    }
    list.classList.remove('rx-list-drill')
    const items = shown()
    const key = JSON.stringify([state?.mode, state?.currentId, highlight, items])
    if (key === lastKey) return
    lastKey = key
    list.replaceChildren()
    if (!items.length) {
      list.appendChild(el(doc, 'p', 'rx-list-empty', query() ? `No ${state.mode}s match.` : NONE[state?.mode ?? 'sound']))
      return
    }
    items.forEach((it, i) => {
      const b = el(doc, 'button', 'rx-item' + (i === highlight ? ' rx-item-hl' : ''), `<span class="rx-thumb">${icon(it.icon)}</span><span class="rx-txt"><b></b><small></small></span>${it.dot ? '<i class="rx-dot"></i>' : ''}`)
      b.type = 'button'
      b.querySelector('b').textContent = it.name
      b.querySelector('small').textContent = it.meta
      b.title = it.dot ? `${it.name} (${it.dotTitle})` : it.name
      if (it.id === state.currentId) b.setAttribute('aria-current', 'true')
      b.addEventListener('click', () => {
        // A row opens its contents; the picked row again just drills back in.
        if (state.mode !== 'sound') {
          drilled = true
          sub = null
          if (query()) search.value = ''
          lastKey = ''
        }
        onPick?.(state.mode, it.id)
        renderList()
      })
      if (state.mode !== 'sound' && detail) b.insertAdjacentHTML('beforeend', `<span class="rx-chev">${icon('chevron-right')}</span>`)
      list.appendChild(b)
    })
  }

  const refresh = () => {
    state = getStudio?.()
    if (!state) return
    tab.dataset.rxMode = state.mode
    search.placeholder = SEARCH[state.mode]
    head.querySelector('#rx-kind').textContent = KIND[state.mode]
    const title = head.querySelector('#rx-title')
    if (title.textContent !== state.head.name) {
      title.textContent = state.head.name
      title.title = state.head.name
    }
    head.querySelector('#rx-meta').textContent = state.head.meta
    const now = prev.querySelector('#rx-now-name')
    now.textContent = state.head.playing ?? state.head.name
    now.title = now.textContent
    renderList()
  }

  let lastMode = null
  search.addEventListener('input', () => {
    highlight = -1
    renderList()
  })
  search.addEventListener('keydown', (evt) => {
    const items = shown()
    if (evt.key === 'ArrowDown' || evt.key === 'ArrowUp') {
      evt.preventDefault()
      if (!items.length) return
      highlight = (highlight + (evt.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
      renderList()
      list.querySelector('.rx-item-hl')?.scrollIntoView({ block: 'nearest' })
    } else if (evt.key === 'Enter') {
      evt.preventDefault()
      const picked = items[highlight] ?? items[0]
      if (picked) onPick?.(state.mode, picked.id)
    } else if (evt.key === 'Escape') {
      search.value = ''
      highlight = -1
      renderList()
    }
  })
  // A new mode starts with an empty search, drilled into what it has open.
  const syncMode = () => {
    if (state && state.mode !== lastMode) {
      if (lastMode) search.value = ''
      lastMode = state.mode
      drilled = true
      sub = null
      highlight = -1
      lastKey = ''
      renderList()
    }
  }
  const refreshAll = () => {
    refresh()
    syncMode()
  }
  // Play mode radios, preset and group selects and the like change the list
  // and the head; one coalesced refresh covers them. A microtask, not a
  // frame: frames pause while the window is in the background.
  let queued = false
  const queue = () => {
    if (queued) return
    queued = true
    win.queueMicrotask(() => {
      queued = false
      refreshAll()
    })
  }
  tab.addEventListener('change', queue)

  return { refresh: queue, refreshNow: refreshAll, lib, prev, head, holder }
}

// Called once at the end of mountSticky(): moves the controls mountSticky()
// made into the studio panes (buildStudio). Nothing is left in the app's
// sticky bar, so it is hidden while Remix shows.
export function arrangeBar(bar, root) {
  const doc = bar.ownerDocument
  const win = doc.defaultView
  const $ = (sel) => bar.querySelector(sel) || root.querySelector(sel)
  bar.classList.add('rx-bar-host')
  const tab = root.querySelector('.editor-tab')
  const holder = tab.querySelector('.rx-holder')
  const lib = tab.querySelector('.rx-lib')

  // The old search-and-dropdown picker: the library list replaces it.
  const picker = root.querySelector('.editor-picker')
  if (picker) holder.appendChild(picker)

  // Sound, Group, Preset (the mock's order) as chips. The tab toggles
  // editor-mode-pill-active on them; CSS reads that.
  const chips = lib.querySelector('#rx-chips')
  // Each chip carries its type's icon, the same one as its rows and panel.
  const CHIP_ICON = { '#editor-mode-sound': 'audio-waveform', '#editor-mode-group': 'layers', '#editor-mode-preset': 'bookmark' }
  for (const id of ['#editor-mode-sound', '#editor-mode-group', '#editor-mode-preset']) {
    const b = $(id)
    b.classList.remove('editor-mode-pill')
    b.classList.add('rx-mchip')
    b.insertAdjacentHTML('afterbegin', icon(CHIP_ICON[id], 14))
    chips.appendChild(b)
  }
  const hint = root.querySelector('#editor-mode-hint')
  if (hint) {
    const syncTitle = () => {
      chips.title = hint.textContent
    }
    new win.MutationObserver(syncTitle).observe(hint, { childList: true, characterData: true, subtree: true })
    syncTitle()
    holder.appendChild(hint)
  }
  root.querySelector('.editor-mode-switch-row')?.remove()

  // Group mode lists the groups of one preset: that preset's select sits
  // under the chips. The group select itself is replaced by the list.
  const mixPickers = $('#editor-mix-picker-row')
  const presetSelect = $('#editor-mix-preset-select')
  presetSelect.classList.add('rx-field')
  presetSelect.setAttribute('aria-label', 'Preset')
  lib.querySelector('#rx-in-preset').appendChild(presetSelect)
  $('#editor-mix-group-select').setAttribute('aria-label', 'Group')
  const newGroup = $('#editor-mix-group-new')
  holder.appendChild(mixPickers)
  // New group sits by the library title in every mode, as in the mock; from
  // Sound or Preset it opens Group first.
  lib.querySelector('#rx-new-group').addEventListener('click', () => {
    if (!$('#editor-mode-group').classList.contains('editor-mode-pill-active')) $('#editor-mode-group').click()
    win.setTimeout(() => newGroup.click(), 0)
  })

  // Center head: Undo, Redo, Cancel, Save as copy, Save (Sound) or the
  // status and Save (Group, Preset), then Copy to preset and Delete group.
  const acts = tab.querySelector('#rx-acts')
  const mixControls = $('#editor-sticky-mix-controls')
  const groupActions = $('#rx-group-actions')
  const soloGroup = $('#editor-mix-solo-group')
  acts.append($('#editor-sticky-sound-controls'), mixControls, groupActions)

  // Preview module: Play, the name, S, Loop; the seek bar with its times;
  // then preview volume and Live edit (not in the mock, kept).
  const playSlot = tab.querySelector('#rx-pplay-slot')
  const endSlot = tab.querySelector('#rx-prow-end')
  const play = $('#editor-play-pause')
  play.className = 'rx-pplay rx-only-sound'
  const mixPlay = $('#editor-mix-play-pause')
  mixPlay.className = 'rx-pplay rx-only-mix'
  playSlot.append(play, mixPlay)
  const solo = $('#editor-sticky-solo')
  solo.classList.add('rx-only-sound')
  const loop = $('#editor-loop-toggle')
  loop.classList.add('rx-only-sound')
  soloGroup.classList.add('rx-only-mix')
  endSlot.append(solo, loop, soloGroup)

  const time = $('#editor-sticky-time')
  const cur = tab.querySelector('#rx-cur')
  const total = tab.querySelector('#rx-total')
  const syncTime = () => {
    const [a, b] = time.textContent.split('/').map((t) => t.trim())
    cur.textContent = a || '0:00'
    total.textContent = b || '0:00'
  }
  new win.MutationObserver(syncTime).observe(time, { childList: true, characterData: true, subtree: true })
  syncTime()
  holder.appendChild(time)
  tab.querySelector('#rx-seek-slot').appendChild($('#editor-sticky-progress'))

  const vol = tab.querySelector('#rx-pvol')
  const volume = $('#editor-sticky-volume')
  const volumeWrap = el(doc, 'div', 'rx-volume')
  volumeWrap.appendChild(volume)
  const syncVolume = () => volume.style.setProperty('--p', `${volume.value}%`)
  volume.addEventListener('input', syncVolume)
  syncVolume()
  // Group and Preset modes play through the Mixer: their volume row is the
  // app's master volume (RemixTab.updateMixVolumeUI), shown in place of the
  // Sound preview's own row.
  const mixMute = $('#editor-mix-mute')
  const mixVolume = $('#editor-mix-volume')
  mixMute.classList.add('rx-only-mix')
  const mixVolumeWrap = el(doc, 'div', 'rx-volume rx-only-mix')
  mixVolumeWrap.appendChild(mixVolume)
  const soundMute = $('#editor-sticky-mute')
  soundMute.classList.add('rx-only-sound')
  volumeWrap.classList.add('rx-only-sound')
  const modeToggle = $('#editor-preview-mode-toggle')
  modeToggle.classList.add('rx-only-sound')
  vol.append(soundMute, volumeWrap, mixMute, mixVolumeWrap, modeToggle)

  tab.querySelector('#rx-transport')?.remove()
  bar.querySelector('#rx-transport-src')?.remove()
  bar.querySelector('.rx-bar')?.remove()
}
