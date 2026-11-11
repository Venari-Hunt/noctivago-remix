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
  ['speed', 'Speed and pitch'],
  ['tone', 'Tone'],
  ['eq', 'Parametric EQ'],
  ['clean', 'Cleanup'],
  ['space', 'Space'],
  ['drift', 'Drift'],
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
function arrangeDrift(doc, section) {
  const head = section.querySelector('.editor-fluctuation-head')
  const note = el(doc, 'p', 'rx-hint rx-hint-l', 'Slow, random drift while the sound loops: wind gusting, rain swelling. Plays in Live edit here and always in the Mixer. Saves on its own.')
  note.title = head.querySelector('.editor-fluctuation-hint').textContent.trim()
  head.replaceWith(note)
  for (const n of section.querySelectorAll(':scope > .editor-fluctuation-hint')) {
    n.classList.remove('editor-fluctuation-hint')
    n.classList.add('rx-hint', 'rx-hint-l')
  }
  for (const [idp, title, sub] of DRIFT_AXES) {
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
    body.append($('bar'), changeRow, transitionRow, fullRandom, bias)
    axis.replaceChildren(row, body)
  }
}

const VIEWS = [
  ['trim', 'Trim'],
  ['seam', 'Loop seam'],
  ['eq', 'EQ'],
  ['spec', 'Spectrum']
]

// Called once from mount(), right after the markup is written and before any
// element is looked up or wired.
export function arrangeLayout(root, { onView, onCompare } = {}) {
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
    `<div class="rx-seg" role="group" aria-label="View">${VIEWS.map(([k, t]) => `<button type="button" data-rx-view="${k}" aria-pressed="${k === 'trim'}">${t}</button>`).join('')}</div>` +
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

  // The volume envelope is drawn on the trim waveform in every play mode, so
  // its switch leaves the loop-only crossfade section.
  const crossfadeSection = $('#editor-crossfade-section')
  const envelopeLabel = $('#editor-envelope-enabled').closest('label')
  const envelopeReset = $('#editor-envelope-reset')
  const envelopeHint = envelopeReset.nextElementSibling
  envelopeReset.className = 'rx-b rx-ghost'
  envelopeReset.innerHTML = `${icon('refresh-cw')}<span>Reset envelope</span>`
  envelopeHint.className = 'rx-hint rx-envelope-hint'
  const envelopeGrid = el(doc, 'div', 'rx-kgrid rx-envelope-grid')
  envelopeGrid.appendChild(envelopeReset)
  const envelopeOpt = el(doc, 'div', 'rx-opt2')
  envelopeOpt.append(envelopeLabel, envelopeGrid)
  const options = el(doc, 'div', 'rx-under rx-wrap2')
  options.append(dopplerOpt, envelopeOpt)

  const dopplerHint = $('#editor-doppler-hint')
  dopplerHint.classList.remove('editor-speed-pitch-hint')
  dopplerHint.classList.add('rx-hint')

  const seekSlot = el(doc, 'div', 'rx-seek-slot')
  seekSlot.id = 'rx-seek-slot'
  const transport = el(doc, 'div', 'rx-under rx-transport')
  transport.id = 'rx-transport'

  viewTrim.append($('.editor-name-row'), $('#editor-canvas'), $('#editor-scrollbar'), $('#editor-waveform-status'), seekSlot, transport, times, options, dopplerHint, envelopeHint)

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
  const eqHeader = eq.querySelector('.editor-eq-header')
  const eqCompare = eqHeader.querySelector('.editor-eq-compare')
  const eqReset = $('#editor-eq-reset')
  eqHeader.classList.add('rx-under')
  $('#editor-eq-canvas').after(eqHeader)
  eq.querySelector('.editor-eq-hint').classList.add('rx-hint')
  viewEq.appendChild(eq)
  const openEq = el(doc, 'button', 'rx-b', '<span>Open EQ</span>')
  openEq.type = 'button'
  openEq.id = 'rx-open-eq'
  openEq.title = 'Show the EQ graph on the left'
  const eqSide = el(doc, 'div', 'rx-srow1 rx-eq-side')
  eqSide.append(eqCompare, openEq, eqReset)

  // Spectrum view: the spectrogram, then Reduce by, Delete box and Clear all.
  const spectral = $('#editor-spectral-section')
  const spectralControls = spectral.querySelector('.editor-spectral-controls')
  spectralControls.classList.add('rx-under')
  spectralControls.append($('#editor-spectral-delete'), $('#editor-spectral-clear'))
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
    speed: [speedPitch],
    tone: [filterTargets.tone, filters],
    eq: [eqSide],
    clean: [filterTargets.clean],
    space: [filterTargets.space],
    looks: [looks, resetFilters],
    drift: [driftSection]
  }
  const accordions = new Map()
  const openAccordion = (key) => {
    for (const [k, acc] of accordions) {
      const open = k === key
      acc.dataset.open = String(open)
      acc.firstElementChild.setAttribute('aria-expanded', String(open))
    }
    requestRedraw(win)
  }
  for (const [key, title] of ACCORDIONS) {
    const acc = el(doc, 'div', 'rx-acc')
    acc.dataset.acc = key
    acc.dataset.open = 'false'
    const value =
      key === 'playback'
        ? '<span class="rx-accv rx-on">Loop</span>'
        : '<span class="rx-accv"></span>'
    const head = el(doc, 'button', 'rx-acch', `<b>${title}</b>${value}${icon('chevron-down')}`)
    head.type = 'button'
    head.setAttribute('aria-expanded', 'false')
    head.addEventListener('click', () => openAccordion(acc.dataset.open === 'true' ? null : key))
    const body = el(doc, 'div', 'rx-accb')
    body.append(...BODIES[key])
    acc.append(head, body)
    accordions.set(key, acc)
    side.appendChild(acc)
  }

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
    const locked = [side, viewSeam, viewSpec, eqHeader, ...[...viewTrim.children].filter((n) => n !== transport && n !== seekSlot)]
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
  empty.querySelector('#rx-pick-sound').addEventListener('click', () => doc.getElementById('editor-sound-search')?.focus())

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

  // Head values ("100% · +1 st", "Off"); `on` lights the value in amber.
  const setSummaries = (map) => {
    for (const [key, [text, on]] of Object.entries(map)) {
      const span = accordions.get(key)?.querySelector('.rx-accv')
      if (!span) continue
      if (span.textContent !== text) span.textContent = text
      span.classList.toggle('rx-on', Boolean(on))
    }
  }

  return { setView, openAccordion, setPlayMode, setCompare, setSummaries, filterTargets }
}

