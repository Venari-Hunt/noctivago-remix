// Desktop 2.0 layout for the Remix tab: one screen, the big view on the left,
// folded settings on the right, one bar on top. mount() and mountSticky()
// still build the controls; this file only wraps and moves those nodes, so
// every id and every listener stays as it was.
//
// Folding never uses the `hidden` class: the tab's own code toggles `hidden`
// on sections by play mode, and the two would fight. Accordions fold with
// data-open, canvas views with data-view on the panel.
import { icon } from './icons.js'
import { filterSummaries } from './filterSummary.js'
import { renderDetail } from './LibraryDetail.jsx'
import { mountAccordions } from './Accordion.jsx'
import { DRIFT_KEYS, DRIFT_AXES, SCOPE_DRIFT } from './DriftPanel.jsx'

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
// Each settings accordion leads with its icon (owner, 2026-11-16).
const ACC_ICON = {
  playback: 'play-circle',
  envelope: 'chart-line',
  speed: 'gauge',
  tone: 'sliders-horizontal',
  eq: 'equalizer',
  clean: 'broom',
  noise: 'noise',
  space: 'cube',
  'drift-vol': 'speaker-high',
  'drift-pitch': 'music-note',
  'drift-pan': 'arrows-left-right',
  looks: 'magic-wand',
  members: 'list-bullets',
  occl: 'wall'
}

