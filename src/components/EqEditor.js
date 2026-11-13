import { icon } from './icons.js'
import { eqMenuIcon } from './eqMenuIcons.js'
import { PALETTE, withAlpha } from '../domain/palette.js'
import { EQ_MAX_BANDS, EMPTY_SLOT, qWhenTypeChanges, isEmptySlot, padEqSlots, compactEqSlots, freeSlotIndex } from '../domain/eqSlots.js'
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
// Where the red cut overlay starts: the graph's own floor (owner, 2026-11-13: it
// used to start at -18 dB, short of where the line reaches the bottom, so the
// box began before the curve looked cut). A filter slope never reaches zero, so
// the floor is the one honest place to call a range "gone".
const CUT_THRESHOLD_DB = GAIN_MIN
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
// LYNX-style handles (owner, 2026-11-11): 12 px grab radius.
const HIT_PX = 12
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

// A per-type color (fill) + 1-2
// letter initial (drawn inside the node) replace the old binary selected/
// unselected coloring, so a band's shape is now readable at a glance without
// selecting it - 'off' has neither (it does nothing, stays the plain dimmed
// gray the bypassed/muted state already used). 'peaking' keeps the graph's
// app's accent color since it's the most common/default type.
const TYPE_COLORS = {
  peaking: PALETTE.accent,
  lowpass: '#2dd4bf',
  highpass: '#ef4444',
  bandpass: '#34d399',
  notch: '#fb923c',
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
// Where a band's handle sits (owner, 2026-11-11): on the band's real point.
// Peak and shelves at their gain; cuts, band pass and notch have no gain
// (the biquad ignores it), so their handle rides the 0 dB line.
const GAINLESS_EQ_TYPES = ['lowpass', 'highpass', 'bandpass', 'notch', 'off']
export function handleGainDb(band) {
  return GAINLESS_EQ_TYPES.includes(band.type ?? 'peaking') ? 0 : band.gainDb
}
export const EQ_TYPE_LABELS = {
  peaking: 'Peak',
  lowshelf: 'Low shelf',
  highshelf: 'High shelf',
  highpass: 'Low cut (high pass)',
  lowpass: 'High cut (low pass)',
  bandpass: 'Band pass',
  notch: 'Notch'
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
const MAX_BANDS = EQ_MAX_BANDS
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
  ctx.fillStyle = withAlpha(PALETTE.accent, 0.16)
  freqs.forEach((freqHz, i) => {
    const x = freqToX(freqHz, width, viewMinHz, viewMaxHz)
    const normalized = Math.min(1, energies[i] / maxEnergy)
    const barHeight = normalized * height * 0.92
    ctx.fillRect(x - barWidth / 2, height - barHeight, barWidth, barHeight)
  })
}

// The live spectrum (step 13a: sharper and easier to read, owner 2026-11-05,
// "as good as FL Studio's Parametric EQ 2"). Written from standard analyser
// technique, nothing copied:
// - tickSpectrum() reads float dB per FFT bin and runs per-bin ballistics:
//   a louder frame jumps straight up, a quieter one falls at
//   SPECTRUM_FALL_DB_PER_S, so peaks stay readable instead of flickering.
// - Here, each pixel column takes the PEAK of the bins that land in it (the
//   highs, where many bins share a column), or interpolates between the two
//   nearest bins (the lows, where one bin spans many columns). Plotting raw
//   bins drew a jagged comb at the top and a staircase at the bottom.
// - A tilt of SPECTRUM_TILT_DB_PER_OCT around 1 kHz, since real sounds lose
//   energy toward the highs; without it the treble looks dead even when
//   it is clearly audible.
const SPECTRUM_FALL_DB_PER_S = 36
const SPECTRUM_TILT_DB_PER_OCT = 4.5
const SPECTRUM_TILT_PIVOT_HZ = 1000
const SPECTRUM_FLOOR_DB = -96
const SPECTRUM_CEIL_DB = -12

// reduce: 'peak' for the live line (step 13a), 'mean' (power average) for
// the heatmap - a peak over the many bins of a treble column inflates steady
// hiss by several dB, which read as solid amber across the highs.
export function spectrumColumns(width, binDb, sampleRate, viewMinHz, viewMaxHz, reduce = 'peak') {
  const binCount = binDb.length
  const binHz = sampleRate / 2 / binCount
  const cols = Math.max(1, Math.round(width))
  const out = new Float32Array(cols)
  for (let x = 0; x < cols; x++) {
    const loHz = xToFreq(x, cols, viewMinHz, viewMaxHz)
    const hiHz = xToFreq(x + 1, cols, viewMinHz, viewMaxHz)
    const centerHz = Math.sqrt(loHz * hiHz)
    // bin i covers frequency i * binHz (bin 0 = DC)
    const lo = Math.ceil(loHz / binHz)
    const hi = Math.min(binCount - 1, Math.floor(hiHz / binHz))
    let db
    if (hi >= lo) {
      if (reduce === 'mean') {
        let power = 0
        for (let i = lo; i <= hi; i++) power += Math.pow(10, binDb[i] / 10)
        db = 10 * Math.log10(power / (hi - lo + 1) || 1e-30)
      } else {
        db = -Infinity
        for (let i = lo; i <= hi; i++) if (binDb[i] > db) db = binDb[i]
      }
    } else {
      const pos = centerHz / binHz
      const i0 = Math.min(binCount - 1, Math.max(1, Math.floor(pos)))
      const i1 = Math.min(binCount - 1, i0 + 1)
      const t = Math.min(1, Math.max(0, pos - i0))
      db = binDb[i0] + (binDb[i1] - binDb[i0]) * t
    }
    out[x] = db + SPECTRUM_TILT_DB_PER_OCT * Math.log2(centerHz / SPECTRUM_TILT_PIVOT_HZ)
  }
  return out
}

// Step 13b: the heatmap (mock screen remix-eq). Each frequency column glows
// with its LONG-TERM level, so where a sound lives reads at a glance even
// between bursts. The level is the live held spectrum smoothed per bin at
// HEAT_RATE_PER_S, about a 1 s time constant: slow enough that rain does not
// swing with every gust, fast enough that an EQ edit shows within a second
// (the old 0.25/s, ~4 s, made edits look like they did nothing; owner,
// 2026-11-11). Colors and the curve that spreads them are the mock's
// heatColor: After (post-EQ) runs warm, near black, violet, red, then the
// app's amber; Before (pre-EQ) runs cold, slate to pale blue, so the two
// never read as the same picture.
const HEAT_RATE_PER_S = 1
const HEAT_BLUR_PX = 4
const HEAT_STOPS = [[15, 15, 17], [46, 22, 70], [132, 34, 72], [205, 72, 52], [224, 184, 76]]
export const HEAT_STOPS_BEFORE = [[15, 15, 17], [24, 32, 50], [42, 70, 104], [92, 130, 166], [184, 208, 228]]
export const SPECTRUM_MODES = ['spectrum', 'both', 'heat']
const SPECTRUM_MODE_KEY = 'noctivago-remix.spectrumMode'
// Step 13c: which signal the spectrum reads (Pro-Q's Pre / Post / Pre+Post).
export const TAP_MODES = ['before', 'after', 'both']
const TAP_MODE_KEY = 'noctivago-remix.spectrumTap'

export function heatColor(h, stops = HEAT_STOPS) {
  const p = Math.max(0, Math.min(0.999, h)) * 4
  const i = Math.floor(p)
  const f = p - i
  const a = stops[i]
  const b = stops[i + 1]
  return `rgb(${a.map((n, k) => Math.round(n + (b[k] - n) * f)).join(',')})`
}

// Tilted dB -> heat color position, relative to a top level maxDb: that
// reads amber, HEAT_RANGE_DB below it near black. Real sounds sit far below
// the mock's simulated levels, so an absolute scale left the whole graph one
// dark violet. The middle goes through the mock's own curve.
// The top is the loudest column of the BEFORE (pre-EQ) heat plus
// HEAT_HEADROOM_DB, so it does not move when the EQ changes: a boost on the
// loudest area climbs toward amber and a cut darkens. Scaling to the shown
// signal's own loudest column (the old way) re-normalized every edit away.
const HEAT_RANGE_DB = 30
export const HEAT_HEADROOM_DB = 6
export function heatLevel(db, maxDb) {
  const rel = Math.min(1, Math.max(0, 1 - (maxDb - db) / HEAT_RANGE_DB))
  const v = 0.22 + 0.62 * rel
  const h = Math.max(0, v - 0.22) / 0.62
  return h * h * 1.1 + 0.08
}

// Heat bins -> blurred pixel columns. A soft blur across neighbor columns
// (HEAT_BLUR_PX each side): the heat is a picture of where the sound lives,
// not bin-by-bin noise, which drew hard vertical stripes.
export function heatColumns(width, heatDb, sampleRate, viewMinHz, viewMaxHz) {
  const raw = spectrumColumns(width, heatDb, sampleRate, viewMinHz, viewMaxHz, 'mean')
  const cols = new Float32Array(raw.length)
  for (let x = 0; x < raw.length; x++) {
    let sum = 0
    let n = 0
    for (let k = Math.max(0, x - HEAT_BLUR_PX); k <= Math.min(raw.length - 1, x + HEAT_BLUR_PX); k++) { sum += raw[k]; n++ }
    cols[x] = sum / n
  }
  return cols
}

// The heat top: loudest reference column plus headroom (see heatLevel).
// refCols is the Before heat; without one (no pre tap) the shown heat is
// its own reference.
export function heatTopDb(cols, refCols = null) {
  const src = refCols ?? cols
  let maxDb = -Infinity
  for (let x = 0; x < src.length; x++) if (src[x] > maxDb) maxDb = src[x]
  return maxDb + HEAT_HEADROOM_DB
}

function drawHeatmap(ctx, width, height, heat, viewMinHz, viewMaxHz) {
  const cols = heatColumns(width, heat.binDb, heat.sampleRate, viewMinHz, viewMaxHz)
  const refCols = heat.refBinDb ? heatColumns(width, heat.refBinDb, heat.sampleRate, viewMinHz, viewMaxHz) : null
  const topDb = heatTopDb(cols, refCols)
  const stops = heat.before ? HEAT_STOPS_BEFORE : HEAT_STOPS
  for (let x = 0; x < cols.length; x++) {
    ctx.fillStyle = heatColor(heatLevel(cols[x], topDb), stops)
    ctx.fillRect(x, 0, 1.5, height)
  }
}

// Rulers above the graph (owner, 2026-11-10): the named ranges from SUB to
// TREBLE (the usual mixing-guide split) and the C of every octave, both
// following the graph's zoom.
export const RULER_RANGES = [
  ['SUB', 20, 60], ['BASS', 60, 250], ['LOW MID', 250, 500], ['MID', 500, 2000],
  ['HIGH MID', 2000, 4000], ['PRESENCE', 4000, 6000], ['TREBLE', 6000, 20000]
]
// C0 = 16.35 Hz (A4 = 440 Hz). Returns [label, hz] for each C in the window.
export function noteTicks(viewMinHz, viewMaxHz) {
  const out = []
  for (let octave = 0; octave <= 10; octave++) {
    const hz = 440 * Math.pow(2, (octave * 12 - 57) / 12)
    if (hz >= viewMinHz && hz <= viewMaxHz) out.push([`C${octave}`, hz])
  }
  return out
}

function drawRulers(canvas, viewMinHz, viewMaxHz) {
  const { width, height, dpr } = resizeCanvasForDisplay(canvas)
  const ctx = canvas.getContext('2d')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, width, height)
  ctx.font = '11px "Segoe UI", sans-serif'
  ctx.textBaseline = 'middle'
  const row = height / 2
  // Row 1: named ranges, a divider at each inner edge, the name centered in
  // the visible part of the range (dropped when it does not fit).
  ctx.strokeStyle = PALETTE.border
  ctx.lineWidth = 1
  for (const [name, lo, hi] of RULER_RANGES) {
    if (hi <= viewMinHz || lo >= viewMaxHz) continue
    const x0 = Math.max(0, freqToX(lo, width, viewMinHz, viewMaxHz))
    const x1 = Math.min(width, freqToX(Math.min(hi, viewMaxHz), width, viewMinHz, viewMaxHz))
    if (lo > viewMinHz) {
      ctx.beginPath()
      ctx.moveTo(Math.round(x0) + 0.5, 3)
      ctx.lineTo(Math.round(x0) + 0.5, row - 3)
      ctx.stroke()
    }
    if (x1 - x0 < ctx.measureText(name).width + 8) continue
    ctx.fillStyle = PALETTE.textDim
    ctx.textAlign = 'center'
    ctx.fillText(name, (x0 + x1) / 2, row / 2)
  }
  // Row 2: a tick and label at each C.
  ctx.textAlign = 'left'
  for (const [label, hz] of noteTicks(viewMinHz, viewMaxHz)) {
    const x = Math.round(freqToX(hz, width, viewMinHz, viewMaxHz)) + 0.5
    ctx.beginPath()
    ctx.moveTo(x, row + 3)
    ctx.lineTo(x, height - 3)
    ctx.stroke()
    if (x + 3 + ctx.measureText(label).width > width) continue // no clipped label at the edge
    ctx.fillStyle = PALETTE.textDim
    ctx.fillText(label, x + 3, row + row / 2)
  }
}

