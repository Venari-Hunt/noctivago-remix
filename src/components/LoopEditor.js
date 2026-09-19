import { drawWaveform } from '../audio/waveform.js'

const HANDLE_HIT_PX = 8
const SNAP_PX = 12
const MIN_LOOP_SECONDS = 0.05
// Volume envelope points (drawn/hit-tested across the full waveform height,
// gain 1 = top/y0, gain 0 = bottom - unlike every other draggable here,
// which is purely horizontal/time-based) need real 2D (x AND y) distance for
// hit-testing, not just x - see pointerDown's own comment on why this can
// coincide with the trim handles' x position at the two boundary points.
const ENVELOPE_HIT_PX = 10
// The minimum position gap a middle envelope point is kept away from its
// immediate neighbors while being dragged (the neighbor positions are
// captured once at drag-start as fixed bounds, see pointerDown) - purely to
// avoid two points landing on the exact same position, which would make
// interpolation between them meaningless.
const ENVELOPE_MIN_GAP = 0.002
// Fade-in/out handles (see waveform.js's diagonal ramp + corner pin) are only
// grabbable in a band along the very top of the canvas - the same x-position
// a fade handle sits at can coincide with the full-height start/end trim
// line (e.g. fade at 0), so hit-testing is disambiguated by y instead of
// competing purely on x distance the way start/end/playhead/doppler already
// do among themselves.
const FADE_HANDLE_ZONE_PX = 20
// How close the draggable Doppler "closest point" marker can get to either
// edge of the loop region - matches the identical floor in loopClip.js's
// buildDopplerSendCmd (duplicated for the usual cross-process reason), so
// what you can drag to on screen is exactly what the actual bake can render.
const MIN_DOPPLER_FRACTION = 0.05
// Floor on how far a scroll-zoom can shrink the visible window - without
// this, zooming keeps halving the span forever with no real detail left to
// show past the peaks array's own fixed resolution (see waveform.js).
const MIN_VIEW_SECONDS = 0.5
const ZOOM_IN_FACTOR = 0.8
const ZOOM_OUT_FACTOR = 1.25
// Dragging a handle/playhead within this many pixels of either canvas edge
// auto-scrolls the viewport toward that edge, continuously, for as long as
// the cursor stays there - not just on further mouse movement, since a
// stationary cursor sitting at the edge stops generating mousemove events.
const EDGE_SCROLL_ZONE_PX = 24
// Fraction of the current visible span to scroll per animation frame.
const EDGE_SCROLL_FRACTION = 0.02
// Holding a drag still (within HOLD_ZOOM_STILL_TOLERANCE_PX of where
// stillness began) for this long starts a quick zoom-in animation centered
// on whatever's being precisely positioned - lets the last stretch of a
// drag land pixel-accurately instead of fighting a coarse, zoomed-out view.
const HOLD_ZOOM_DELAY_MS = 450
const HOLD_ZOOM_STILL_TOLERANCE_PX = 2
// How far the hold-zoom shrinks the view, relative to whatever span was
// already visible when the hold triggered - NOT a fixed absolute target
// (that was the original design, MIN_VIEW_SECONDS below, but it made the
// zoom feel "way too strong" on a long clip: converging to a fixed 0.5s
// window is a ~120x zoom on a 60s view but only 2x on a 1s view). Dividing
// the *current* span by this factor instead means the zoom depth scales
// with how zoomed-in you already are, not the file's total length.
// HOLD_ZOOM_FLOOR_SECONDS still caps how tight it can get even from an
// already-small starting span, so it never collapses to something
// unreadable. Both tunable directly - see feedback thread this was added
// for.
const HOLD_ZOOM_TARGET_FACTOR = 8
const HOLD_ZOOM_FLOOR_SECONDS = 0.3
// How long the zoom-in animation itself takes once triggered, and how long
// the reverse (back to whatever the view was before this drag started, on
// release) takes too - both directions, same duration, per direct feedback
// that the original continuous multi-second ramp felt sluggish and that
// staying zoomed in forever after releasing was disorienting rather than
// helpful once the precise positioning it was for is actually done.
const ZOOM_ANIMATION_MS = 200

