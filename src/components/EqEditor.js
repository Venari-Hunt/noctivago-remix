// Draggable-node parametric EQ editor - a scoped-down take on FL Studio's
// "Fruity Parametric EQ 2" (the reference the user showed a screenshot of,
// see noctivago_remix_eq_future memory). Band count is fully user-managed -
// a fresh/reset EQ starts blank (library.js's defaultEqBands() returns []),
// a "+" button adds a node, a trash-can button (or dragging a node onto it)
// removes the selected one (see index.js's wiring) - this reverses an
// earlier deliberate scope cut (originally a fixed 7-band set with no add/
// remove UI) after direct feedback that the fixed set felt "too crowded."
// Each band is draggable by frequency (X, log scale) and gain (Y), with Q
// adjustable via mouse wheel while hovering a node. The frequency axis can
// be zoomed in/out (buttons in index.js, or mouse wheel over empty graph
// space) for precise placement in a crowded region, and an Invert button
// flips every band's gain - both ported from Audacity's own Filter Curve EQ.

const FREQ_MIN = 20
const FREQ_MAX = 20000
const GAIN_MIN = -24
const GAIN_MAX = 24
// How much attenuation counts as "this frequency range is effectively gone"
// for the cut-overlay below - -18dB is roughly an 8x amplitude reduction,
// deep enough to read as "cut" rather than merely "quieter" without being
// all the way down at the graph's own -24dB floor (which would only flag
// the most extreme settings). A reasoned round number, not measured against
// any specific reference - there's no universal "this is inaudible" dB
// figure, since that depends on the rest of the mix and listening level.
const CUT_THRESHOLD_DB = -18
export const Q_MIN = 0.1
// Was 10 - raised per direct feedback ("Feels like nodes Q value cap at 10
// is too little"). Checked the FL Studio "Fruity Parametric EQ 2" reference
// first rather than just picking a bigger number: its own Q/bandwidth
// control isn't even the same shape as this one - a normalized 0-1 knob
// through its own internal curve, not a plain numeric Q - so there's no
// literal reference ceiling to copy. Neither BiquadFilterNode.Q nor
// ffmpeg's width_type=q have a hardcoded max either. Settled on 20 as a
// reasoned, moderate ceiling instead - a common real-world Q cap in
// professional EQs (FabFilter Pro-Q, Waves), enough headroom for genuinely
// surgical narrow-band work without drifting into a range so narrow it's
// no longer musically useful.
export const Q_MAX = 20
const HIT_PX = 14
const Q_WHEEL_STEP = 0.08
// A new node's starting point - a neutral peaking band, roughly centered on
// the graph's log-frequency axis so it's immediately visible and draggable
// regardless of what other bands already exist.
const NEW_BAND_DEFAULTS = { freqHz: 1000, gainDb: 0, q: 1, type: 'peaking', slope: 'gentle', muted: false }
// Only the four filter-*shaped* types have a real "slope" concept (how
// steeply they roll off) - peaking/shelf types are gain-shaped, not
// roll-off-shaped, and 'off' does nothing at all. Web Audio's
// BiquadFilterNode is inherently a single fixed 12dB/octave (2-pole) stage
// with no slope parameter of its own - "Steep" is achieved the same way
// ffmpeg's own cascading was verified to work (see the ranked backlog's
// slope research): chaining STEEP_STAGE_COUNT identical stages in series,
// each additional stage multiplying the rolloff by another ~12dB/octave.
// Duplicated in SoundSource.js/PreviewSource.js/loopClip.js for the usual
// cross-directory-import reason.
export const SLOPE_CAPABLE_EQ_TYPES = ['lowpass', 'highpass', 'bandpass', 'notch']
export const STEEP_STAGE_COUNT = 4

// Right-click cycles a node's type through this exact order - matches the
// precision-fields <select>'s own option order in index.js, so right-click
// and the dropdown always agree on "next". A per-type color (fill) + 1-2
// letter initial (drawn inside the node) replace the old binary selected/
// unselected coloring, so a band's shape is now readable at a glance without
// selecting it - 'off' has neither (it does nothing, stays the plain dimmed
// gray the bypassed/muted state already used). 'peaking' keeps the graph's
// original accent blue since it's the most common/default type.
const TYPE_CYCLE_ORDER = ['off', 'lowpass', 'highpass', 'bandpass', 'notch', 'lowshelf', 'highshelf', 'peaking']
const TYPE_COLORS = {
  peaking: '#7aa2f7',
  lowpass: '#2dd4bf',
  highpass: '#ef4444',
  bandpass: '#34d399',
  notch: '#fbbf24',
  lowshelf: '#a78bfa',
  highshelf: '#22d3ee'
}
const TYPE_INITIALS = {
  peaking: 'PK',
  lowpass: 'LP',
  highpass: 'HP',
  bandpass: 'BP',
  notch: 'N',
  lowshelf: 'LS',
  highshelf: 'HS'
}
const NODE_RADIUS = 9
const NODE_RADIUS_SELECTED = 11
export function eqBandStageCount(band) {
  return band.slope === 'steep' && SLOPE_CAPABLE_EQ_TYPES.includes(band.type) ? STEEP_STAGE_COUNT : 1
}
// Soft ceiling on band count - mostly a sanity guard against an accidental
// runaway (each band is a real BiquadFilterNode in the live audio graph),
// not a meaningful creative constraint; a real parametric EQ project rarely
// needs anywhere near this many bands.
const MAX_BANDS = 20
// How much a Ctrl-held drag shrinks mouse movement into parameter movement -
// matches the reference's own Ctrl+click fine-tune convention. Applied to
// the per-frame *delta*, not the absolute cursor position (see pointerMove),
// so toggling Ctrl mid-drag never causes a jump.
const FINE_TUNE_SCALE = 0.2