function drawLiveSpectrum(ctx, width, height, binDb, sampleRate, viewMinHz, viewMaxHz, overHeat = false, dim = false) {
  if (!binDb) return
  const cols = spectrumColumns(width, binDb, sampleRate, viewMinHz, viewMaxHz)
  const top = height * 0.92
  const yOf = (db) => {
    const t = (db - SPECTRUM_FLOOR_DB) / (SPECTRUM_CEIL_DB - SPECTRUM_FLOOR_DB)
    return height - Math.min(1, Math.max(0, t)) * top
  }
  ctx.beginPath()
  ctx.moveTo(0, height)
  for (let x = 0; x < cols.length; x++) ctx.lineTo(x + 0.5, yOf(cols[x]))
  ctx.lineTo(width, height)
  ctx.closePath()
  // Over the heatmap the line is the mock's ink (pink over red would vanish);
  // alone it keeps step 13a's pink. Dim (step 13c, Before under After in
  // Both): a faint gray outline, so the EQ's change reads as the gap.
  if (dim) {
    ctx.fillStyle = 'rgba(236, 233, 226, 0.05)'
  } else if (overHeat) {
    ctx.fillStyle = 'rgba(236, 233, 226, 0.1)'
  } else {
    const fill = ctx.createLinearGradient(0, height - top, 0, height)
    fill.addColorStop(0, 'rgba(247, 118, 142, 0.42)')
    fill.addColorStop(1, 'rgba(247, 118, 142, 0.08)')
    ctx.fillStyle = fill
  }
  ctx.fill()
  // A crisp outline on top: the edge is what the eye reads, the fill only
  // gives it weight.
  ctx.beginPath()
  for (let x = 0; x < cols.length; x++) {
    const y = yOf(cols[x])
    if (x === 0) ctx.moveTo(x + 0.5, y)
    else ctx.lineTo(x + 0.5, y)
  }
  ctx.strokeStyle = dim ? 'rgba(236, 233, 226, 0.32)' : overHeat ? 'rgba(236, 233, 226, 0.5)' : 'rgba(247, 118, 142, 0.95)'
  ctx.lineWidth = dim || overHeat ? 1 : 1.25
  ctx.lineJoin = 'round'
  ctx.stroke()
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
  const activeBands = bands
    .map((band, index) => ({ band, index }))
    .filter(({ band, index }) => !band.muted && band.type !== 'off' && (soloIndex === -1 || soloIndex === index))
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
  // Each band's own curve too (owner, 2026-11-11): the graph fills every
  // band's shape in its color, so a node visibly pulls its part of the curve.
  const perBand = []
  for (const { band, index } of activeBands) {
    const node = context.createBiquadFilter()
    node.type = band.type ?? 'peaking'
    node.frequency.value = band.freqHz
    node.Q.value = band.q
    node.gain.value = band.gainDb
    node.getFrequencyResponse(freqs, mag, phase)
    const stages = eqBandStageCount(band)
    const own = new Float32Array(sampleCount)
    for (let i = 0; i < sampleCount; i++) {
      own[i] = stages * 20 * Math.log10(Math.max(mag[i], 1e-6))
      totalDb[i] += own[i]
    }
    perBand.push({ index, type: band.type ?? 'peaking', db: own })
  }
  return { total: totalDb, perBand }
}