export function createLoopEditorController(canvas) {
  let duration = 0
  let loopStart = 0
  let loopEnd = 0
  let playhead = null
  let peaks = null
  let dopplerEnabled = false
  // Where the "closest point" (natural pitch, pitch bend crosses zero) sits
  // between loopStart (0) and loopEnd (1) - draggable via the gold pin drawn
  // on the waveform (see waveform.js), only interactive while dopplerEnabled.
  // Defaults to the midpoint, matching the original fixed-midpoint behavior.
  let dopplerClosestFraction = 0.5
  // Purely cosmetic - tints the marker/glow a different color when reversed
  // mode is on, so it's visually obvious which shape the drag is currently
  // controlling (see waveform.js's own comment for what actually changes).
  let dopplerReversed = false
  // Visual/draggable counterpart to the plain Fade in/out (ms) numeric
  // fields on scatter/schedule shots - "impossible to predict how it will
  // work out just typing numbers" per the owner's own inbox report. Seconds,
  // same time domain as loopStart/loopEnd; only drawn/interactive while
  // fadesEnabled (index.js sets this for scatter/schedule playModes, where
  // the trimmed region *is* the one-shot clip a fade actually applies to -
  // a continuously-looping sound has no per-shot fade to show here).
  let fadesEnabled = false
  let fadeInSec = 0
  let fadeOutSec = 0
  // Volume envelope (Loop mode only, v1) - drag control points directly on
  // the waveform to shape volume over time (Audacity's classic envelope
  // tool). `position` is a 0..1 fraction of the loop region (never absolute
  // seconds), so points never need re-normalizing when loopStart/loopEnd
  // change later - envelopePointTime() below converts to an absolute time
  // only at draw/hit-test time. Always at least the two boundary points
  // (position 0 and 1), which never move in x, only in gain (y) - see
  // pointerDown/updateDragValue's own handling of index 0/last.
  // envelopeUiVisible is a separate gate from envelopeEnabled - set by
  // index.js's applyPlayModeControl() (true only for Loop mode, since
  // scatter/scheduled shots have their own per-shot randomization instead),
  // independent of whether the user has actually turned the envelope on for
  // this sound.
  let envelopeEnabled = false
  let envelopeUiVisible = false
  let envelopePoints = [
    { position: 0, gain: 1 },
    { position: 1, gain: 1 }
  ]
  let draggingEnvelopePoint = null
  let draggingEnvelopeIsBoundary = false
  let draggingEnvelopeLeftBound = 0
  let draggingEnvelopeRightBound = 1
  let onEnvelopeChange = () => {}
  // A single finer-grained peaks fetch for whatever narrow window the caller
  // last requested (see plugins/editor/index.js's maybeFetchDetailPeaks) -
  // just one slot, not a cache of every window ever visited, so re-zooming
  // back into an earlier area refetches rather than growing unbounded state
  // for a session that might zoom all over a long file. Only used while the
  // current viewport is fully covered by it (see redraw) - falls back to the
  // base full-file peaks the instant the view moves past its edges, so
  // there's never a moment showing stale detail for the wrong range.
  let detailPeaks = null
  let detailPeaksStart = 0
  let detailPeaksEnd = 0
  let dragging = null
  let panStartX = 0
  let panStartViewStart = 0
  let panStartViewEnd = 0
  let moveRegionStartClientX = 0
  let moveRegionStartLoopStart = 0
  let moveRegionStartLoopEnd = 0
  // Absolute waveform-time position the fade-in/out ball sat at when a
  // start/end trim drag began - captured so the ball can be held fixed in
  // place (independent of the trim handle) for the rest of that drag, rather
  // than sliding along with it purely because it's normally defined as an
  // offset from loopStart/loopEnd. Reported directly: dragging the cut
  // handle was visibly dragging the fade ball along with it, which read as
  // one drag controlling two things. null outside of a start/end drag.
  let dragFadeInAnchor = null
  let dragFadeOutAnchor = null
  let lastPointerClientX = 0
  let lastPointerClientY = 0
  let edgeScrollDirection = 0
  let edgeScrollRafId = null
  let holdZoomTimeoutId = null
  let holdZoomRafId = null
  let holdZoomOriginX = 0
  let holdZoomFocusTime = null
  let holdZoomActive = false
  // The viewport as it was at the start of the current drag gesture, before
  // any hold-zoom happens - restored on release via animateViewportTo (see
  // pointerUp) so zooming in to position precisely doesn't leave the
  // waveform stuck zoomed in afterward.
  let dragStartViewStart = 0
  let dragStartViewEnd = 0
  let viewportAnimRafId = null
  // Held while Ctrl is down, disabling snapToPlayhead below - synced from
  // real mouse events (evt.ctrlKey, the most reliable source) and backed up
  // by window keydown/keyup so pressing/releasing Ctrl while the cursor
  // sits still during an edge-scroll (see tickEdgeScroll, which has no real
  // mouse event to read a modifier from) still takes effect immediately.
  let ctrlHeld = false
  let onChange = () => {}
  let onScrub = () => {}
  let onViewportChange = () => {}
  let onDopplerChange = () => {}
  let onFadesChange = () => {}

  // The currently visible time window - [0, duration] at full zoom-out.
  // Everything below maps time<->x through this, not through [0, duration]
  // directly, so drag/hit-test/drawing all "just work" once zoomed.
  let viewStart = 0
  let viewEnd = 0

  function xToTime(x, displayWidth) {
    const span = viewEnd - viewStart
    const t = viewStart + (x / displayWidth) * span
    return Math.min(Math.max(t, 0), duration)
  }

  function timeToX(t, displayWidth) {
    const span = viewEnd - viewStart
    return ((t - viewStart) / span) * displayWidth
  }

  // loopStart/loopEnd can shrink (dragging a trim handle) to less than
  // fadeInSec+fadeOutSec's own already-set span - clamped here for drawing/
  // hit-testing rather than mutating the stored values on every redraw, so a
  // trim drag that temporarily overlaps them doesn't silently discard a fade
  // the user dragged in on purpose; a real fade-handle drag (updateDragValue
  // below) is what actually commits a new value.
  function clampedFades() {
    const regionLen = Math.max(0, loopEnd - loopStart)
    const fi = Math.min(Math.max(fadeInSec, 0), regionLen)
    const fo = Math.min(Math.max(fadeOutSec, 0), regionLen - fi)
    return { fadeIn: fi, fadeOut: fo }
  }

  function redraw() {
    const useDetail = detailPeaks && viewStart >= detailPeaksStart && viewEnd <= detailPeaksEnd
    const { fadeIn, fadeOut } = clampedFades()
    drawWaveform(canvas, duration, {
      loopStart,
      loopEnd,
      playhead,
      peaks: useDetail ? detailPeaks : peaks,
      viewStart,
      viewEnd,
      peaksStart: useDetail ? detailPeaksStart : 0,
      peaksEnd: useDetail ? detailPeaksEnd : duration,
      dopplerEnabled,
      dopplerClosestFraction,
      dopplerReversed,
      fadesEnabled,
      fadeInSec: fadeIn,
      fadeOutSec: fadeOut,
      envelopeEnabled: envelopeEnabled && envelopeUiVisible,
      envelopePoints: envelopePoints.map((p) => ({ time: envelopePointTime(p), gain: p.gain }))
    })
  }

  function dopplerMarkerTime() {
    return loopStart + dopplerClosestFraction * (loopEnd - loopStart)
  }

  function envelopePointTime(point) {
    return loopStart + point.position * (loopEnd - loopStart)
  }

  function sortEnvelopePoints() {
    envelopePoints.sort((a, b) => a.position - b.position)
  }

  // gain 1 -> y 0 (canvas top, "full level"), gain 0 -> y rect.height (canvas
  // bottom, "silent") - a plain linear map across the whole waveform height,
  // matching waveform.js's own drawing (see its comment for why this is a
  // simplified, non-mirrored line rather than a literal Audacity-style
  // symmetric envelope).
  function envelopeYForGain(gain, rect) {
    return (1 - gain) * rect.height
  }

  function envelopeGainForY(y, rect) {
    return 1 - Math.min(Math.max(y / rect.height, 0), 1)
  }

  // Closest envelope point within ENVELOPE_HIT_PX of (x, y), or -1. Real 2D
  // Euclidean distance (mirrors EqEditor.js's own nearestBandIndex), not the
  // x-only distance every other draggable on this canvas uses.
  function findEnvelopePointHit(x, y, rect) {
    let closestIdx = -1
    let closestDist = Infinity
    for (let i = 0; i < envelopePoints.length; i++) {
      const px = timeToX(envelopePointTime(envelopePoints[i]), rect.width)
      const py = envelopeYForGain(envelopePoints[i].gain, rect)
      const dist = Math.hypot(x - px, y - py)
      if (dist < closestDist) {
        closestDist = dist
        closestIdx = i
      }
    }
    return closestDist <= ENVELOPE_HIT_PX ? closestIdx : -1
  }

  // Single place that actually commits a new viewport - clamps to
  // [0, duration] (sliding the window back in bounds rather than shrinking
  // it, so zoom level never changes as a side effect of clamping), redraws,
  // and notifies anything watching (the scrollbar). Every viewport-changing
  // path (wheel zoom, wheel/middle-drag pan, external setViewport from the
  // scrollbar) goes through this one function.
  function applyViewport(newStart, newEnd) {
    let s = newStart
    let e = newEnd
    if (s < 0) {
      e -= s
      s = 0
    }
    if (e > duration) {
      s -= e - duration
      e = duration
    }
    viewStart = Math.max(s, 0)
    viewEnd = Math.min(e, duration)
    redraw()
    onViewportChange({ viewStart, viewEnd, duration })
  }

  function cancelViewportAnim() {
    if (viewportAnimRafId != null) {
      cancelAnimationFrame(viewportAnimRafId)
      viewportAnimRafId = null
    }
  }

  // Smoothly moves the viewport to [targetStart, targetEnd] over
  // ZOOM_ANIMATION_MS, real-time-based (not frame-count-based) so the
  // duration stays consistent regardless of frame rate - used both for the
  // hold-zoom-in animation and for reverting the viewport back on release
  // (see pointerUp). Ease-out cubic so it starts fast and settles gently
  // rather than stopping abruptly.
  function animateViewportTo(targetStart, targetEnd, onDone) {
    cancelViewportAnim()
    const fromStart = viewStart
    const fromEnd = viewEnd
    const startTime = performance.now()

    function tick() {
      const t = Math.min(1, (performance.now() - startTime) / ZOOM_ANIMATION_MS)
      const eased = 1 - Math.pow(1 - t, 3)
      applyViewport(fromStart + (targetStart - fromStart) * eased, fromEnd + (targetEnd - fromEnd) * eased)
      if (t < 1) {
        viewportAnimRafId = requestAnimationFrame(tick)
      } else {
        viewportAnimRafId = null
        onDone?.()
      }
    }
    viewportAnimRafId = requestAnimationFrame(tick)
  }

  // If a dragged start/end handle ends up within SNAP_PX of the playhead,
  // snap it exactly onto the playhead's time instead of the raw drag
  // position - unless Ctrl is held, which disables snapping entirely (an
  // app-wide convention for any drag of this nature, per the owner's own
  // framing, even though this waveform is currently the only place with a
  // real snap target to disable).
  function snapToPlayhead(t, rect) {
    if (ctrlHeld || playhead == null) return t
    const dist = Math.abs(timeToX(t, rect.width) - timeToX(playhead, rect.width))
    return dist <= SNAP_PX ? playhead : t
  }

  function pointerDown(evt) {
    // Middle-click-drag pans the waveform ("grab and drag" semantics - drag
    // right to reveal earlier content, the opposite sign of wheel-scroll
    // panning, which follows normal scroll conventions instead). Browsers
    // otherwise treat a middle click as autoscroll/paste-primary-selection,
    // hence preventDefault here specifically (the other buttons don't need
    // it - loop-handle/playhead dragging never triggered either behavior).
    if (evt.button === 1) {
      evt.preventDefault()
      dragging = 'pan'
      panStartX = evt.clientX
      panStartViewStart = viewStart
      panStartViewEnd = viewEnd
      return
    }

    const rect = canvas.getBoundingClientRect()
    const x = evt.clientX - rect.left

    // Right-click-drag anywhere inside the trimmed region slides the whole
    // loop (both loopStart and loopEnd, same offset) instead of moving just
    // one edge - a distinct button from the left-click handle drags below,
    // so there's no ambiguity between the two. preventDefault suppresses
    // the browser's native right-click context menu, which has no
    // legitimate use on this canvas anyway (see the canvas-level
    // 'contextmenu' listener, which also always suppresses it - mousedown
    // alone isn't enough since the menu itself opens on mouseup).
    if (evt.button === 2) {
      // Right-click a middle envelope point (not a boundary one - those
      // can't be removed) deletes it, checked first so it takes priority
      // over the region-move drag right-click normally starts anywhere
      // inside the trimmed region.
      if (envelopeEnabled && envelopeUiVisible && envelopePoints.length > 2) {
        const y = evt.clientY - rect.top
        const hitIdx = findEnvelopePointHit(x, y, rect)
        if (hitIdx > 0 && hitIdx < envelopePoints.length - 1) {
          evt.preventDefault()
          envelopePoints.splice(hitIdx, 1)
          redraw()
          onEnvelopeChange()
          return
        }
      }
      const startX = timeToX(loopStart, rect.width)
      const endX = timeToX(loopEnd, rect.width)
      if (x >= startX && x <= endX) {
        evt.preventDefault()
        dragging = 'moveRegion'
        moveRegionStartClientX = evt.clientX
        moveRegionStartLoopStart = loopStart
        moveRegionStartLoopEnd = loopEnd
        dragStartViewStart = viewStart
        dragStartViewEnd = viewEnd
        scheduleHoldZoom(evt.clientX)
      }
      return
    }

    // Volume envelope points, checked before everything else below - a real
    // 2D (x AND y) hit test with a tight radius (ENVELOPE_HIT_PX), unlike
    // every other draggable here which is x-only, since a point's y encodes
    // its gain and the two boundary points sit at the same x as the trim
    // handles. The tight radius means this rarely intercepts a click meant
    // for the trim line/playhead/doppler marker elsewhere along their length.
    if (envelopeEnabled && envelopeUiVisible && loopEnd > loopStart) {
      const y = evt.clientY - rect.top
      const hitIdx = findEnvelopePointHit(x, y, rect)
      if (hitIdx !== -1) {
        dragging = 'envelopePoint'
        draggingEnvelopePoint = envelopePoints[hitIdx]
        draggingEnvelopeIsBoundary = hitIdx === 0 || hitIdx === envelopePoints.length - 1
        draggingEnvelopeLeftBound = hitIdx > 0 ? envelopePoints[hitIdx - 1].position + ENVELOPE_MIN_GAP : 0
        draggingEnvelopeRightBound =
          hitIdx < envelopePoints.length - 1 ? envelopePoints[hitIdx + 1].position - ENVELOPE_MIN_GAP : 1
        return
      }
    }

    // Fade handles live in a thin band along the top edge (see waveform.js's
    // corner pins) so they can sit at the same x as the start/end trim line
    // (e.g. a fade of 0) without competing with it on x-distance alone -
    // checked first, and only within that band; a click anywhere else in the
    // canvas's height falls through to the normal candidates below exactly
    // as before fades existed.
    if (fadesEnabled && loopEnd > loopStart && evt.clientY - rect.top <= FADE_HANDLE_ZONE_PX) {
      const { fadeIn, fadeOut } = clampedFades()
      const fadeCandidates = [
        { type: 'fadeIn', dist: Math.abs(x - timeToX(loopStart + fadeIn, rect.width)) },
        { type: 'fadeOut', dist: Math.abs(x - timeToX(loopEnd - fadeOut, rect.width)) }
      ]
      const closestFade = fadeCandidates.reduce((a, b) => (a.dist <= b.dist ? a : b))
      if (closestFade.dist <= HANDLE_HIT_PX) {
        dragging = closestFade.type
        return
      }
    }

    const candidates = [
      { type: 'start', dist: Math.abs(x - timeToX(loopStart, rect.width)) },
      { type: 'end', dist: Math.abs(x - timeToX(loopEnd, rect.width)) }
    ]
    if (playhead != null) {
      candidates.push({ type: 'playhead', dist: Math.abs(x - timeToX(playhead, rect.width)) })
    }
    if (dopplerEnabled && loopEnd > loopStart) {
      candidates.push({ type: 'doppler', dist: Math.abs(x - timeToX(dopplerMarkerTime(), rect.width)) })
    }
    const closest = candidates.reduce((a, b) => (a.dist <= b.dist ? a : b))
    if (closest.dist <= HANDLE_HIT_PX) {
      dragging = closest.type
      if (dragging === 'start' || dragging === 'end') {
        dragStartViewStart = viewStart
        dragStartViewEnd = viewEnd
        dragFadeInAnchor = loopStart + fadeInSec
        dragFadeOutAnchor = loopEnd - fadeOutSec
        scheduleHoldZoom(evt.clientX)
      }
    }
  }

  // Double-click the Doppler marker resets it back to the loop region's
  // midpoint - same "double-click resets a control" convention used
  // app-wide elsewhere (sliders, EQ nodes), applied to this canvas-drawn
  // marker the same way EqEditor.js's own nodes already do it.
  function pointerDoubleClick(evt) {
    if (loopEnd <= loopStart) return
    const rect = canvas.getBoundingClientRect()
    const x = evt.clientX - rect.left

    // Volume envelope: double-clicking an existing point resets its gain to
    // 1.0 (neutral) - same "double-click resets a control" convention as the
    // Doppler marker below and the EQ nodes elsewhere in this plugin.
    // Double-clicking empty space (envelope enabled, nothing hit) adds a new
    // point at that exact position/gain instead - the actual "shape the
    // volume" gesture. Checked before Doppler so an envelope point sitting
    // near the Doppler marker's x still resets correctly (2D hit test wins).
    if (envelopeEnabled && envelopeUiVisible) {
      const y = evt.clientY - rect.top
      const hitIdx = findEnvelopePointHit(x, y, rect)
      if (hitIdx !== -1) {
        envelopePoints[hitIdx].gain = 1
        redraw()
        onEnvelopeChange()
        return
      }
      const t = xToTime(evt.clientX - rect.left, rect.width)
      if (t > loopStart && t < loopEnd) {
        const span = loopEnd - loopStart
        const position = Math.min(Math.max((t - loopStart) / span, 0), 1)
        const gain = envelopeGainForY(y, rect)
        envelopePoints.push({ position, gain })
        sortEnvelopePoints()
        redraw()
        onEnvelopeChange()
        return
      }
    }

    if (!dopplerEnabled) return
    if (Math.abs(x - timeToX(dopplerMarkerTime(), rect.width)) > HANDLE_HIT_PX) return
    dopplerClosestFraction = 0.5
    redraw()
    onDopplerChange(dopplerClosestFraction)
  }

  // Shared by pointerMove (real mouse movement) and tickEdgeScroll (the
  // viewport moving under a stationary cursor) - both need to re-derive the
  // dragged handle/playhead's time from the same on-screen clientX, just
  // against whatever the current viewport mapping happens to be at the
  // moment.
  function updateDragValue(clientX, clientY = lastPointerClientY) {
    const rect = canvas.getBoundingClientRect()
    const t = xToTime(clientX - rect.left, rect.width)

    if (dragging === 'start') {
      loopStart = Math.min(snapToPlayhead(t, rect), loopEnd - MIN_LOOP_SECONDS)
      // Hold the fade-in ball at its own fixed absolute position rather than
      // letting it ride along with loopStart - only clamped back in once the
      // shrinking region would otherwise put it outside [0, regionLen].
      if (fadesEnabled && dragFadeInAnchor != null) {
        const regionLen = Math.max(0, loopEnd - loopStart)
        const newFadeInSec = Math.min(Math.max(dragFadeInAnchor - loopStart, 0), Math.max(0, regionLen - fadeOutSec))
        if (newFadeInSec !== fadeInSec) {
          fadeInSec = newFadeInSec
          onFadesChange({ fadeInSec, fadeOutSec })
        }
      }
      redraw()
      onChange({ loopStart, loopEnd })
    } else if (dragging === 'end') {
      loopEnd = Math.max(snapToPlayhead(t, rect), loopStart + MIN_LOOP_SECONDS)
      // Same anchor-hold for the fade-out ball, mirrored off loopEnd.
      if (fadesEnabled && dragFadeOutAnchor != null) {
        const regionLen = Math.max(0, loopEnd - loopStart)
        const newFadeOutSec = Math.min(Math.max(loopEnd - dragFadeOutAnchor, 0), Math.max(0, regionLen - fadeInSec))
        if (newFadeOutSec !== fadeOutSec) {
          fadeOutSec = newFadeOutSec
          onFadesChange({ fadeInSec, fadeOutSec })
        }
      }
      redraw()
      onChange({ loopStart, loopEnd })
    } else if (dragging === 'playhead') {
      playhead = t
      redraw()
      onScrub(t)
    } else if (dragging === 'fadeIn') {
      const maxFade = Math.max(0, loopEnd - loopStart - fadeOutSec)
      fadeInSec = Math.min(Math.max(t - loopStart, 0), maxFade)
      redraw()
      onFadesChange({ fadeInSec, fadeOutSec })
    } else if (dragging === 'fadeOut') {
      const maxFade = Math.max(0, loopEnd - loopStart - fadeInSec)
      fadeOutSec = Math.min(Math.max(loopEnd - t, 0), maxFade)
      redraw()
      onFadesChange({ fadeInSec, fadeOutSec })
    } else if (dragging === 'doppler') {
      const span = loopEnd - loopStart
      const rawFraction = span > 0 ? (t - loopStart) / span : 0.5
      dopplerClosestFraction = Math.min(Math.max(rawFraction, MIN_DOPPLER_FRACTION), 1 - MIN_DOPPLER_FRACTION)
      redraw()
      onDopplerChange(dopplerClosestFraction)
    } else if (dragging === 'moveRegion') {
      // Pixel-delta based (mirrors 'pan' above), not a difference of two
      // xToTime() calls - the region's own length must stay exactly fixed
      // through the drag, which a time-delta computed against a viewport
      // that might have shifted mid-drag (edge-scroll) could subtly throw
      // off. Clamped as a rigid pair: hitting either bound stops the whole
      // region rather than letting it shrink.
      const span = viewEnd - viewStart
      const deltaTime = ((clientX - moveRegionStartClientX) / rect.width) * span
      const length = moveRegionStartLoopEnd - moveRegionStartLoopStart
      let newStart = moveRegionStartLoopStart + deltaTime
      let newEnd = moveRegionStartLoopEnd + deltaTime
      if (newStart < 0) {
        newStart = 0
        newEnd = length
      }
      if (newEnd > duration) {
        newEnd = duration
        newStart = duration - length
      }
      loopStart = newStart
      loopEnd = newEnd
      redraw()
      onChange({ loopStart, loopEnd })
    } else if (dragging === 'envelopePoint' && draggingEnvelopePoint) {
      draggingEnvelopePoint.gain = envelopeGainForY(clientY - rect.top, rect)
      // Boundary points (position 0/1) never move in time, only in gain -
      // matches the loop region's own start/end, which an envelope point
      // can't be dragged past anyway (see the clamp below for middle points).
      if (!draggingEnvelopeIsBoundary) {
        const span = loopEnd - loopStart
        const rawPosition = span > 0 ? (t - loopStart) / span : draggingEnvelopePoint.position
        draggingEnvelopePoint.position = Math.min(Math.max(rawPosition, draggingEnvelopeLeftBound), draggingEnvelopeRightBound)
      }
      redraw()
      onEnvelopeChange()
    }
  }

  function tickEdgeScroll() {
    edgeScrollRafId = null
    if (!dragging || edgeScrollDirection === 0) return

    const span = viewEnd - viewStart
    const delta = edgeScrollDirection * span * EDGE_SCROLL_FRACTION
    const prevStart = viewStart
    const prevEnd = viewEnd
    applyViewport(viewStart + delta, viewEnd + delta)
    // Already at the file's start/end bound - nothing left to scroll toward,
    // stop rather than spin the RAF loop uselessly for the rest of the drag.
    if (viewStart === prevStart && viewEnd === prevEnd) return

    updateDragValue(lastPointerClientX)
    edgeScrollRafId = requestAnimationFrame(tickEdgeScroll)
  }

  function updateEdgeScroll(clientX) {
    const rect = canvas.getBoundingClientRect()
    const x = clientX - rect.left
    if (x < EDGE_SCROLL_ZONE_PX) edgeScrollDirection = -1
    else if (x > rect.width - EDGE_SCROLL_ZONE_PX) edgeScrollDirection = 1
    else edgeScrollDirection = 0

    if (edgeScrollDirection !== 0 && edgeScrollRafId == null) {
      edgeScrollRafId = requestAnimationFrame(tickEdgeScroll)
    }
  }

  // Cancels any pending "about to start zooming" timer and any actively-
  // running zoom animation - called both on real movement (see pointerMove,
  // which immediately re-arms from the new position) and on drag end, so an
  // animation never keeps running once the gesture it belongs to is over.
  function clearHoldZoom() {
    if (holdZoomTimeoutId != null) {
      clearTimeout(holdZoomTimeoutId)
      holdZoomTimeoutId = null
    }
    if (holdZoomRafId != null) {
      cancelAnimationFrame(holdZoomRafId)
      holdZoomRafId = null
    }
  }

  function scheduleHoldZoom(clientX) {
    clearHoldZoom()
    holdZoomOriginX = clientX
    holdZoomTimeoutId = setTimeout(() => {
      holdZoomTimeoutId = null
      // Focus point is whatever's actually being positioned - the dragged
      // handle's own time for 'start'/'end' (where it coincides with the
      // cursor anyway, since those track 1:1), but specifically loopEnd
      // for 'moveRegion' regardless of where inside the region it was
      // grabbed, per the ask: zoom centers on the right-hand cut line, not
      // the drag point in general.
      if (dragging === 'start') holdZoomFocusTime = loopStart
      else if (dragging === 'end') holdZoomFocusTime = loopEnd
      else if (dragging === 'moveRegion') holdZoomFocusTime = loopEnd
      else return
      holdZoomActive = true
      tickHoldZoom(performance.now(), viewEnd - viewStart)
    }, HOLD_ZOOM_DELAY_MS)
  }

  // Anchors the shrinking viewport on holdZoomFocusTime the same way
  // handleWheel's zoom already anchors on the cursor's time - keeps that
  // exact instant pinned at the same on-screen ratio every frame, which is
  // what keeps the dragged handle (or the region's right edge) from
  // visually jumping around as the coordinate mapping changes underneath
  // it mid-animation. Reaches targetSpan (fromSpan/HOLD_ZOOM_TARGET_FACTOR,
  // floored at HOLD_ZOOM_FLOOR_SECONDS - see above) in ZOOM_ANIMATION_MS via
  // a real-time-based exponential decay of the span (not a fixed per-frame
  // multiplier) - the ratio is recomputed fresh from the *actual* current
  // viewStart every frame rather than carried forward as a stale value,
  // which is what keeps the anchor exact throughout, not just at the end.
  // targetSpan itself is derived once from fromSpan (fixed for the whole
  // animation, not recomputed against the shrinking current span each
  // frame) so the exponential decay has a stable endpoint to converge to.
  function tickHoldZoom(startTime, fromSpan) {
    holdZoomRafId = null
    if (!dragging || holdZoomFocusTime == null) return
    const targetSpan = Math.max(fromSpan / HOLD_ZOOM_TARGET_FACTOR, HOLD_ZOOM_FLOOR_SECONDS)
    const span = viewEnd - viewStart
    if (span <= targetSpan + 0.001) return

    const t = Math.min(1, (performance.now() - startTime) / ZOOM_ANIMATION_MS)
    const newSpan = Math.max(fromSpan * Math.pow(targetSpan / fromSpan, t), targetSpan)
    const ratio = (holdZoomFocusTime - viewStart) / span
    const newStart = holdZoomFocusTime - ratio * newSpan
    applyViewport(newStart, newStart + newSpan)

    if (t < 1) holdZoomRafId = requestAnimationFrame(() => tickHoldZoom(startTime, fromSpan))
  }

  function handleCtrlKeyChange(evt) {
    if (evt.key !== 'Control') return
    ctrlHeld = evt.type === 'keydown'
  }

  function pointerMove(evt) {
    ctrlHeld = evt.ctrlKey
    if (!dragging || !duration) return
    const rect = canvas.getBoundingClientRect()

    if (dragging === 'pan') {
      const span = panStartViewEnd - panStartViewStart
      const deltaTime = ((evt.clientX - panStartX) / rect.width) * span
      applyViewport(panStartViewStart - deltaTime, panStartViewEnd - deltaTime)
      return
    }

    lastPointerClientX = evt.clientX
    lastPointerClientY = evt.clientY
    updateDragValue(evt.clientX, evt.clientY)
    if (dragging === 'start' || dragging === 'end' || dragging === 'playhead' || dragging === 'moveRegion') {
      updateEdgeScroll(evt.clientX)
    }

    // Real movement (beyond a small tolerance for hand tremor) cancels any
    // pending/active hold-zoom and re-arms it from the new position - stops
    // the ramp fighting an intentional drag the instant one resumes, matching
    // "zoom in while held still" rather than "zoom in regardless."
    if (dragging === 'start' || dragging === 'end' || dragging === 'moveRegion') {
      if (Math.abs(evt.clientX - holdZoomOriginX) > HOLD_ZOOM_STILL_TOLERANCE_PX) {
        scheduleHoldZoom(evt.clientX)
      }
    } else {
      clearHoldZoom()
    }
  }

  function pointerUp() {
    const wasZoomable = dragging === 'start' || dragging === 'end' || dragging === 'moveRegion'
    dragging = null
    draggingEnvelopePoint = null
    edgeScrollDirection = 0
    clearHoldZoom()

    // Only animate back if the view actually moved during this drag (hold-
    // zoom engaged, or edge-scroll panned it) - skip the no-op animation on
    // an ordinary short drag that never triggered either.
    if (wasZoomable && holdZoomActive && (viewStart !== dragStartViewStart || viewEnd !== dragStartViewEnd)) {
      animateViewportTo(dragStartViewStart, dragStartViewEnd)
    }
    holdZoomActive = false
  }

  // Wheel zoom, centered on the cursor's time position - only active while
  // hovering the canvas, since the listener is attached to the canvas
  // itself rather than window. A horizontal scroll gesture (shift+wheel on
  // a mouse, or a trackpad's two-finger horizontal swipe, both land in
  // deltaX) pans instead of zooming.
  function handleWheel(evt) {
    if (!duration) return
    evt.preventDefault()
    const rect = canvas.getBoundingClientRect()
    const span = viewEnd - viewStart

    if (Math.abs(evt.deltaX) > Math.abs(evt.deltaY)) {
      const shift = (evt.deltaX / rect.width) * span
      applyViewport(viewStart + shift, viewEnd + shift)
      return
    }

    const x = evt.clientX - rect.left
    const cursorTime = xToTime(x, rect.width)
    const factor = evt.deltaY < 0 ? ZOOM_IN_FACTOR : ZOOM_OUT_FACTOR
    const newSpan = Math.min(Math.max(span * factor, MIN_VIEW_SECONDS), duration)

    const ratio = (cursorTime - viewStart) / span
    const newStart = cursorTime - ratio * newSpan
    applyViewport(newStart, newStart + newSpan)
  }

  function preventContextMenu(evt) {
    evt.preventDefault()
  }

  // Redraws (which also re-syncs the canvas's bitmap resolution to its
  // current rendered size - see waveform.js's resizeCanvasForDisplay)
  // whenever the panel's own size might have changed, matching the same
  // fix/reasoning on EqEditor.js's own resize handler.
  function handleResize() {
    redraw()
  }

  canvas.addEventListener('mousedown', pointerDown)
  canvas.addEventListener('dblclick', pointerDoubleClick)
  window.addEventListener('mousemove', pointerMove)
  window.addEventListener('mouseup', pointerUp)
  canvas.addEventListener('wheel', handleWheel, { passive: false })
  window.addEventListener('keydown', handleCtrlKeyChange)
  window.addEventListener('keyup', handleCtrlKeyChange)
  canvas.addEventListener('contextmenu', preventContextMenu)
  window.addEventListener('resize', handleResize)

  return {
    load(totalDuration, initialLoopStart, initialLoopEnd) {
      duration = totalDuration
      loopStart = initialLoopStart ?? 0
      loopEnd = initialLoopEnd ?? totalDuration
      playhead = null
      peaks = null
      detailPeaks = null
      dopplerEnabled = false
      dopplerClosestFraction = 0.5
      dopplerReversed = false
      fadesEnabled = false
      fadeInSec = 0
      fadeOutSec = 0
      envelopeEnabled = false
      envelopePoints = [
        { position: 0, gain: 1 },
        { position: 1, gain: 1 }
      ]
      viewStart = 0
      viewEnd = totalDuration
      redraw()
      onViewportChange({ viewStart, viewEnd, duration })
    },
    setPeaks(newPeaks) {
      peaks = newPeaks
      redraw()
    },
    setDopplerEnabled(enabled) {
      dopplerEnabled = enabled
      redraw()
    },
    setDopplerReversed(reversed) {
      dopplerReversed = Boolean(reversed)
      redraw()
    },
    getDopplerClosestFraction() {
      return dopplerClosestFraction
    },
    setDopplerClosestFraction(fraction) {
      dopplerClosestFraction = Math.min(Math.max(fraction ?? 0.5, MIN_DOPPLER_FRACTION), 1 - MIN_DOPPLER_FRACTION)
      redraw()
    },
    // Called once a finer-grained fetch for a specific [rangeStart, rangeEnd]
    // window resolves (see maybeFetchDetailPeaks) - only takes effect while
    // the viewport is still inside that range (redraw checks this every
    // frame), so a fetch that resolves after the user has already zoomed/
    // panned elsewhere just gets silently ignored rather than drawn wrong.
    setDetailPeaks(newPeaks, rangeStart, rangeEnd) {
      detailPeaks = newPeaks
      detailPeaksStart = rangeStart
      detailPeaksEnd = rangeEnd
      redraw()
    },
    getLoopPoints() {
      return { loopStart, loopEnd }
    },
    setLoopPoints(newStart, newEnd) {
      loopStart = Math.min(Math.max(newStart, 0), duration)
      loopEnd = Math.min(Math.max(newEnd, loopStart + MIN_LOOP_SECONDS), duration)
      redraw()
      onChange({ loopStart, loopEnd })
    },
    setPlayhead(t) {
      playhead = t
      redraw()
    },
    clearPlayhead() {
      playhead = null
      redraw()
    },
    // Lets an external navigator (the scrollbar) drive the viewport
    // directly - goes through the same clamping/redraw/notify path as
    // every internal viewport change.
    setViewport(newStart, newEnd) {
      applyViewport(newStart, newEnd)
    },
    // fadeInSec/fadeOutSec are the same seconds domain as loopStart/loopEnd -
    // index.js converts to/from its own fadeInMs/fadeOutMs fields at the
    // boundary. enabled toggles both drawing and hit-testing at once (see
    // waveform.js and pointerDown above).
    setFadesEnabled(enabled) {
      fadesEnabled = Boolean(enabled)
      redraw()
    },
    setFades(newFadeInSec, newFadeOutSec) {
      fadeInSec = Math.max(0, newFadeInSec ?? 0)
      fadeOutSec = Math.max(0, newFadeOutSec ?? 0)
      redraw()
    },
    getFades() {
      const { fadeIn, fadeOut } = clampedFades()
      return { fadeInSec: fadeIn, fadeOutSec: fadeOut }
    },
    // points defaults to the neutral 2-boundary-point shape when missing/
    // invalid (fewer than 2 points, or no boundary at 0/1) - defensive
    // copy-in, same convention as EqEditor's load()/getBands(), so the
    // caller's own array is never mutated by drag/add/remove here.
    setEnvelope(enabled, points) {
      envelopeEnabled = Boolean(enabled)
      const valid = Array.isArray(points) && points.length >= 2
      envelopePoints = valid
        ? points.map((p) => ({ position: p.position, gain: p.gain }))
        : [
            { position: 0, gain: 1 },
            { position: 1, gain: 1 }
          ]
      sortEnvelopePoints()
      redraw()
    },
    getEnvelope() {
      return { enabled: envelopeEnabled, points: envelopePoints.map((p) => ({ ...p })) }
    },
    // Loop-mode-only gate (see index.js's applyPlayModeControl) - separate
    // from envelopeEnabled (the user's own on/off choice for this sound),
    // purely visual/hit-test, doesn't touch the underlying data so switching
    // playMode back to Loop shows whatever was already drawn.
    setEnvelopeUiVisible(visible) {
      envelopeUiVisible = Boolean(visible)
      redraw()
    },
    onLoopChange(fn) {
      onChange = fn
    },
    onDopplerChange(fn) {
      onDopplerChange = fn
    },
    onFadesChange(fn) {
      onFadesChange = fn
    },
    onEnvelopeChange(fn) {
      onEnvelopeChange = fn
    },
    onScrub(fn) {
      onScrub = fn
    },
    onViewportChange(fn) {
      onViewportChange = fn
    },
    destroy() {
      if (edgeScrollRafId != null) cancelAnimationFrame(edgeScrollRafId)
      clearHoldZoom()
      cancelViewportAnim()
      canvas.removeEventListener('mousedown', pointerDown)
      canvas.removeEventListener('dblclick', pointerDoubleClick)
      window.removeEventListener('mousemove', pointerMove)
      window.removeEventListener('mouseup', pointerUp)
      canvas.removeEventListener('wheel', handleWheel)
      window.removeEventListener('keydown', handleCtrlKeyChange)
      window.removeEventListener('keyup', handleCtrlKeyChange)
      canvas.removeEventListener('contextmenu', preventContextMenu)
      window.removeEventListener('resize', handleResize)
    }
  }
}