// Frequency-axis zoom (ported from Audacity's Filter Curve EQ, which offers
// the same zoom-in/zoom-out affordance on its own frequency axis) - the
// graph's visible window is [viewMinHz, viewMaxHz], independent per
// controller instance, defaulting to the full FREQ_MIN..FREQ_MAX span. A
// zoom step scales the *log-frequency* span (so it feels even at any zoom
// level, matching the axis's own log layout) rather than a linear Hz span.
// MIN_VIEW_OCTAVES caps how far in you can go - below ~1 octave there's not
// enough room to usefully place more than one band anyway.
const ZOOM_IN_FACTOR = 0.6
const ZOOM_OUT_FACTOR = 1 / ZOOM_IN_FACTOR
const MIN_VIEW_OCTAVES = 1

function freqToX(freqHz, width, viewMinHz = FREQ_MIN, viewMaxHz = FREQ_MAX) {
  const logMin = Math.log10(viewMinHz)
  const logMax = Math.log10(viewMaxHz)
  const t = (Math.log10(Math.max(viewMinHz, freqHz)) - logMin) / (logMax - logMin)
  return t * width
}

function xToFreq(x, width, viewMinHz = FREQ_MIN, viewMaxHz = FREQ_MAX) {
  const logMin = Math.log10(viewMinHz)
  const logMax = Math.log10(viewMaxHz)
  const t = Math.min(Math.max(x / width, 0), 1)
  return Math.pow(10, logMin + t * (logMax - logMin))
}

// A handful of round-looking frequencies spread evenly across the *current*
// zoomed window (in log space) for the vertical gridlines/labels - replaces
// the old fixed [100, 1000, 10000] set, which would often show zero ticks
// once zoomed into a narrow range that doesn't happen to contain any of
// those three. Not laboratory-precise "nice numbers" (no attempt at 1-2-5
// stepping), just rounded enough to not show ugly decimals - proportionate
// to this being a small, secondary axis label, not the graph's main content.
function niceFreqTicks(viewMinHz, viewMaxHz, count = 4) {
  const logMin = Math.log10(viewMinHz)
  const logMax = Math.log10(viewMaxHz)
  const ticks = []
  for (let i = 0; i <= count; i++) {
    const raw = Math.pow(10, logMin + ((logMax - logMin) * i) / count)
    let rounded
    if (raw >= 1000) rounded = Math.round(raw / 100) * 100
    else if (raw >= 100) rounded = Math.round(raw / 10) * 10
    else if (raw >= 20) rounded = Math.round(raw / 5) * 5
    else rounded = Math.round(raw)
    ticks.push(rounded)
  }
  return [...new Set(ticks)]
}

// GAIN_MAX maps to y=0 (top of canvas) - canvas y grows downward, dB grows
// upward, so this is deliberately inverted from a naive linear map.
function gainToY(gainDb, height) {
  const t = (gainDb - GAIN_MAX) / (GAIN_MIN - GAIN_MAX)
  return t * height
}

function yToGain(y, height) {
  const t = Math.min(Math.max(y / height, 0), 1)
  return GAIN_MAX + t * (GAIN_MIN - GAIN_MAX)
}

function formatFreqLabel(freqHz) {
  return freqHz >= 1000 ? `${freqHz / 1000}k` : String(freqHz)
}

// BUG FIX: the canvas's internal bitmap resolution (its width/height
// attributes, 640x140) and its actual rendered CSS size (getBoundingClientRect,
// ~1319x140 here since #editor-eq-canvas is styled `width: 100%`) don't
// match - the browser stretches the smaller bitmap to fill the larger CSS
// box, non-uniformly (only horizontally, in this case). Interaction math was
// already fixed to work in CSS-pixel space (see nearestBandIndex/pointerMove
// above), but drawEq was still drawing in raw bitmap-pixel space, so every
// circular node rendered as a stretched ellipse and every text label came
// out visibly distorted too - reported directly by the user ("why does it
// seem like the nodes are stretched vertically? And also the numbers").
// Fixed by resizing the canvas's actual bitmap resolution to match its
// rendered CSS size (times devicePixelRatio, for crisp non-blurry drawing on
// high-DPI displays) before every draw, then scaling the context by that
// same ratio so all the drawing code below can keep working in plain
// CSS-pixel coordinates - eliminates the stretch entirely rather than
// working around it.
function resizeCanvasForDisplay(canvas) {
  const rect = canvas.getBoundingClientRect()
  const dpr = window.devicePixelRatio || 1
  const targetWidth = Math.max(1, Math.round(rect.width * dpr))
  const targetHeight = Math.max(1, Math.round(rect.height * dpr))
  if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
    canvas.width = targetWidth
    canvas.height = targetHeight
  }
  return { width: rect.width, height: rect.height, dpr }
}

