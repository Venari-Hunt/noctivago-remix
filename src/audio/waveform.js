function formatTick(seconds, showHours) {
  const s = Math.floor(seconds % 60)
  const m = Math.floor(seconds / 60) % 60
  if (showHours) {
    const h = Math.floor(seconds / 3600)
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  }
  return `${m}:${String(s).padStart(2, '0')}`
}

function pickTickStep(span, width) {
  const targetTicks = Math.max(2, Math.floor(width / 80))
  const rawStep = span / targetTicks
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200]
  return steps.find((s) => s >= rawStep) ?? steps[steps.length - 1]
}

// BUG FIX: this canvas's internal bitmap resolution (its width/height HTML
// attributes, 640x160) didn't match its actual rendered CSS size
// (getBoundingClientRect - #editor-canvas is styled `width: 100%`, so it
// stretches to fill the panel, well past 640px on any normal window width).
// The browser scales the smaller bitmap up non-uniformly to fill the larger
// box, which is exactly what "stretched and blurry" looks like - reported
// directly by the user. Same root cause and same fix as the EQ graph's own
// identical bug (see EqEditor.js's resizeCanvasForDisplay, added first) -
// this canvas just never got the equivalent fix when the EQ one shipped,
// since it predates that work and nobody had reported it yet. Resizes the
// canvas's actual bitmap resolution to its rendered CSS size (times
// devicePixelRatio, for crisp non-blurry drawing on high-DPI displays too,
// not just non-stretched) before every draw, then scales the context so all
// the drawing code below keeps working in plain CSS-pixel coordinates
// unchanged. A useful side effect: the per-column waveform loop below now
// draws one segment per real screen pixel instead of per bitmap pixel, so
// the line is measurably smoother/more detailed on a wide window too, not
// just non-stretched.
export function resizeCanvasForDisplay(canvas) {
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

// viewStart/viewEnd (defaulting to the full [0, duration] range) let the
// zoomed-in LoopEditor draw just a window of the waveform instead of the
// whole file. peaks itself stays a fixed-resolution array spanning the
// *full* duration (one entry per pixel column at full zoom-out) - zooming
// in resamples that same array rather than fetching finer-grained peaks
// from ffmpeg (a bigger, separately-tracked backlog item: real detail past
// the original resolution needs new data, not just a smarter draw). What
// changed here (researched against how DAWs/waveform libraries actually
// render - see CLAUDE.md's Status entry) is *how* that resampling is drawn:
// linearly interpolating between neighboring peak points (instead of
// flooring to the nearest one) and connecting them as one continuous filled
// polygon (instead of independent per-column line segments) removes the
// visible staircase/blocky look at high zoom. This is honestly cosmetic
// smoothing of the same coarse data, not new precision - past the original
// resolution there's still no more *real* detail to show, it just no longer
// looks like discrete blocks while there isn't.
// peaksStart/peaksEnd describe what time range `peaks` itself spans - default
// [0, duration] for the base full-file array, but a finer-grained detail
// fetch (see waveformPeaks.js) covers just a narrow zoomed window instead,
// so the caller passes that window's own bounds here rather than this
// function assuming peaks always covers the whole file.
export function drawWaveform(canvas, duration, { loopStart, loopEnd, playhead, peaks, viewStart = 0, viewEnd = duration, peaksStart = 0, peaksEnd = duration, dopplerEnabled = false, dopplerClosestFraction = 0.5, dopplerReversed = false, fadesEnabled = false, fadeInSec = 0, fadeOutSec = 0, envelopeEnabled = false, envelopePoints = [] }) {
  const { width, height, dpr } = resizeCanvasForDisplay(canvas)
  const ctx = canvas.getContext('2d')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  const mid = height / 2

  ctx.clearRect(0, 0, width, height)

  if (!Number.isFinite(duration) || duration <= 0) return

  const viewSpan = viewEnd - viewStart
  const timeToX = (t) => ((t - viewStart) / viewSpan) * width

  const startX = timeToX(loopStart)
  const endX = timeToX(loopEnd)

  ctx.fillStyle = 'rgba(122, 162, 247, 0.35)'
  ctx.fillRect(startX, 0, endX - startX, height)

  // Fade in/out visual (draggable via the corner pins below) - the trimmed
  // region here *is* the one-shot clip a Random Interval/Scheduled sound
  // replays, so a fade drawn directly on it maps 1:1 to what actually plays,
  // same idea as a DAW clip's own corner fade handles. Shaded wedge = the
  // attenuated corner (darker near the true start/end, fading to nothing at
  // the point full volume is reached); the diagonal line marks that boundary
  // exactly. Drawn under the waveform fill so the waveform itself stays
  // legible on top, same layering as the plain trim tint above.
  if (fadesEnabled && loopEnd > loopStart) {
    const fadeInEndX = timeToX(loopStart + fadeInSec)
    const fadeOutStartX = timeToX(loopEnd - fadeOutSec)
    ctx.fillStyle = 'rgba(0, 0, 0, 0.4)'
    if (fadeInEndX > startX) {
      ctx.beginPath()
      ctx.moveTo(startX, 0)
      ctx.lineTo(fadeInEndX, 0)
      ctx.lineTo(startX, height)
      ctx.closePath()
      ctx.fill()
    }
    if (endX > fadeOutStartX) {
      ctx.beginPath()
      ctx.moveTo(fadeOutStartX, 0)
      ctx.lineTo(endX, 0)
      ctx.lineTo(endX, height)
      ctx.closePath()
      ctx.fill()
    }
  }

  // Doppler visual: dopplerClosestFraction (0-1 across the loop region,
  // draggable via the pin below) marks the marker point - normally the
  // "closest" point (pitch bends back to natural exactly there, Start/End
  // are "furthest"); in reversed mode the marker is the "furthest" point
  // instead (pitch peaks there, Start/End are natural) - see
  // loopClip.js's buildDopplerSendCmd for the actual math either way. A
  // soft glow peaking at the marker and fading toward both edges reads as
  // "this is the salient point" at a glance regardless of mode - the
  // glow's own asymmetry (narrower/steeper on whichever side the marker
  // sits closer to) doubles as a visualization of how much faster the
  // pitch bend happens on that side, backed by an explicit marker line +
  // pin so it's unambiguous even without the gradient. Color distinguishes
  // the two modes (gold = normal/pass-by, purple = reversed) so it's
  // obvious at a glance which shape is active. Drawn under the waveform
  // fill (so the waveform stays fully legible on top) but over the plain
  // trim tint.
  const dopplerColor = dopplerReversed ? '187, 154, 247' : '224, 175, 104' // purple : gold
  if (dopplerEnabled && loopEnd > loopStart) {
    const gradient = ctx.createLinearGradient(startX, 0, endX, 0)
    gradient.addColorStop(0, `rgba(${dopplerColor}, 0)`)
    gradient.addColorStop(dopplerClosestFraction, `rgba(${dopplerColor}, 0.45)`)
    gradient.addColorStop(1, `rgba(${dopplerColor}, 0)`)
    ctx.fillStyle = gradient
    ctx.fillRect(startX, 0, endX - startX, height)
  }

  if (peaks && peaks.length > 0) {
    const peaksSpan = peaksEnd - peaksStart
    const maxY = new Array(width)
    const minY = new Array(width)
    for (let x = 0; x < width; x++) {
      const t = viewStart + (x / width) * viewSpan
      const idx = Math.min(peaks.length - 1, Math.max(0, ((t - peaksStart) / peaksSpan) * peaks.length))
      const i0 = Math.min(peaks.length - 1, Math.floor(idx))
      const i1 = Math.min(peaks.length - 1, i0 + 1)
      const frac = idx - i0
      const [min0, max0] = peaks[i0]
      const [min1, max1] = peaks[i1]
      const min = min0 + (min1 - min0) * frac
      const max = max0 + (max1 - max0) * frac
      maxY[x] = mid + max * mid * 0.9
      minY[x] = mid + min * mid * 0.9
    }
    ctx.beginPath()
    ctx.moveTo(0.5, maxY[0])
    for (let x = 1; x < width; x++) ctx.lineTo(x + 0.5, maxY[x])
    for (let x = width - 1; x >= 0; x--) ctx.lineTo(x + 0.5, minY[x])
    ctx.closePath()
    ctx.fillStyle = 'rgba(122, 162, 247, 0.55)'
    ctx.fill()
    ctx.strokeStyle = '#7aa2f7'
    ctx.lineWidth = 1
    ctx.stroke()
  } else {
    ctx.strokeStyle = '#3b3f58'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(0, mid)
    ctx.lineTo(width, mid)
    ctx.stroke()
  }

  ctx.fillStyle = '#8892b0'
  ctx.font = '11px sans-serif'
  ctx.textBaseline = 'top'
  const showHours = duration >= 3600
  const step = pickTickStep(viewSpan, width)
  // Ticks are computed over the visible span, not [0, duration] - otherwise
  // a zoomed-in view far from t=0 on a long file would iterate thousands of
  // off-screen ticks for nothing (or show none at all).
  const firstTick = Math.ceil(viewStart / step) * step
  for (let t = firstTick; t <= viewEnd; t += step) {
    const x = timeToX(t)
    ctx.strokeStyle = 'rgba(59, 63, 88, 0.7)'
    ctx.beginPath()
    ctx.moveTo(x + 0.5, mid - 6)
    ctx.lineTo(x + 0.5, mid + 6)
    ctx.stroke()
    ctx.fillText(formatTick(t, showHours), x + 3, height - 14)
  }

  ctx.strokeStyle = '#f7768e'
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(startX, 0)
  ctx.lineTo(startX, height)
  ctx.moveTo(endX, 0)
  ctx.lineTo(endX, height)
  ctx.stroke()

  if (dopplerEnabled && loopEnd > loopStart) {
    const markerX = timeToX(loopStart + dopplerClosestFraction * (loopEnd - loopStart))
    const markerColor = dopplerReversed ? '#bb9af7' : '#e0af68'
    ctx.strokeStyle = markerColor
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(markerX, 0)
    ctx.lineTo(markerX, height)
    ctx.stroke()
    // Draggable - a plain white outline (matching the app's other
    // draggable-node convention, e.g. EqEditor.js's selection ring) marks
    // it as interactive, not just an indicator.
    ctx.beginPath()
    ctx.arc(markerX, 8, 5, 0, Math.PI * 2)
    ctx.fillStyle = markerColor
    ctx.fill()
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = 1.5
    ctx.stroke()
  }

  if (fadesEnabled && loopEnd > loopStart) {
    const fadeInEndX = timeToX(loopStart + fadeInSec)
    const fadeOutStartX = timeToX(loopEnd - fadeOutSec)
    ctx.strokeStyle = '#9ece6a'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(startX, height)
    ctx.lineTo(fadeInEndX, 0)
    ctx.moveTo(fadeOutStartX, 0)
    ctx.lineTo(endX, height)
    ctx.stroke()
    // Corner pins, same draggable-white-ring convention as the Doppler
    // marker above - grabbable in the top FADE_HANDLE_ZONE_PX band
    // (LoopEditor.js), drawn at the point each ramp reaches full volume.
    ctx.fillStyle = '#9ece6a'
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = 1.5
    for (const x of [fadeInEndX, fadeOutStartX]) {
      ctx.beginPath()
      ctx.arc(x, 8, 5, 0, Math.PI * 2)
      ctx.fill()
      ctx.stroke()
    }
  }

  // Volume envelope (per-sound, Loop mode) - a simplified straight-line-
  // segments overlay, not a literal mirrored/symmetric Audacity-style
  // envelope: gain 1 maps to the very top of the canvas ("full level"), gain
  // 0 to the very bottom ("silent"), one continuous line across the whole
  // waveform height. Same simplification precedent as the EQ graph's own
  // "straight polyline, not a true response curve." Points already arrive
  // pre-converted to absolute time by LoopEditor's redraw() (envelopePoints
  // here is [{time, gain}], not the raw {position, gain} data model) so this
  // function only needs timeToX, matching every other marker below.
  if (envelopeEnabled && loopEnd > loopStart && envelopePoints.length > 0) {
    const envelopeColor = '#7dcfff'
    ctx.strokeStyle = envelopeColor
    ctx.lineWidth = 2
    ctx.beginPath()
    envelopePoints.forEach((p, i) => {
      const x = timeToX(p.time)
      const y = (1 - p.gain) * height
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    })
    ctx.stroke()
    // Draggable - same white-outline convention as the Doppler marker/fade
    // pins above.
    ctx.fillStyle = envelopeColor
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = 1.5
    for (const p of envelopePoints) {
      const x = timeToX(p.time)
      const y = (1 - p.gain) * height
      ctx.beginPath()
      ctx.arc(x, y, 5, 0, Math.PI * 2)
      ctx.fill()
      ctx.stroke()
    }
  }

  if (Number.isFinite(playhead)) {
    const playX = timeToX(Math.min(Math.max(playhead, 0), duration))
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.moveTo(playX, 0)
    ctx.lineTo(playX, height)
    ctx.stroke()
  }
}