const ACCORDIONS = [
  ['playback', 'Playback'],
  ['envelope', 'Volume envelope'],
  ['speed', 'Speed and pitch'],
  ['tone', 'Tone'],
  ['eq', 'Parametric EQ'],
  ['clean', 'Cleanup'],
  ['noise', 'Noise reduction'],
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

// EQ tools: EqView.jsx rendered the graph, the tools row, the band slots and
// the fields as the final markup. A/B compare and Reset are settings, so they
// sit in a spare box that is dropped here and handed back for the side column.
function pickEqTools(eq) {
  const extras = eq.querySelector('.rx-eq-extras')
  const compare = extras.querySelector('.editor-eq-compare')
  const reset = extras.querySelector(':scope > button')
  extras.remove()
  return { toolbar: eq.querySelector('.rx-eq-tools'), fields: eq.querySelector('.rx-eq-fields'), compare, reset }
}

// The settings column: one card per [key, title], the body nodes from
// bodies[key]. One card is open at a time.
function buildAccordions(side, list, bodies) {
  const win = side.ownerDocument.defaultView
  const { elements, openAccordion, setSummaries } = mountAccordions(side, list, bodies, {
    iconFor: (key) => icon(ACC_ICON[key] ?? 'sliders-horizontal'),
    chevronHtml: icon('chevron-down'),
    onOpenChange: () => requestRedraw(win)
  })
  return { accordions: elements, openAccordion, setSummaries }
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
// confusing"; approved mock-noctivago-remix-drift). DriftPanel.jsx renders the
// note and each axis as children of the section; this turns them into the
// accordion bodies, the note on top of the first.
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
// MixPanels.jsx rendered the card as final markup (canvas column, settings
// shell, the pieces of each accordion in .rx-bodies); this puts the EQ and the
// drift cards in and fills the accordions.
function arrangeScope(root, kind, getBands) {
  const doc = root.ownerDocument
  const win = doc.defaultView
  const p = `editor-mix-${kind}`
  const $ = (sel) => root.querySelector(sel)
  const host = $(kind === 'preset' ? '#editor-mix-preset-controls' : '#editor-mix-group-editor')

  // --- Left: the EQ goes under the tab row, above the loudness strip ---
  const canvasCol = host.querySelector(':scope > .rx-canvas')
  const eqCanvas = $(`#${p}-eq-canvas`)
  const eq = eqCanvas.closest('.editor-eq')
  eq.classList.add('rx-scope-eq')
  const eqTools = pickEqTools(eq)
  canvasCol.querySelector('.rx-tabs').after(eq)

  // --- Right: settings ---
  const bodyOf = (key) => [...(host.querySelector(`.rx-bodies > [data-body="${key}"]`)?.children ?? [])]
  const members = $('#editor-mix-group-members')

  const openEq = el(doc, 'button', 'rx-b', '<span>Open EQ</span>')
  openEq.type = 'button'
  openEq.title = 'Show the EQ graph on the left'
  openEq.addEventListener('click', () => eqCanvas.scrollIntoView({ block: 'nearest' }))
  const eqSide = el(doc, 'div', 'rx-srow1 rx-eq-side')
  eqSide.append(eqTools.compare, openEq, eqTools.reset)

  const drift = host.querySelector('.editor-fluctuation')
  const bodies = { tone: bodyOf('tone'), eq: [eqSide], space: bodyOf('space'), ...driftBodies(drift, SCOPE_DRIFT[kind].axes), looks: bodyOf('looks') }
  if (kind === 'group') {
    bodies.members = bodyOf('members')
    bodies.occl = bodyOf('occl')
  }

  const side = host.querySelector(':scope > .rx-side')
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

// Called once from mount(), right after the markup is written and before any
// element is looked up or wired.
export function arrangeLayout(root, { onView, onCompare, getBands, getStudio, onPick, detail } = {}) {
  const doc = root.ownerDocument
  const win = doc.defaultView
  const $ = (sel) => root.querySelector(sel)
  const panel = $('#editor-panel')

  // --- Left: the canvas column (RemixApp's SoundCanvas) ---
  const canvasCol = panel.querySelector('.rx-canvas')
  const tabs = canvasCol.querySelector('.rx-tabs')
  const viewTrim = canvasCol.querySelector('.rx-view-trim')
  const viewSeam = canvasCol.querySelector('.rx-view-seam')
  const viewEq = canvasCol.querySelector('.rx-view-eq')
  const viewSpec = canvasCol.querySelector('.rx-view-spec')

  // Looked up before anything is detached: $ only sees nodes still under root.
  const syncRow = $('#editor-sync-group-row')

  // The volume envelope has its own accordion (owner, 2026-11-11: under the
  // trim controls it was hard to find and Reset sat badly under the switch):
  // SeamView.jsx rendered its body (switch row, Reset, how-to line).
  const envelopeBody = $('.rx-envelope-body')

  // EQ view: the graph, then its tools and the selected band's fields under
  // it. A/B compare and Reset are settings, so they stay in the side column.
  const eq = $('#editor-eq-canvas').closest('.editor-eq')
  const eqTools = pickEqTools(eq)
  const eqHeader = eqTools.toolbar
  const openEq = el(doc, 'button', 'rx-b', '<span>Open EQ</span>')
  openEq.type = 'button'
  openEq.id = 'rx-open-eq'
  openEq.title = 'Show the EQ graph on the left'
  const eqSide = el(doc, 'div', 'rx-srow1 rx-eq-side')
  eqSide.append(eqTools.compare, openEq, eqTools.reset)

  // --- Right: the settings column (RemixApp's SoundSide) ---
  const side = panel.querySelector(':scope > .rx-side')

  // Playback: PlaybackPanel.jsx rendered the tiles, hints and the Random,
  // Scheduled and fade sections already (final markup).
  const tiles = $('.rx-tiles3')
  const hintRandom = $('.rx-only-random')
  const hintScheduled = $('.rx-only-scheduled')

  const loopBody = el(doc, 'div', 'rx-only-loop rx-loop-body')
  const suggestRow = $('.editor-suggest-loop-row')
  // LoopRow.jsx rendered the buttons and status line already (final markup).
  const openSeam = $('#rx-open-seam')
  loopBody.appendChild(suggestRow)

  // Random: Sync group sits with the other Random settings, after Gap.
  const scatter = $('#editor-scatter-section')
  scatter.querySelector('.editor-gap-axis').after(syncRow)
  const syncInput = syncRow.querySelector('input')
  syncRow.querySelector('span').innerHTML = `Sync group <span class="editor-fluctuation-sub">${syncInput.title.replace(' - one starts, all start.', '')}</span>`

  const schedule = $('#editor-schedule-section')
  const fade = $('#editor-fade-section')

  // Speed and pitch: SpeedPitchPanel.jsx rendered the knobs, Reverse and the hints.
  const speedPitch = $('.rx-speed-body')

  // Tone, Cleanup and Space: FilterControls.jsx renders a group into each.
  const filters = $('#editor-filters')
  const filterTargets = {}
  for (const key of ['tone', 'clean', 'noise', 'space']) {
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

  const BODIES = {
    playback: [tiles, hintRandom, hintScheduled, loopBody, scatter, schedule, fade],
    envelope: [envelopeBody],
    speed: [speedPitch],
    tone: [filterTargets.tone, filters],
    eq: [eqSide],
    clean: [filterTargets.clean],
    noise: [filterTargets.noise],
    space: [filterTargets.space],
    looks: [looks, resetFilters],
    ...driftBodies(driftSection, DRIFT_AXES)
  }
  const { accordions, openAccordion, setSummaries } = buildAccordions(side, ACCORDIONS, BODIES)
  setSummaries({ playback: ['Loop', true] })

  panel.replaceChildren(canvasCol, side)
  openAccordion('playback')

  // --- Views ---
  const setView = (view) => {
    if (panel.dataset.view === view) return
    panel.dataset.view = view
    for (const btn of tabs.querySelectorAll('[data-rx-view]')) btn.setAttribute('aria-pressed', String(btn.dataset.rxView === view))
    // The Repair view's own settings: its Noise reduction card opens with it.
    if (view === 'spec') openAccordion('noise')
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
  const setPlayMode = (mode) => {
    setSummaries({ playback: [MODE_LABEL[mode] ?? MODE_LABEL.loop, true] })
    // The Loop seam view only exists for loops (its tab hides in CSS).
    if ((mode === 'scatter' || mode === 'scheduled') && panel.dataset.view === 'seam') setView('trim')
  }

  // Group and Preset get the same canvas + settings layout.
  const scopes = { preset: arrangeScope(root, 'preset', getBands), group: arrangeScope(root, 'group', getBands) }
  const refreshScopes = () => {
    scopes.preset.refresh()
    scopes.group.refresh()
  }

  const studio = buildStudio(root, { getStudio, onPick, detail })

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

function buildStudio(root, { getStudio, onPick, detail }) {
  const doc = root.ownerDocument
  const win = doc.defaultView
  const tab = root.querySelector('.editor-tab')

  // The panes are RemixApp markup (StudioLeft, StudioHead); this wires them.
  const lib = tab.querySelector('.rx-lib')
  const prev = tab.querySelector('.rx-prev')
  const head = tab.querySelector('.rx-head')
  const holder = tab.querySelector('.rx-holder')

  // Below 1180 px the library slides over the editor from the left and the
  // preview module moves under the canvas (styles.css "Small windows"). The
  // library starts hidden there, comes back when the window grows past it,
  // and closes on Esc, on a click outside it, and after a sound is picked.
  const narrow = win.matchMedia?.('(max-width: 1179px)')
  // In the one-column layout the tab scrolls, so the drawer is fixed to the
  // visible part of the tab's scroll area; these vars place it there.
  const placeDrawer = () => {
    const box = (tab.closest('main') ?? tab).getBoundingClientRect()
    tab.style.setProperty('--rx-drawer-top', box.top + 8 + 'px')
    tab.style.setProperty('--rx-drawer-bottom', Math.max(0, win.innerHeight - box.bottom) + 8 + 'px')
    tab.style.setProperty('--rx-drawer-left', box.left + 8 + 'px')
  }
  win.addEventListener('resize', () => isDrawer() && placeDrawer())
  const setLib = (open, focus = false) => {
    if (open) placeDrawer()
    tab.dataset.rxLib = open ? 'on' : 'off'
    if (focus) doc.getElementById(open ? 'rx-lib-search' : 'rx-lib-show')?.focus()
  }
  const isDrawer = () => Boolean(narrow?.matches) && tab.dataset.rxLib === 'on'
  setLib(!narrow?.matches)
  narrow?.addEventListener('change', () => setLib(!narrow.matches))
  head.querySelector('#rx-lib-show').addEventListener('click', () => setLib(true, true))
  lib.querySelector('#rx-lib-hide').addEventListener('click', () => setLib(false, true))
  tab.addEventListener('pointerdown', (evt) => {
    if (isDrawer() && !lib.contains(evt.target)) setLib(false)
  })
  // Capture: the search clears itself on Esc first; a filled search keeps the drawer.
  lib.addEventListener('keydown', (evt) => {
    if (evt.key === 'Escape' && isDrawer() && !evt.target.value) setLib(false, true)
  }, true)
  // The empty state hides the head (and its chevron): Pick a sound opens the drawer.
  doc.getElementById('rx-pick-sound')?.addEventListener('click', () => {
    if (narrow?.matches) setLib(true, true)
  })
  const closeAfterPick = (mode) => {
    if (isDrawer() && mode === 'sound') setLib(false)
  }

  // Below 860 the canvas fills the tab, the preview module gets its own row
  // under it, and Settings slide in from the right like the library does from
  // the left (owner, 2026-11-21). Opening one drawer closes the other; Esc, a
  // click outside, or growing past 860 closes it. The settings column is
  // rebuilt per sound or group, so it is looked up on every use.
  const xs = win.matchMedia?.('(max-width: 859px)')
  const sideShow = head.querySelector('#rx-side-show')
  // The sound and the group editor each have a settings column; use the one not hidden.
  const sideOf = () => [...tab.querySelectorAll('.rx-side')].find((n) => !n.closest('.hidden')) ?? null
  const isSideDrawer = () => Boolean(xs?.matches) && tab.dataset.rxSide === 'on'
  const setSide = (open, focus = false) => {
    if (open) {
      placeDrawer()
      const box = (tab.closest('main') ?? tab).getBoundingClientRect()
      tab.style.setProperty('--rx-drawer-right', Math.max(0, win.innerWidth - box.right) + 8 + 'px')
      if (isDrawer()) setLib(false)
    }
    tab.dataset.rxSide = open ? 'on' : 'off'
    sideShow.setAttribute('aria-expanded', String(open))
    if (focus) (open ? sideOf()?.querySelector('.rx-side-hide') : sideShow)?.focus()
  }
  setSide(false)
  xs?.addEventListener('change', () => setSide(false))
  sideShow.addEventListener('click', () => setSide(tab.dataset.rxSide !== 'on', true))
  head.querySelector('#rx-lib-show').addEventListener('click', () => isSideDrawer() && setSide(false))
  tab.addEventListener('click', (evt) => {
    if (evt.target.closest?.('.rx-side-hide')) setSide(false, true)
  })
  tab.addEventListener('pointerdown', (evt) => {
    if (isSideDrawer() && !sideOf()?.contains(evt.target) && !sideShow.contains(evt.target)) setSide(false)
  })
  tab.addEventListener('keydown', (evt) => {
    if (evt.key === 'Escape' && isSideDrawer() && sideOf()?.contains(evt.target)) setSide(false, true)
  })
  win.addEventListener('resize', () => isSideDrawer() && setSide(true))

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
    preview: (key) => detail.preview(key),
    loop: (id) => detail.loop(id),
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
    const previewKey = detail?.rowStatus?.().previewKey ?? null
    const key = JSON.stringify([state?.mode, state?.currentId, highlight, items, previewKey])
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
        closeAfterPick(state.mode)
      })
      if (state.mode !== 'sound' && detail) b.insertAdjacentHTML('beforeend', `<span class="rx-chev">${icon('chevron-right')}</span>`)
      // Group mode: Play before each group previews it as a group (mock .iw).
      if (state.mode === 'group' && detail?.preview) {
        const gk = 'g:' + it.id
        const on = previewKey === gk
        const w = el(doc, 'div', 'rx-iw' + (on ? ' rx-iw-playing' : ''))
        w.dataset.key = gk
        const pv = el(doc, 'button', 'rx-i rx-dib rx-mpv', icon(on ? 'square' : 'play'))
        pv.type = 'button'
        pv.title = on ? 'Stop ' + it.name : 'Play ' + it.name + ' as a group'
        pv.setAttribute('aria-label', (on ? 'Stop ' : 'Play ') + it.name)
        pv.addEventListener('click', () => detail.preview(gk))
        w.append(pv, b)
        list.appendChild(w)
        return
      }
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
      if (picked) {
        onPick?.(state.mode, picked.id)
        closeAfterPick(state.mode)
      }
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

// Called once at the end of mountSticky(): wires the controls RemixApp renders
// in the studio panes (Play, volumes, Undo, Save, the pickers). Nothing is
// left in the app's sticky bar, so it is hidden while Remix shows.
export function arrangeBar(bar, root) {
  const doc = bar.ownerDocument
  const win = doc.defaultView
  const $ = (sel) => root.querySelector(sel)
  bar.classList.add('rx-bar-host')
  const tab = root.querySelector('.editor-tab')
  const holder = tab.querySelector('.rx-holder')

  // The old search-and-dropdown picker: the library list replaces it.
  const picker = root.querySelector('.editor-picker')
  if (picker) holder.appendChild(picker)

  // The chips carry the hint as their tooltip.
  const chips = tab.querySelector('#rx-chips')
  const hint = root.querySelector('#editor-mode-hint')
  const syncTitle = () => {
    chips.title = hint.textContent
  }
  new win.MutationObserver(syncTitle).observe(hint, { childList: true, characterData: true, subtree: true })
  syncTitle()

  // New group sits by the library title in every mode, as in the mock; from
  // Sound or Preset it opens Group first.
  const newGroup = $('#editor-mix-group-new')
  tab.querySelector('#rx-new-group').addEventListener('click', () => {
    if (!$('#editor-mode-group').classList.contains('editor-mode-pill-active')) $('#editor-mode-group').click()
    win.setTimeout(() => newGroup.click(), 0)
  })

  // The preview module's time readout feeds the seek row's two labels.
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

  const volume = $('#editor-sticky-volume')
  const syncVolume = () => volume.style.setProperty('--p', `${volume.value}%`)
  volume.addEventListener('input', syncVolume)
  syncVolume()
}