// Backdrop bars showing roughly how much energy the sound actually has
// around a handful of fixed reference frequencies (see index.js's
// loadSound(), which computes this once via a bandpass-filtered ffmpeg pass
// per frequency - src/main/ffmpeg/bandEnergy.js). A static, load-time-only
// reference - shown whenever the live spectrum below isn't (i.e. whenever
// nothing is actively playing), so there's still useful visual context
// before ever pressing Play. Drawn at FIXED positions (whatever frequencies
// were passed to setBandEnergy, independent of where the user later drags
// any EQ node) so there's no ambiguity about a bar "belonging" to a
// draggable node.
function drawBandEnergyBackdrop(ctx, width, height, freqs, energies, viewMinHz, viewMaxHz) {
  if (!freqs || !energies || freqs.length === 0) return
  const maxEnergy = Math.max(...energies, 0.0001)
  const barWidth = 28
  ctx.fillStyle = 'rgba(122, 162, 247, 0.16)'
  freqs.forEach((freqHz, i) => {
    const x = freqToX(freqHz, width, viewMinHz, viewMaxHz)
    const normalized = Math.min(1, energies[i] / maxEnergy)
    const barHeight = normalized * height * 0.92
    ctx.fillRect(x - barWidth / 2, height - barHeight, barWidth, barHeight)
  })
}

// The real, live-reacting spectrum analyzer (what the user was actually
// referencing by "the frequencies light up in pink" - the static backdrop
// above was a reasonable-looking but fundamentally different thing, a
// one-time snapshot rather than something that responds to playback).
// freqData is a Uint8Array from AnalyserNode.getByteFrequencyData() - each
// bin already dB-scaled to 0-255 by the Web Audio API itself (mapped from
// the analyser's minDecibels/maxDecibels), so no extra scaling is needed
// here for it to look perceptually reasonable, unlike a raw linear FFT
// magnitude array. Bins are linearly spaced in frequency (unlike this
// graph's log-frequency X axis) - drawn as a filled area connecting each
// bin's (freq, magnitude) point via freqToX, which naturally compresses
// many high-frequency bins into few pixels and spreads low-frequency bins
// out, same as any real log-frequency spectrum display built from a linear
// FFT. Pink/red (var(--danger) elsewhere in this app) to match the FL
// Studio reference this was modeled on.
function drawLiveSpectrum(ctx, width, height, freqData, sampleRate, viewMinHz, viewMaxHz) {
  if (!freqData) return
  const binHz = sampleRate / 2 / freqData.length
  ctx.beginPath()
  ctx.moveTo(0, height)
  for (let i = 0; i < freqData.length; i++) {
    const freqHz = (i + 0.5) * binHz
    if (freqHz < viewMinHz) continue
    if (freqHz > viewMaxHz) break
    const x = freqToX(freqHz, width, viewMinHz, viewMaxHz)
    const magnitude = freqData[i] / 255
    const y = height - magnitude * height * 0.92
    ctx.lineTo(x, y)
  }
  ctx.lineTo(width, height)
  ctx.closePath()
  ctx.fillStyle = 'rgba(247, 118, 142, 0.4)'
  ctx.fill()
}

// Shades every contiguous pixel range where the *current* composite EQ
// response drops at or below CUT_THRESHOLD_DB - a direct visual answer to
// "which frequencies is this actually about to remove," decoupled from the
// (now frozen-pre-EQ, see PreviewSource.js) live spectrum fill above it, so
// dragging a band no longer has to be inferred from a shrinking spectrum.
// Reuses the exact same responseCurve data the curve line itself is drawn
// from - no separate computation, so the two can never disagree. Full
// height (not scaled to the curve's own depth at that point) since the
// point is "this range is gone," not "by how much" - the curve line right
// on top of it already shows the precise depth for anyone who wants it.
function drawCutOverlay(ctx, width, height, responseCurve) {
  if (!responseCurve) return
  ctx.fillStyle = 'rgba(239, 68, 68, 0.16)'
  let rangeStart = -1
  for (let x = 0; x <= responseCurve.length; x++) {
    const cut = x < responseCurve.length && responseCurve[x] <= CUT_THRESHOLD_DB
    if (cut && rangeStart === -1) {
      rangeStart = x
    } else if (!cut && rangeStart !== -1) {
      ctx.fillRect(rangeStart, 0, x - rangeStart, height)
      rangeStart = -1
    }
  }
}

// A dedicated, never-rendered OfflineAudioContext used purely as a
// coefficient-computation utility - creating a real BiquadFilterNode and
// reading its own native getFrequencyResponse() is the exact response the
// live audio graph will actually produce (same browser implementation,
// zero risk of a hand-derived biquad formula subtly disagreeing with it),
// rather than re-deriving the RBJ cookbook filter math by hand. Lazily
// created once and reused - constructing an (Offline)AudioContext has real
// overhead, and this needs to run on every drag frame.
let responseContext = null
function getResponseContext() {
  if (!responseContext) responseContext = new OfflineAudioContext(1, 1, 44100)
  return responseContext
}

// The real composite frequency-response curve - requested directly after
// the straight-polyline-through-node-points version shipped ("the line
// should draw the whole segment of the frequencies it is affecting...
// start at the left edge... end at the right edge"). Each active band's own
// transfer function is evaluated across every visible frequency (one sample
// per horizontal pixel) and summed in dB - correct because the real audio
// chain connects bands in *series*, and a series/cascaded chain's combined
// transfer function is the product of each stage's own (log-domain sum).
// Bypassed bands (muted, or a different band is soloed) or 'off'-type bands
// are excluded entirely, matching the same "honest reflection of what's
// audible" the node-dimming below already does. Returns null when nothing
// is actually contributing (nothing to draw a curve for at all). A 'steep'
// band's own stage count (see eqBandStageCount) is folded in here too - the
// real live chain cascades that many identical stages in series, so the
// curve multiplies that same single stage's response by its own stage count
// (in the log domain, i.e. added that many times) to stay an honest
// reflection of the real cascaded rolloff, not just the single-stage shape.
function computeResponseCurve(bands, width, soloIndex, viewMinHz, viewMaxHz) {
  const activeBands = bands.filter((band, i) => !band.muted && band.type !== 'off' && (soloIndex === -1 || soloIndex === i))
  if (activeBands.length === 0) return null

  const sampleCount = Math.max(2, Math.round(width))
  const freqs = new Float32Array(sampleCount)
  for (let i = 0; i < sampleCount; i++) {
    freqs[i] = xToFreq((i / (sampleCount - 1)) * width, width, viewMinHz, viewMaxHz)
  }

  const context = getResponseContext()
  const totalDb = new Float32Array(sampleCount)
  const mag = new Float32Array(sampleCount)
  const phase = new Float32Array(sampleCount)
  for (const band of activeBands) {
    const node = context.createBiquadFilter()
    node.type = band.type ?? 'peaking'
    node.frequency.value = band.freqHz
    node.Q.value = band.q
    node.gain.value = band.gainDb
    node.getFrequencyResponse(freqs, mag, phase)
    const stages = eqBandStageCount(band)
    for (let i = 0; i < sampleCount; i++) {
      totalDb[i] += stages * 20 * Math.log10(Math.max(mag[i], 1e-6))
    }
  }
  return totalDb
}