// Called once at the end of mountSticky(): builds the top bar around the
// controls mountSticky() made and moves the transport under the Trim canvas.
export function arrangeBar(bar, root) {
  const doc = bar.ownerDocument
  const $ = (sel) => bar.querySelector(sel) || root.querySelector(sel)
  bar.classList.add('rx-bar-host')

  const left = bar.querySelector('#rx-bar-left')
  const picker = root.querySelector('.editor-picker')
  if (picker) {
    picker.classList.add('rx-pick')
    picker.insertAdjacentHTML('beforeend', icon('chevron-down'))
    left.appendChild(picker)
  }
  left.appendChild($('#editor-mix-picker-row'))

  // Sound, Group, Preset: the mock's order.
  const modeSwitch = root.querySelector('.editor-mode-switch')
  modeSwitch.classList.add('rx-seg')
  modeSwitch.setAttribute('role', 'group')
  modeSwitch.setAttribute('aria-label', 'What to edit')
  modeSwitch.append($('#editor-mode-sound'), $('#editor-mode-group'), $('#editor-mode-preset'))
  bar.querySelector('#rx-bar-center').appendChild(modeSwitch)
  // The hint under the old switch becomes the switch's tooltip.
  const hint = root.querySelector('#editor-mode-hint')
  const row = root.querySelector('.editor-mode-switch-row')
  if (hint && row) {
    hint.classList.add('rx-visually-hidden')
    modeSwitch.appendChild(hint)
    const syncTitle = () => {
      modeSwitch.title = hint.textContent
    }
    new doc.defaultView.MutationObserver(syncTitle).observe(hint, { childList: true, characterData: true, subtree: true })
    syncTitle()
    row.remove()
  }

  // Transport: under the Trim canvas, inside #editor-panel, so it hides with it.
  const transport = root.querySelector('#rx-transport')
  const liveEdit = el(doc, 'span', 'rx-lrow2')
  liveEdit.appendChild($('#editor-preview-mode-toggle'))
  const volume = $('#editor-sticky-volume')
  const volumeWrap = el(doc, 'div', 'rx-volume')
  volumeWrap.appendChild(volume)
  const syncVolume = () => volume.style.setProperty('--p', `${volume.value}%`)
  volume.addEventListener('input', syncVolume)
  syncVolume()
  transport.append($('#editor-play-pause'), $('#editor-loop-toggle'), $('#editor-sticky-solo'), $('#editor-sticky-time'), liveEdit, $('#editor-sticky-mute'), volumeWrap)
  root.querySelector('#rx-seek-slot').appendChild($('#editor-sticky-progress'))
  bar.querySelector('#rx-transport-src')?.remove()
}