// One band's shape: filled between its curve and the 0 dB line.
function bandPath(ctx, db, height) {
  const zero = gainToY(0, height)
  ctx.beginPath()
  ctx.moveTo(0, zero)
  for (let x = 0; x < db.length; x++) ctx.lineTo(x, gainToY(Math.min(GAIN_MAX, Math.max(GAIN_MIN, db[x])), height))
  ctx.lineTo(db.length - 1, zero)
  ctx.closePath()
}

function strokeCurve(ctx, db, height, color, lineWidth) {
  ctx.strokeStyle = color
  ctx.lineWidth = lineWidth
  ctx.beginPath()
  for (let x = 0; x < db.length; x++) {
    const y = gainToY(Math.min(GAIN_MAX, Math.max(GAIN_MIN, db[x])), height)
    if (x === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.stroke()
}

function drawEq(canvas, bands, selectedIndex, bandEnergy, liveSpectrum, soloIndex, responseCurve, hoveredIndex = -1, viewMinHz = FREQ_MIN, viewMaxHz = FREQ_MAX, display = {}) {
  const { width, height, dpr } = resizeCanvasForDisplay(canvas)
  const ctx = canvas.getContext('2d')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, width, height)
  const mode = display.mode ?? 'both'
  // The heatmap is the graph's background, so grid and labels sit on it.
  const showHeat = mode !== 'spectrum' && display.heat
  if (showHeat) drawHeatmap(ctx, width, height, display.heat, viewMinHz, viewMaxHz)

  ctx.font = '11px "Segoe UI", sans-serif' // mock axis labels
  ctx.textBaseline = 'middle'

  for (const g of [-24, -12, 0, 12, 24]) {
    const y = gainToY(g, height)
    ctx.strokeStyle = g === 0 ? PALETTE.border : withAlpha(PALETTE.border, 0.5)
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(0, y)
    ctx.lineTo(width, y)
    ctx.stroke()
    ctx.fillStyle = PALETTE.textDim
    ctx.fillText(`${g > 0 ? '+' : ''}${g}`, 4, Math.min(Math.max(y, 8), height - 8))
  }

  for (const f of niceFreqTicks(viewMinHz, viewMaxHz)) {
    const x = freqToX(f, width, viewMinHz, viewMaxHz)
    ctx.strokeStyle = withAlpha(PALETTE.border, 0.5)
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x, height)
    ctx.stroke()
    ctx.fillStyle = PALETTE.textDim
    ctx.fillText(formatFreqLabel(f), x + 3, height - 10)
  }

  // Live spectrum takes over from the static backdrop whenever it's
  // actually available (i.e. something's playing) - it's strictly more
  // informative once there's real signal to show, matching the FL Studio
  // reference behavior directly rather than leaving the static bars up
  // during playback too.
  if (liveSpectrum) {
    if (mode !== 'heat') {
      const { binDb, preBinDb, sampleRate } = liveSpectrum
      const tap = preBinDb ? (display.tap ?? 'after') : 'after'
      const draw = (db, dim) => drawLiveSpectrum(ctx, width, height, db, sampleRate, viewMinHz, viewMaxHz, Boolean(showHeat), dim)
      if (tap === 'before') draw(preBinDb, false)
      else {
        if (tap === 'both') draw(preBinDb, true)
        draw(binDb, false)
      }
    }
  } else if (showHeat) {
    // stopped: the heatmap stays as the last long-term picture of the sound
  } else if (bandEnergy) drawBandEnergyBackdrop(ctx, width, height, bandEnergy.freqs, bandEnergy.energies, viewMinHz, viewMaxHz)

  drawCutOverlay(ctx, width, height, responseCurve?.total)

  if (responseCurve) {
    // Every band's shape in its color, the highlighted band's own curve in
    // its color, then the composite on top (LYNX look, owner 2026-11-11).
    const lit = hoveredIndex !== -1 ? hoveredIndex : selectedIndex
    for (const curve of responseCurve.perBand) {
      const color = TYPE_COLORS[curve.type] ?? TYPE_COLORS.peaking
      bandPath(ctx, curve.db, height)
      ctx.fillStyle = withAlpha(color, curve.index === lit ? 0.26 : 0.12)
      ctx.fill()
    }
    const litCurve = responseCurve.perBand.find((c) => c.index === lit)
    if (litCurve && responseCurve.perBand.length > 1) strokeCurve(ctx, litCurve.db, height, TYPE_COLORS[litCurve.type] ?? TYPE_COLORS.peaking, 1.5)
    strokeCurve(ctx, responseCurve.total, height, PALETTE.text, 2)
  } else if (bands.every(isEmptySlot)) {
    ctx.fillStyle = PALETTE.textDim
    ctx.font = '12px sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText('Double-click to add a band', width / 2, height / 2)
    ctx.textAlign = 'left'
    ctx.font = '11px "Segoe UI", sans-serif' // mock axis labels
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
    if (isEmptySlot(band)) return // an unused slot has no node on the graph
    const type = band.type ?? 'peaking'
    const bypassed = band.muted || type === 'off' || (soloIndex !== -1 && soloIndex !== i)
    const x = freqToX(band.freqHz, width, viewMinHz, viewMaxHz)
    const y = gainToY(handleGainDb(band), height)
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
    ctx.fillStyle = bypassed ? withAlpha(PALETTE.textDim, 0.35) : color
    ctx.fill()
    ctx.strokeStyle = isSelected ? PALETTE.danger : PALETTE.surface
    ctx.lineWidth = isSelected ? 2.5 : 1.5
    ctx.stroke()

    const initials = TYPE_INITIALS[type]
    if (initials && !bypassed) {
      ctx.fillStyle = PALETTE.surface
      ctx.font = 'bold 8px sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText(initials, x, y + 0.5)
      ctx.textAlign = 'left'
      ctx.font = '11px "Segoe UI", sans-serif' // mock axis labels
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
  let rawDbBuffer = null
  let heldDb = null
  let heldPreDb = null
  let lastSpectrumTick = 0
  // Step 13b: per-bin long-term level for the heatmap, kept after playback
  // stops (it is the sound's picture), cleared when a new sound loads.
  let heatDb = null
  let heatPreDb = null
  let heatSampleRate = 48000
  let spectrumMode = 'both'
  try {
    const saved = window.localStorage.getItem(SPECTRUM_MODE_KEY)
    if (SPECTRUM_MODES.includes(saved)) spectrumMode = saved
  } catch {}
  // Layout (layout.js) runs before this controller is made and puts the
  // ruler canvas and the Spectrum / Both / Heatmap switch next to the graph.
  const eqRoot = canvas.closest('.editor-eq')
  const rulerCanvas = eqRoot?.querySelector('.rx-eq-ruler') ?? null
  const modeButtons = eqRoot ? [...eqRoot.querySelectorAll('[data-spec]')] : []
  function showMode() {
    for (const b of modeButtons) b.setAttribute('aria-pressed', String(b.dataset.spec === spectrumMode))
  }
  for (const b of modeButtons) {
    b.addEventListener('click', () => {
      spectrumMode = b.dataset.spec
      try { window.localStorage.setItem(SPECTRUM_MODE_KEY, spectrumMode) } catch {}
      showMode()
      redraw()
    })
  }
  showMode()
  // Step 13c: Before / After / Both. Saved audio has only After (the clip
  // has the EQ baked in): Before and Both are disabled while it plays.
  let tapMode = 'after'
  try {
    const saved = window.localStorage.getItem(TAP_MODE_KEY)
    if (TAP_MODES.includes(saved)) tapMode = saved
  } catch {}
  let preAvailable = true
  // Saved audio has no pre-EQ tap. Before / Both stay clickable (dimmed) and a
  // click asks the host to go back to Live edit, instead of a dead button.
  let needLive = null
  const tapButtons = eqRoot ? [...eqRoot.querySelectorAll('[data-tap]')] : []
  for (const b of tapButtons) b.dataset.title = b.title
  function showTap() {
    for (const b of tapButtons) {
      const off = !preAvailable && b.dataset.tap !== 'after'
      b.classList.toggle('rx-seg-off', off)
      b.setAttribute('aria-disabled', String(off))
      b.title = off ? 'Saved audio has the EQ baked in. Click to switch to Live edit' : b.dataset.title
      b.setAttribute('aria-pressed', String(b.dataset.tap === (preAvailable ? tapMode : 'after')))
    }
  }
  for (const b of tapButtons) {
    b.addEventListener('click', () => {
      if (!preAvailable && b.dataset.tap !== 'after') needLive?.()
      tapMode = b.dataset.tap
      try { window.localStorage.setItem(TAP_MODE_KEY, tapMode) } catch {}
      showTap()
      redraw()
    })
  }
  showTap()
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
  let slotStrip = null // see renderSlotStrip
  let slotSignature = ''
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
    // Before shows the pre-EQ heat in cold hues; After and Both the post-EQ
    // heat in warm ones. Both are scaled to the Before heat (heatTopDb).
    const before = tapMode === 'before' && Boolean(heatPreDb)
    const shown = before ? heatPreDb : heatDb
    const heat = shown ? { binDb: shown, refBinDb: heatPreDb, sampleRate: heatSampleRate, before } : null
    drawEq(canvas, bands, selectedIndex, bandEnergy, liveSpectrum, soloIndex, getResponseCurve(width), hoveredIndex, viewMinHz, viewMaxHz, { mode: spectrumMode, heat, tap: tapMode })
    if (rulerCanvas) drawRulers(rulerCanvas, viewMinHz, viewMaxHz)
    renderSlotStrip()
  }

  // Fixed band slots: one numbered chip per slot under the graph. Empty
  // slots are hollow, Off/muted bands dim, live bands carry their type
  // color; the selected one is ringed. Clicking a chip selects that slot
  // (an empty one shows Off in the fields; pick a type to turn it on).
  // redraw() runs every spectrum frame, so the DOM is only rebuilt when
  // the slots or the selection actually change.
  function renderSlotStrip() {
    if (!slotStrip && canvas.id) slotStrip = canvas.ownerDocument.querySelector(`[data-eq-slots-for="${canvas.id}"]`)
    if (!slotStrip) return
    const sig = JSON.stringify([selectedIndex, soloIndex, readOnly, bands.map((b) => [isEmptySlot(b), b.type, b.muted, Math.round(b.freqHz)])])
    if (sig === slotSignature) return
    slotSignature = sig
    const doc = slotStrip.ownerDocument
    slotStrip.replaceChildren(...bands.map((band, i) => {
      const chip = doc.createElement('button')
      chip.type = 'button'
      chip.className = 'rx-eq-slot'
      chip.textContent = String(i + 1)
      const empty = isEmptySlot(band)
      const off = !empty && (band.type === 'off' || band.muted || (soloIndex !== -1 && soloIndex !== i))
      chip.dataset.state = empty ? 'empty' : off ? 'off' : 'on'
      if (!empty && band.type !== 'off') chip.style.setProperty('--slot-color', TYPE_COLORS[band.type] ?? TYPE_COLORS.peaking)
      chip.setAttribute('aria-pressed', String(i === selectedIndex))
      const label = empty ? 'empty' : band.type === 'off' ? 'Off' : `${EQ_TYPE_LABELS[band.type] ?? band.type}, ${Math.round(band.freqHz)} Hz${band.muted ? ', muted' : ''}`
      chip.title = `Band ${i + 1}: ${label}`
      chip.addEventListener('click', () => {
        selectedIndex = i
        redraw()
        onChange(getBands(), selectedIndex)
      })
      return chip
    }))
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
      if (isEmptySlot(band)) return
      const bx = freqToX(band.freqHz, width, viewMinHz, viewMaxHz)
      const by = gainToY(handleGainDb(band), height)
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
    dragVirtualY = gainToY(handleGainDb(bands[idx]), height)
    canvas.focus({ preventScroll: true })
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
    // A gainless type keeps its handle on 0 dB; only frequency follows.
    if (!GAINLESS_EQ_TYPES.includes(band.type ?? 'peaking')) band.gainDb = Math.round(yToGain(dragVirtualY, height) * 10) / 10
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
  // Fixed slots: the + turns on the first free slot; past the slots it
  // still adds one, up to MAX_BANDS.
  function addBand() {
    if (readOnly) return
    let idx = freeSlotIndex(bands)
    if (idx === -1) {
      if (bands.length >= MAX_BANDS) return
      bands.push({ ...NEW_BAND_DEFAULTS })
      idx = bands.length - 1
    } else {
      bands[idx] = { ...NEW_BAND_DEFAULTS }
    }
    selectedIndex = idx
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
    // Fixed slots: deleting empties the slot (back to its untouched Off
    // state) instead of splicing, so the other bands keep their numbers.
    const removedIndex = selectedIndex
    bands[removedIndex] = { ...EMPTY_SLOT }
    if (soloIndex === removedIndex) soloIndex = -1
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
    if (idx === -1) {
      turnOnBandAt(x, y, width, height)
      return
    }
    onDoubleClick(idx)
  }

  // Double-click on empty graph (LYNX, owner 2026-11-11): a band turns on
  // there. An Off band is reused first (the slot idea: Off bands wait to be
  // turned on); otherwise a new peak is added, up to MAX_BANDS.
  function turnOnBandAt(x, y, width, height) {
    const freqHz = Math.round(xToFreq(x, width, viewMinHz, viewMaxHz))
    const gainDb = Math.round(yToGain(y, height) * 10) / 10
    let idx = freeSlotIndex(bands)
    if (idx === -1) {
      if (bands.length >= MAX_BANDS) return
      bands.push({ ...NEW_BAND_DEFAULTS })
      idx = bands.length - 1
    }
    Object.assign(bands[idx], { type: 'peaking', freqHz, gainDb, muted: false })
    selectedIndex = idx
    redraw()
    onChange(getBands(), selectedIndex)
  }

  // Delete or Backspace on the focused graph turns the selected band Off.
  function handleKeyDown(evt) {
    if (readOnly || selectedIndex === -1 || !bands[selectedIndex]) return
    if (evt.key !== 'Delete' && evt.key !== 'Backspace') return
    evt.preventDefault()
    bands[selectedIndex].type = 'off'
    redraw()
    onChange(getBands(), selectedIndex)
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

  // Right-click a handle (LYNX, owner 2026-11-11, replacing the old type
  // cycle): a menu with the types, the slope for types that have one, and
  // Delete, which turns the band Off.
  function handleContextMenu(evt) {
    if (readOnly) return
    const { x, y, width, height } = eventPos(evt)
    const idx = nearestBandIndex(x, y, width, height)
    if (idx === -1) return
    evt.preventDefault()
    selectedIndex = idx
    redraw()
    onChange(getBands(), selectedIndex)
    openBandMenu(idx, evt.clientX, evt.clientY)
  }

  let menuEl = null
  function closeBandMenu() {
    if (!menuEl) return
    menuEl.remove()
    menuEl = null
    document.removeEventListener('mousedown', onMenuOutside, true)
    document.removeEventListener('keydown', onMenuKey, true)
  }
  function onMenuOutside(evt) {
    if (menuEl && !menuEl.contains(evt.target)) closeBandMenu()
  }
  function onMenuKey(evt) {
    if (evt.key === 'Escape') {
      evt.stopPropagation()
      closeBandMenu()
      canvas.focus({ preventScroll: true })
    }
  }
  function openBandMenu(idx, clientX, clientY) {
    closeBandMenu()
    const band = bands[idx]
    const type = band.type ?? 'peaking'
    const doc = canvas.ownerDocument
    menuEl = doc.createElement('div')
    menuEl.className = 'rx-eq-menu'
    menuEl.setAttribute('role', 'menu')
    const item = (label, checked, act, cls = '', iconSvg = '') => {
      const b = doc.createElement('button')
      b.type = 'button'
      b.className = 'rx-eq-mi' + (cls ? ' ' + cls : '')
      b.setAttribute('role', checked == null ? 'menuitem' : 'menuitemradio')
      if (checked != null) b.setAttribute('aria-checked', String(checked))
      b.innerHTML = iconSvg
      b.appendChild(doc.createTextNode(label))
      b.addEventListener('click', () => {
        act()
        closeBandMenu()
        redraw()
        onChange(getBands(), selectedIndex)
        canvas.focus({ preventScroll: true })
      })
      menuEl.appendChild(b)
    }
    const sep = () => menuEl.appendChild(Object.assign(doc.createElement('div'), { className: 'rx-eq-sep' }))
    for (const [key, label] of Object.entries(EQ_TYPE_LABELS)) item(label, type === key, () => { band.q = qWhenTypeChanges(band, key); band.type = key }, '', eqMenuIcon(key))
    if (SLOPE_CAPABLE_EQ_TYPES.includes(type)) {
      sep()
      item('Gentle slope', band.slope !== 'steep', () => { band.slope = 'gentle' }, '', eqMenuIcon('slope-gentle'))
      item('Steep slope', band.slope === 'steep', () => { band.slope = 'steep' }, '', eqMenuIcon('slope-steep'))
    }
    sep()
    item('Delete (turn off)', null, () => { band.type = 'off' }, 'rx-eq-danger', icon('trash-2'))
    doc.body.appendChild(menuEl)
    const r = menuEl.getBoundingClientRect()
    const win = doc.defaultView
    menuEl.style.left = `${Math.min(clientX, win.innerWidth - r.width - 8)}px`
    menuEl.style.top = `${Math.min(clientY, win.innerHeight - r.height - 8)}px`
    ;(menuEl.querySelector('[aria-checked="true"]') ?? menuEl.querySelector('button'))?.focus()
    document.addEventListener('mousedown', onMenuOutside, true)
    document.addEventListener('keydown', onMenuKey, true)
  }

  // The saved shape: the bands without the untouched trailing slots.
  function getBands() {
    return compactEqSlots(bands)
  }
  // Every slot, for indexing by the selected slot.
  function getSlots() {
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
  canvas.addEventListener('keydown', handleKeyDown)
  if (!canvas.hasAttribute('tabindex')) canvas.tabIndex = 0
  window.addEventListener('resize', handleResize)

  return {
    load(newBands) {
      bands = padEqSlots(newBands)
      selectedIndex = isEmptySlot(bands[0]) ? -1 : 0
      // A fresh sound's band-energy analysis hasn't arrived yet (it's an
      // async ffmpeg round-trip, see index.js's loadSound()) - clear any
      // previous sound's backdrop immediately rather than leaving it up
      // showing stale data until the new one resolves.
      bandEnergy = null
      liveSpectrum = null
      heatDb = null
      heatPreDb = null
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
    getSlots,
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
    // Step 13c: analyserNode is the end of the chain (After), preAnalyserNode
    // the pre-EQ tap (Before); null for saved audio.
    tickSpectrum(analyserNode, preAnalyserNode = null) {
      if (!analyserNode) return
      const n = analyserNode.frequencyBinCount
      if (!rawDbBuffer || rawDbBuffer.length !== n) {
        rawDbBuffer = new Float32Array(n)
        heldDb = new Float32Array(n).fill(SPECTRUM_FLOOR_DB)
        heldPreDb = new Float32Array(n).fill(SPECTRUM_FLOOR_DB)
        lastSpectrumTick = 0
      }
      const hasPre = Boolean(preAnalyserNode) && preAnalyserNode.frequencyBinCount === n
      if (hasPre !== preAvailable) {
        preAvailable = hasPre
        showTap()
      }
      const now = performance.now()
      // Clamp dt so a stalled tab doesn't drop everything to the floor in
      // one frame, or a first frame doesn't fall at all.
      const dt = lastSpectrumTick ? Math.min(0.1, (now - lastSpectrumTick) / 1000) : 1 / 60
      lastSpectrumTick = now
      const fall = SPECTRUM_FALL_DB_PER_S * dt
      const hold = (node, held) => {
        node.getFloatFrequencyData(rawDbBuffer)
        for (let i = 0; i < n; i++) {
          const v = Number.isFinite(rawDbBuffer[i]) ? rawDbBuffer[i] : SPECTRUM_FLOOR_DB - 40
          const h = held[i] - fall
          held[i] = v > h ? v : h
        }
      }
      hold(analyserNode, heldDb)
      if (hasPre) hold(preAnalyserNode, heldPreDb)
      // Both heats ease toward their held levels; a fresh sound starts from
      // them. The Before heat is kept even on After: it is the fixed scale.
      const k = Math.min(1, dt * HEAT_RATE_PER_S)
      const ease = (heat, src) => {
        if (!heat || heat.length !== n) return Float32Array.from(src)
        for (let i = 0; i < n; i++) heat[i] += (src[i] - heat[i]) * k
        return heat
      }
      heatDb = ease(heatDb, heldDb)
      heatPreDb = hasPre ? ease(heatPreDb, heldPreDb) : null
      heatSampleRate = analyserNode.context.sampleRate
      liveSpectrum = { binDb: heldDb, preBinDb: hasPre ? heldPreDb : null, sampleRate: analyserNode.context.sampleRate }
      redraw()
    },
    // Falls back to the static band-energy backdrop (if any) - called when
    // playback stops, so the graph doesn't freeze on the last live frame
    // forever.
    onNeedLive(fn) {
      needLive = fn
    },
    clearSpectrum() {
      if (!liveSpectrum) return
      liveSpectrum = null
      if (heldDb) heldDb.fill(SPECTRUM_FLOOR_DB)
      if (heldPreDb) heldPreDb.fill(SPECTRUM_FLOOR_DB)
      lastSpectrumTick = 0
      redraw()
    },
    getSpectrumMode() {
      return spectrumMode
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
      const band = bands[selectedIndex]
      if (patch.type && patch.type !== band.type) patch = { ...patch, q: qWhenTypeChanges(band, patch.type) }
      Object.assign(band, patch)
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
      canvas.removeEventListener('keydown', handleKeyDown)
      closeBandMenu()
    }
  }
}