function drawEq(canvas, bands, selectedIndex, bandEnergy, liveSpectrum, soloIndex, responseCurve, hoveredIndex = -1, viewMinHz = FREQ_MIN, viewMaxHz = FREQ_MAX) {
  const { width, height, dpr } = resizeCanvasForDisplay(canvas)
  const ctx = canvas.getContext('2d')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, width, height)

  ctx.font = '10px sans-serif'
  ctx.textBaseline = 'middle'

  for (const g of [-24, -12, 0, 12, 24]) {
    const y = gainToY(g, height)
    ctx.strokeStyle = g === 0 ? '#3b3f58' : 'rgba(59, 63, 88, 0.5)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(0, y)
    ctx.lineTo(width, y)
    ctx.stroke()
    ctx.fillStyle = '#8892b0'
    ctx.fillText(`${g > 0 ? '+' : ''}${g}`, 4, Math.min(Math.max(y, 8), height - 8))
  }

  for (const f of niceFreqTicks(viewMinHz, viewMaxHz)) {
    const x = freqToX(f, width, viewMinHz, viewMaxHz)
    ctx.strokeStyle = 'rgba(59, 63, 88, 0.5)'
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x, height)
    ctx.stroke()
    ctx.fillStyle = '#8892b0'
    ctx.fillText(formatFreqLabel(f), x + 3, height - 10)
  }

  // Live spectrum takes over from the static backdrop whenever it's
  // actually available (i.e. something's playing) - it's strictly more
  // informative once there's real signal to show, matching the FL Studio
  // reference behavior directly rather than leaving the static bars up
  // during playback too.
  if (liveSpectrum) drawLiveSpectrum(ctx, width, height, liveSpectrum.freqData, liveSpectrum.sampleRate, viewMinHz, viewMaxHz)
  else if (bandEnergy) drawBandEnergyBackdrop(ctx, width, height, bandEnergy.freqs, bandEnergy.energies, viewMinHz, viewMaxHz)

  drawCutOverlay(ctx, width, height, responseCurve)

  if (responseCurve) {
    ctx.strokeStyle = '#7aa2f7'
    ctx.lineWidth = 2
    ctx.beginPath()
    for (let x = 0; x < responseCurve.length; x++) {
      const gainDb = Math.min(GAIN_MAX, Math.max(GAIN_MIN, responseCurve[x]))
      const y = gainToY(gainDb, height)
      if (x === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.stroke()
  } else if (bands.length === 0) {
    ctx.fillStyle = '#8892b0'
    ctx.font = '12px sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText('Click + to add a band', width / 2, height / 2)
    ctx.textAlign = 'left'
    ctx.font = '10px sans-serif'
  }

  // A band renders dimmed whenever it's not actually contributing to the
  // sound right now - muted directly, bypassed because a *different* band is
  // soloed (soloIndex overrides every other band's own mute state for
  // audition purposes, see index.js's previewFilters()), or set to 'off'
  // (a real no-op type, not just visually excluded from the response curve
  // like before) - so the graph stays an honest reflection of what's
  // audible at a glance, without needing to select each node to check.
  // Fill color now encodes the band's own *type* (TYPE_COLORS) rather than
  // selection state, so every node's shape is readable without clicking it
  // first - selection instead shows as a bigger radius + a pink ring
  // (matching the graph's existing accent-highlight color) around the node,
  // and each node's 1-2 letter initial (TYPE_INITIALS) is drawn on top.
  bands.forEach((band, i) => {
    const type = band.type ?? 'peaking'
    const bypassed = band.muted || type === 'off' || (soloIndex !== -1 && soloIndex !== i)
    const x = freqToX(band.freqHz, width, viewMinHz, viewMaxHz)
    const y = gainToY(band.gainDb, height)
    const color = TYPE_COLORS[type] ?? TYPE_COLORS.peaking
    const isSelected = i === selectedIndex
    const radius = isSelected ? NODE_RADIUS_SELECTED : NODE_RADIUS

    // Hover bloom - a soft blurred glow behind the node, requested directly
    // ("When you hover over a node it lights up a little bit with a bloom/
    // blurred element above it"). A larger, translucent circle drawn with
    // canvas shadowBlur active gives a soft halo; the crisp node circle
    // drawn right after (with shadowBlur off) stays sharp-edged on top of it.
    if (i === hoveredIndex && !bypassed) {
      ctx.save()
      ctx.shadowColor = color
      ctx.shadowBlur = 18
      ctx.globalAlpha = 0.5
      ctx.beginPath()
      ctx.arc(x, y, radius + 2, 0, Math.PI * 2)
      ctx.fillStyle = color
      ctx.fill()
      ctx.restore()
    }

    ctx.beginPath()
    ctx.arc(x, y, radius, 0, Math.PI * 2)
    ctx.fillStyle = bypassed ? 'rgba(122, 137, 176, 0.35)' : color
    ctx.fill()
    ctx.strokeStyle = isSelected ? '#f7768e' : '#1a1b26'
    ctx.lineWidth = isSelected ? 2.5 : 1.5
    ctx.stroke()

    const initials = TYPE_INITIALS[type]
    if (initials && !bypassed) {
      ctx.fillStyle = '#1a1b26'
      ctx.font = 'bold 8px sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText(initials, x, y + 0.5)
      ctx.textAlign = 'left'
      ctx.font = '10px sans-serif'
    }
  })
}

export function createEqEditorController(canvas) {
  let bands = []
  let selectedIndex = -1
  // -1 means "no band soloed." Preview-only, per-editing-session state -
  // deliberately not part of the bands array (unlike .muted, which is a
  // real, persisted per-band setting) since soloing is an audition aid, not
  // something that should survive a save or be baked into the sound.
  let soloIndex = -1
  let dragging = false
  // "Virtual" drag position in canvas-pixel space, decoupled from the raw
  // cursor position once Ctrl fine-tune is in play (see pointerMove) - starts
  // at the node's own actual pixel position on pointerDown, then accumulates
  // scaled per-frame mouse deltas rather than tracking the cursor 1:1.
  let dragVirtualX = 0
  let dragVirtualY = 0
  let lastMouseX = 0
  let lastMouseY = 0
  let bandEnergy = null
  let liveSpectrum = null
  let freqDataBuffer = null
  // True while displaying an immutable reference (the A/B Compare "B" slot,
  // see index.js's switchEqCompareView) rather than the live editable bands
  // - every mutating interaction below early-returns while this is set, so
  // the graph stays genuinely read-only (not just "the surrounding buttons
  // happen to be disabled"). Hover-bloom stays active regardless - it's
  // just visual feedback, not a mutation.
  let readOnly = false
  // Which node the mouse is currently over, for the hover-bloom effect -
  // updated by pointerMove whenever it isn't busy dragging (see below).
  let hoveredIndex = -1
  // Registered via setTrashDropTarget (see index.js) - hit-tested in
  // pointerUp against the real button's own bounding rect, so "drag a node
  // onto the trash can" doesn't need this controller to know anything about
  // the surrounding page layout beyond one element reference.
  let trashDropTarget = null
  // The graph's own visible frequency window - see the Zoom in/out buttons
  // (index.js) and the wheel-to-zoom handler below. Defaults to the full
  // FREQ_MIN..FREQ_MAX span; reset back to that on every load() (a fresh
  // sound/preset/group, or Reset EQ) since a zoomed-in view from whatever was
  // being edited before has no reason to carry over to a different one.
  let viewMinHz = FREQ_MIN
  let viewMaxHz = FREQ_MAX
  let onChange = () => {}
  // Two distinct gestures, two distinct callbacks - deliberately split apart
  // (they used to fire the identical callback) after direct feedback: double
  // -click should be a lighter "reset just this band's position" while
  // Alt+click is the fuller reset. Same "this controller has no opinion on
  // what reset actually means" boundary as before - index.js's own
  // registrations decide what each gesture actually resets.
  let onDoubleClick = () => {}
  let onAltClick = () => {}
  // Cache for the computed response curve, keyed on whatever actually
  // affects it - avoids recomputing on every redraw() call, since
  // tickSpectrum() alone (see index.js) already triggers one on every
  // animation frame during playback purely to update the live spectrum
  // overlay, with the bands themselves usually unchanged frame to frame.
  let cachedCurveKey = null
  let cachedCurve = null

  function getResponseCurve(width) {
    const key = JSON.stringify(bands) + '|' + soloIndex + '|' + Math.round(width) + '|' + viewMinHz + '|' + viewMaxHz
    if (key !== cachedCurveKey) {
      cachedCurveKey = key
      cachedCurve = computeResponseCurve(bands, width, soloIndex, viewMinHz, viewMaxHz)
    }
    return cachedCurve
  }

  function redraw() {
    const { width } = canvas.getBoundingClientRect()
    drawEq(canvas, bands, selectedIndex, bandEnergy, liveSpectrum, soloIndex, getResponseCurve(width), hoveredIndex, viewMinHz, viewMaxHz)
  }

  // Zooms the visible frequency window in/out around centerHz (defaults to
  // the current view's own center), scaling the *log-frequency* span by
  // factor so it feels even regardless of current zoom level. Clamped to
  // MIN_VIEW_OCTAVES at the narrow end and the full FREQ_MIN..FREQ_MAX span
  // at the wide end; if the requested window would spill past either edge of
  // the full range, it's shifted (not just clipped) to stay the same width
  // and land fully inside - so zooming in near 20Hz or 20kHz doesn't produce
  // a lopsided window narrower than intended.
  function applyZoom(factor, centerHz) {
    const fullMinLog2 = Math.log2(FREQ_MIN)
    const fullMaxLog2 = Math.log2(FREQ_MAX)
    const currentOctaves = Math.log2(viewMaxHz / viewMinHz)
    const targetOctaves = Math.min(fullMaxLog2 - fullMinLog2, Math.max(MIN_VIEW_OCTAVES, currentOctaves * factor))
    const centerLog2 = centerHz != null
      ? Math.log2(Math.min(Math.max(centerHz, FREQ_MIN), FREQ_MAX))
      : (Math.log2(viewMinHz) + Math.log2(viewMaxHz)) / 2
    let newMinLog2 = centerLog2 - targetOctaves / 2
    let newMaxLog2 = centerLog2 + targetOctaves / 2
    if (newMinLog2 < fullMinLog2) {
      newMaxLog2 += fullMinLog2 - newMinLog2
      newMinLog2 = fullMinLog2
    }
    if (newMaxLog2 > fullMaxLog2) {
      newMinLog2 -= newMaxLog2 - fullMaxLog2
      newMaxLog2 = fullMaxLog2
    }
    viewMinHz = Math.pow(2, Math.max(fullMinLog2, newMinLog2))
    viewMaxHz = Math.pow(2, Math.min(fullMaxLog2, newMaxLog2))
    redraw()
  }

  // Interaction math (hit-testing, drag, wheel) works in the canvas's
  // *rendered CSS pixel* space (getBoundingClientRect), not its internal
  // bitmap resolution (canvas.width/height, used only by drawEq for actual
  // drawing) - the two differ whenever CSS stretches the canvas (here,
  // #editor-eq-canvas is `width: 100%`), exactly the same displayWidth-vs-
  // canvas.width split LoopEditor.js's xToTime/timeToX already establish.
  // Mixing the two spaces (an earlier version of this file did) makes every
  // mouse coordinate land in the wrong place relative to where nodes are
  // actually drawn - caught via a real CDP drag test before this shipped,
  // not by code review alone.
  function nearestBandIndex(x, y, width, height) {
    let best = -1
    let bestDist = Infinity
    bands.forEach((band, i) => {
      const bx = freqToX(band.freqHz, width, viewMinHz, viewMaxHz)
      const by = gainToY(band.gainDb, height)
      const dist = Math.hypot(x - bx, y - by)
      if (dist < bestDist) {
        bestDist = dist
        best = i
      }
    })
    return bestDist <= HIT_PX ? best : -1
  }

  function eventPos(evt) {
    const rect = canvas.getBoundingClientRect()
    return { x: evt.clientX - rect.left, y: evt.clientY - rect.top, width: rect.width, height: rect.height }
  }

  function pointerDown(evt) {
    if (readOnly) return
    const { x, y, width, height } = eventPos(evt)
    const idx = nearestBandIndex(x, y, width, height)
    if (idx === -1) return
    // Alt+click resets the band instead of starting a drag - the fuller
    // reset gesture (see onAltClick above), distinct from a plain
    // double-click's lighter "just the position" reset.
    if (evt.altKey) {
      selectedIndex = idx
      onAltClick(idx)
      return
    }
    selectedIndex = idx
    dragging = true
    dragVirtualX = freqToX(bands[idx].freqHz, width, viewMinHz, viewMaxHz)
    dragVirtualY = gainToY(bands[idx].gainDb, height)
    lastMouseX = x
    lastMouseY = y
    redraw()
    onChange(getBands(), selectedIndex)
  }

  // Normally 1:1 with the cursor. While Ctrl is held, the raw per-frame
  // mouse delta is shrunk by FINE_TUNE_SCALE before being applied to the
  // virtual drag position - matches the reference's own Ctrl+click
  // fine-tune convention for small, precise adjustments. Working in deltas
  // (rather than re-deriving an absolute position from the cursor every
  // frame) means holding/releasing Ctrl mid-drag never causes a jump - only
  // the scale of movement going forward changes.
  function pointerMove(evt) {
    if (!dragging || selectedIndex === -1) {
      // Not dragging - this move only ever updates hover-bloom state.
      // Bound at window level (see below, matching drag's own listener), so
      // this fires for the whole window; nearestBandIndex's own hit-radius
      // already turns "far from any node" (or off-canvas entirely) into -1.
      const { x, y, width, height } = eventPos(evt)
      const idx = nearestBandIndex(x, y, width, height)
      if (idx !== hoveredIndex) {
        hoveredIndex = idx
        redraw()
      }
      return
    }
    const { x, y, width, height } = eventPos(evt)
    const scale = evt.ctrlKey ? FINE_TUNE_SCALE : 1
    dragVirtualX = Math.min(Math.max(dragVirtualX + (x - lastMouseX) * scale, 0), width)
    dragVirtualY = Math.min(Math.max(dragVirtualY + (y - lastMouseY) * scale, 0), height)
    lastMouseX = x
    lastMouseY = y
    const band = bands[selectedIndex]
    band.freqHz = Math.round(xToFreq(dragVirtualX, width, viewMinHz, viewMaxHz))
    band.gainDb = Math.round(yToGain(dragVirtualY, height) * 10) / 10
    redraw()
    onChange(getBands(), selectedIndex)
  }

  // Dragging a node onto the registered trash target deletes it, in
  // addition to the trash button's own click-to-delete-selected path (see
  // index.js's wiring) - both trigger the identical removeSelectedBand()
  // below, since a drag always keeps the dragged node selected throughout
  // (see pointerDown). Native mouseup events already carry clientX/clientY,
  // so this signature change is safe even though pointerUp was previously
  // called with no argument used.
  function pointerUp(evt) {
    if (dragging && trashDropTarget && selectedIndex !== -1 && evt) {
      const rect = trashDropTarget.getBoundingClientRect()
      const overTrash = evt.clientX >= rect.left && evt.clientX <= rect.right && evt.clientY >= rect.top && evt.clientY <= rect.bottom
      if (overTrash) {
        dragging = false
        removeSelectedBand()
        return
      }
    }
    dragging = false
  }

  // New node lands at a fixed, neutral default position rather than
  // wherever the cursor happens to be - the request was specifically for a
  // dedicated + button, not click-anywhere-on-the-graph-to-add.
  function addBand() {
    if (readOnly || bands.length >= MAX_BANDS) return
    bands.push({ ...NEW_BAND_DEFAULTS })
    selectedIndex = bands.length - 1
    redraw()
    onChange(getBands(), selectedIndex)
  }

  // Deletes whichever band is currently selected - the one shared deletion
  // path for both the trash button's click and dragging a node onto it.
  // soloIndex needs care since it's a raw array index into bands: clear it
  // if the soloed band was the one just removed, or shift it down by one if
  // it pointed past the removed index (everything after a spliced-out
  // element shifts left by one).
  function removeSelectedBand() {
    if (readOnly || selectedIndex === -1 || !bands[selectedIndex]) return
    const removedIndex = selectedIndex
    bands.splice(removedIndex, 1)
    if (soloIndex === removedIndex) soloIndex = -1
    else if (soloIndex > removedIndex) soloIndex -= 1
    selectedIndex = -1
    redraw()
    onChange(getBands(), selectedIndex)
  }

  // Mirrors the app-wide "double-click a slider resets it to default"
  // convention (src/renderer/core/sliderReset.js) - requested directly by
  // the user for EQ nodes specifically, since they're custom canvas-drawn
  // shapes rather than real <input type="range"> elements, so that
  // delegated document-level listener can't reach them. A native `dblclick`
  // rather than manually tracking click timing - the two mousedown/mouseup
  // pairs it's built from already ran through pointerDown/pointerMove/
  // pointerUp above (possibly nudging the node very slightly from real-world
  // click jitter), but the reset below overwrites that regardless, so it
  // doesn't matter. What "default" means is intentionally left to the
  // caller (see index.js's onDoubleClick wiring) - this controller has no
  // opinion on where a band "started."
  function handleDoubleClick(evt) {
    if (readOnly) return
    const { x, y, width, height } = eventPos(evt)
    const idx = nearestBandIndex(x, y, width, height)
    if (idx === -1) return
    onDoubleClick(idx)
  }

  // Q has no natural drag axis (both X and Y are already spoken for by
  // freq/gain) - mouse wheel while hovering a node is the same convention
  // several real DAW EQ UIs use for exactly this reason. Scrolling anywhere
  // else on the graph (not over a node) zooms the frequency axis instead,
  // centered on the cursor - the same "wheel zoom centered on cursor"
  // convention LoopEditor.js's own waveform already established, so the two
  // canvases in this plugin behave consistently.
  function handleWheel(evt) {
    if (readOnly) return
    const { x, y, width, height } = eventPos(evt)
    const idx = nearestBandIndex(x, y, width, height)
    evt.preventDefault()
    if (idx === -1) {
      applyZoom(evt.deltaY < 0 ? ZOOM_IN_FACTOR : ZOOM_OUT_FACTOR, xToFreq(x, width, viewMinHz, viewMaxHz))
      return
    }
    const band = bands[idx]
    const factor = evt.deltaY < 0 ? 1 + Q_WHEEL_STEP : 1 / (1 + Q_WHEEL_STEP)
    band.q = Math.min(Q_MAX, Math.max(Q_MIN, Math.round(band.q * factor * 100) / 100))
    selectedIndex = idx
    redraw()
    onChange(getBands(), selectedIndex)
  }

  // Right-click cycles a node's type through TYPE_CYCLE_ORDER, wrapping
  // around - requested directly ("Right clicking a node on remix tab should
  // cicle it's type/mode"). Fully self-contained here (unlike Alt+click's
  // reset, which defers "what does reset mean" to index.js via a callback)
  // since cycling has no ambiguity to resolve - matches the plain-mutate-
  // then-onChange pattern pointerMove already uses for freq/gain drags.
  // Leaves band.slope untouched, same as switching type via the dropdown
  // already does - it just goes inert/hidden for a non-slope-capable type
  // rather than being reset.
  function handleContextMenu(evt) {
    if (readOnly) return
    const { x, y, width, height } = eventPos(evt)
    const idx = nearestBandIndex(x, y, width, height)
    if (idx === -1) return
    evt.preventDefault()
    const band = bands[idx]
    const currentType = TYPE_CYCLE_ORDER.indexOf(band.type ?? 'peaking')
    band.type = TYPE_CYCLE_ORDER[(currentType + 1) % TYPE_CYCLE_ORDER.length]
    selectedIndex = idx
    redraw()
    onChange(getBands(), selectedIndex)
  }

  function getBands() {
    return bands.map((b) => ({ ...b }))
  }

  // Redraws (which also re-syncs the canvas's bitmap resolution to its
  // current rendered size - see resizeCanvasForDisplay) whenever the panel's
  // own size might have changed, so the graph doesn't drift back out of
  // sync with its box after a window resize.
  function handleResize() {
    redraw()
  }

  canvas.addEventListener('mousedown', pointerDown)
  window.addEventListener('mousemove', pointerMove)
  window.addEventListener('mouseup', pointerUp)
  canvas.addEventListener('wheel', handleWheel, { passive: false })
  canvas.addEventListener('dblclick', handleDoubleClick)
  canvas.addEventListener('contextmenu', handleContextMenu)
  window.addEventListener('resize', handleResize)

  return {
    load(newBands) {
      bands = newBands.map((b) => ({ ...b }))
      selectedIndex = bands.length > 0 ? 0 : -1
      // A fresh sound's band-energy analysis hasn't arrived yet (it's an
      // async ffmpeg round-trip, see index.js's loadSound()) - clear any
      // previous sound's backdrop immediately rather than leaving it up
      // showing stale data until the new one resolves.
      bandEnergy = null
      liveSpectrum = null
      // Solo is scoped to "the arrangement currently being edited" - any
      // fresh load (a new sound, Reset EQ, an A/B Compare slot switch) is a
      // new arrangement, so carrying a stale solo forward would silently
      // keep other bands bypassed with no visible reason why.
      soloIndex = -1
      viewMinHz = FREQ_MIN
      viewMaxHz = FREQ_MAX
      redraw()
    },
    getBands,
    // freqs/energies are parallel arrays - see bandEnergy.js's
    // computeBandEnergy for where energies comes from. Passing freqs
    // alongside rather than assuming they match the current bands keeps
    // this backdrop decoupled from whatever the user has dragged nodes to.
    setBandEnergy(freqs, energies) {
      bandEnergy = freqs && energies ? { freqs, energies } : null
      redraw()
    },
    // Called once per frame from index.js's existing tickPreviewPlayhead()
    // rAF loop while the preview is actually playing - reads the live
    // AnalyserNode tapped off PreviewSource's combined output (see
    // PreviewSource.js) and redraws. Reuses a single Uint8Array across calls
    // rather than allocating a fresh one every frame.
    tickSpectrum(analyserNode) {
      if (!analyserNode) return
      if (!freqDataBuffer || freqDataBuffer.length !== analyserNode.frequencyBinCount) {
        freqDataBuffer = new Uint8Array(analyserNode.frequencyBinCount)
      }
      analyserNode.getByteFrequencyData(freqDataBuffer)
      liveSpectrum = { freqData: freqDataBuffer, sampleRate: analyserNode.context.sampleRate }
      redraw()
    },
    // Falls back to the static band-energy backdrop (if any) - called when
    // playback stops, so the graph doesn't freeze on the last live frame
    // forever.
    clearSpectrum() {
      if (!liveSpectrum) return
      liveSpectrum = null
      redraw()
    },
    getSelectedIndex() {
      return selectedIndex
    },
    getSoloIndex() {
      return soloIndex
    },
    // -1 clears solo. Setting it to an already-soloed index is a valid
    // no-op call (the toggle behavior itself lives in index.js's click
    // handler, which decides whether to pass -1 or the clicked index).
    setSoloIndex(index) {
      if (index < -1 || index >= bands.length) return
      soloIndex = index
      redraw()
    },
    setSelectedIndex(index) {
      if (index < -1 || index >= bands.length) return
      selectedIndex = index
      redraw()
    },
    // Precision entry path (numeric fields in index.js), mirrors how
    // LoopEditor's Start/End/Length text inputs complement its own
    // draggable handles - a directly-typed value updates the same band the
    // canvas drag would, then redraws so the node visibly jumps to match.
    setSelectedBand(patch) {
      if (readOnly || selectedIndex === -1 || !bands[selectedIndex]) return
      Object.assign(bands[selectedIndex], patch)
      redraw()
    },
    // Gates every mutating interaction above (drag, wheel-Q, double-click/
    // Alt+click reset, right-click type-cycle, add/remove band, precision-
    // field edits) behind a no-op while true - used while displaying the
    // A/B Compare "B" slot, which is meant to be an immutable reference
    // (see index.js's switchEqCompareView). Hover-bloom and redraw() stay
    // fully functional regardless, since those are read-only by nature.
    setReadOnly(value) {
      readOnly = value
      canvas.style.cursor = readOnly ? 'default' : ''
      redraw()
    },
    isReadOnly() {
      return readOnly
    },
    onChange(cb) {
      onChange = cb
    },
    onDoubleClick(cb) {
      onDoubleClick = cb
    },
    onAltClick(cb) {
      onAltClick = cb
    },
    addBand,
    removeSelectedBand,
    // Ported from Audacity's Filter Curve EQ, which offers the same
    // zoom-in/zoom-out affordance on its own frequency axis - useful for
    // placing a band precisely in a crowded region without every other band
    // crowding the same few pixels. Also reachable via mouse wheel over any
    // empty part of the graph (see handleWheel above).
    zoomIn() {
      applyZoom(ZOOM_IN_FACTOR)
    },
    zoomOut() {
      applyZoom(ZOOM_OUT_FACTOR)
    },
    // Flips every band's gain (boost <-> cut), same as Audacity's Filter
    // Curve EQ "Invert" - handy for turning a curve that boosts a problem
    // range into one that cuts it (or vice versa) without re-dragging every
    // node by hand. Only gainDb is touched - freq/Q/type stay put, and a
    // filter-shaped band (highpass/lowpass/etc, which has no real gain
    // effect) just carries an inverted-but-inert number, same as it already
    // does for a plain positive one.
    invertBands() {
      if (readOnly || bands.length === 0) return
      bands.forEach((band) => {
        band.gainDb = Math.round(-band.gainDb * 10) / 10
      })
      redraw()
      onChange(getBands(), selectedIndex)
    },
    // Registers the real trash-can button element for drag-to-delete
    // hit-testing (see pointerUp) - a plain setter rather than something
    // passed at construction time, since the canvas and its surrounding
    // buttons are wired up separately in index.js's mount().
    setTrashDropTarget(el) {
      trashDropTarget = el
    },
    destroy() {
      window.removeEventListener('mousemove', pointerMove)
      window.removeEventListener('mouseup', pointerUp)
      window.removeEventListener('resize', handleResize)
      canvas.removeEventListener('dblclick', handleDoubleClick)
      canvas.removeEventListener('contextmenu', handleContextMenu)
    }
  }
}
