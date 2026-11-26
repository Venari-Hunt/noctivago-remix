// Loop layout and Loop seam methods of the Remix tab. Each takes the tab.
import { loopLayout, clipToSource, sourceToClip } from '../domain/loopLayout.js'
import { DEFAULT_CROSSFADE_MS, SEAM_LEAD_SECONDS, SEAM_TAIL_SECONDS } from '../domain/mixSettings.js'

// --- Loop layout (v0.1.222) ---
// A baked loop clip is the second half of the trim, the crossfade, then
// the first half (loopLayout.js mirrors loopClip.js). liveLayout() is what
// the current, possibly unsaved, settings would bake - the Loop seam strip
// draws it. savedLayout() is the clip actually on disk, from the loopClip*
// fields recorded at bake time (the stored crossfade is already the
// effective one, 0 under Doppler).
export function liveLayout(tab) {
  const { loopStart, loopEnd } = tab.loopEditorController.getLoopPoints()
  const doppler = currentSpeedPitchDoppler(tab)
  return loopLayout(loopStart, loopEnd, doppler ? 0 : tab.currentCrossfadeMs() / 1000)
}

export function currentSpeedPitchDoppler(tab) {
  return Boolean(tab.els.doppler?.checked)
}

export function savedLayout(tab) {
  const entry = tab.currentEntry
  const live = tab.loopEditorController.getLoopPoints()
  const start = entry?.loopClipStart ?? live.loopStart
  const end = entry?.loopClipEnd ?? live.loopEnd
  const fade = entry?.loopClipCrossfadeSeconds ?? DEFAULT_CROSSFADE_MS / 1000
  return loopLayout(start, end, fade)
}

export function clipTimeToSource(tab, clipTime) {
  return clipToSource(savedLayout(tab), clipTime)
}

export function sourceTimeToClip(tab, t) {
  return sourceToClip(savedLayout(tab), t)
}

// Pushes the current trim/crossfade/mode into the Loop seam strip.
export function syncSeamView(tab, { immediate = false } = {}) {
  if (!tab.seamView || !tab.loopEditorController) return
  const { loopStart, loopEnd } = tab.loopEditorController.getLoopPoints()
  tab.seamView.setLoop(loopStart, loopEnd)
  tab.seamView.setCrossfade(tab.currentCrossfadeMs() / 1000)
  tab.seamView.setEnabled(!currentSpeedPitchDoppler(tab))
  scheduleSeamPeaks(tab, { immediate })
}

// The strip needs peaks for just the trim. Base (whole-file) peaks show
// immediately; a finer fetch for the trim replaces them once settled.
// The fetch sizes itself to the canvas, so it only runs while the Loop seam
// view is shown: loading a sound commits loop points while the Trim view is
// up, and a fetch then got a 0 px canvas (2 peaks for the whole trim) that
// the key kept on screen until the trim changed (2026-11-12). Opening the
// view fetches at once; the 300 ms wait is only for trim and fade edits.
export function scheduleSeamPeaks(tab, { immediate = false } = {}) {
  clearTimeout(tab._seamPeaksTimer)
  const id = tab.currentEntry?.id
  if (!id || !tab.seamView) return
  const { loopStart, loopEnd } = tab.loopEditorController.getLoopPoints()
  const base = tab.waveformPeaksCache.get(id)
  const width = Math.round(tab.els.seamCanvas.getBoundingClientRect().width)
  const key = `${id}:${loopStart}:${loopEnd}:${Boolean(base)}:${width}`
  if (key === tab._seamPeaksKey) return
  const duration = tab.currentEntry?.durationSeconds
  const trimKey = `${id}:${loopStart}:${loopEnd}`
  if (base && duration && tab._seamFineFor !== trimKey) tab.seamView.setPeaks(base, 0, duration)
  if (width < 2) {
    tab._seamPeaksKey = null
    return
  }
  tab._seamPeaksKey = key
  tab._seamPeaksTimer = setTimeout(async () => {
    try {
      const peaks = await tab.api.audio.getWaveformPeaks(id, width * 2, loopStart, loopEnd)
      const current = tab.loopEditorController.getLoopPoints()
      if (!peaks || tab.currentEntry?.id !== id || current.loopStart !== loopStart || current.loopEnd !== loopEnd) return
      tab.seamView.setPeaks(peaks, loopStart, loopEnd)
      tab._seamFineFor = trimKey
    } catch (err) {
      console.error('Editor: seam strip peaks fetch failed', err)
    }
  }, immediate ? 0 : 300)
}

// Finer peaks for exactly what the "Loop seam" strip's current zoom
// shows (v0.1.231) - the same idea as maybeFetchDetailPeaks for the main
// trim waveform, keyed off the source-time ranges SeamView's own
// onViewportChange already resolved: two when the view straddles the
// crossfade (the trim's end and its start), fetched separately so each is
// really finer (see that file's computeSourceRanges).
export function scheduleSeamDetailPeaks(tab, sourceRanges) {
  clearTimeout(tab._seamDetailPeaksTimer)
  const id = tab.currentEntry?.id
  const ranges = (sourceRanges || []).filter(([start, end]) => end > start)
  if (!id || !tab.seamView || ranges.length === 0) return
  const request = (tab._seamDetailRequest = (tab._seamDetailRequest || 0) + 1)
  tab._seamDetailPeaksTimer = setTimeout(async () => {
    const width = Math.max(1, Math.round(tab.els.seamCanvas.getBoundingClientRect().width))
    try {
      const segments = await Promise.all(ranges.map(async ([start, end]) => ({ peaks: await tab.api.audio.getWaveformPeaks(id, width, start, end), start, end })))
      if (request !== tab._seamDetailRequest || tab.currentEntry?.id !== id) return
      tab.seamView.setDetailPeaks(segments)
    } catch (err) {
      console.error('Editor: seam detail peaks fetch failed', err)
    }
  }, 250)
}

// The strip's playhead, in liveLayout() clip time.
export function updateSeamPlayhead(tab, sourceTime) {
  if (!tab.seamView) return
  tab.seamView.setPlayhead(sourceTime == null ? null : sourceToClip(liveLayout(tab), sourceTime))
}

// --- Listen to the seam (v0.1.221) ---
// Plays SEAM_LEAD_SECONDS before the crossfade, through it, then
// SEAM_TAIL_SECONDS more, and stops - in whichever preview mode is active.
// The live preview crossfades at the trim's end, so looping is forced on
// while it runs.
export async function toggleSeamListen(tab) {
  if (tab._seamTimer) {
    stopSeamListen(tab)
    return
  }
  const active = tab.activePreview()
  if (!active || !tab.loopEditorController) return
  let startAt
  let secondsToSeamEnd
  if (tab.previewMode === 'saved' && tab.bakedPreview) {
    // The baked seam is the crossfade in the middle of the clip; with no
    // crossfade (a plain trim) it's the clip's own restart.
    await tab.bakedPreview.waitForMetadata()
    const layout = savedLayout(tab)
    const clipDuration = tab.bakedPreview.duration
    const seamEnd = layout.fade > 0 ? Math.min(layout.blendEnd, clipDuration) : clipDuration
    startAt = Math.max(0, seamEnd - layout.fade - SEAM_LEAD_SECONDS)
    secondsToSeamEnd = seamEnd - startAt
  } else {
    const { loopStart, loopEnd } = tab.loopEditorController.getLoopPoints()
    const fade = liveLayout(tab).fade
    startAt = Math.max(loopStart, loopEnd - fade - SEAM_LEAD_SECONDS)
    // The live preview plays the source at its Speed/Pitch rate.
    secondsToSeamEnd = (loopEnd - startAt) / (active.audioEl.playbackRate || 1)
    tab._seamRestoreLooping = !tab.looping
    if (!tab.looping) tab.previewSource.setLooping(true)
  }
  if (active.playing) active.pause()
  active.scrubTo(startAt)
  tab._seamTimer = setTimeout(() => stopSeamListen(tab), (secondsToSeamEnd + SEAM_TAIL_SECONDS) * 1000)
  tab.els.seamListen.querySelector('span').textContent = 'Stop'
  tab.els.seamStatus.textContent = 'Playing through the loop point…'
  await tab.engine.resume()
  await active.play()
  tab.setPlayPauseIcon(true)
  tab.tickPreviewPlayhead()
}

// Ends a seam preview: pauses what it started and restores the loop
// toggle. Also called when the user takes over (Play/Pause, a mode switch,
// loading another sound) with pause: false, so a pending timer never
// pauses their own playback later.
export function stopSeamListen(tab, { pause = true } = {}) {
  if (!tab._seamTimer) return
  clearTimeout(tab._seamTimer)
  tab._seamTimer = null
  if (tab._seamRestoreLooping) tab.previewSource?.setLooping(tab.looping)
  tab._seamRestoreLooping = false
  tab.els.seamListen.querySelector('span').textContent = 'Listen to the seam'
  tab.els.seamStatus.textContent = ''
  if (pause && tab.activePreview()?.playing) {
    tab.activePreview().pause()
    tab.stopPreviewTicking()
    tab.setPlayPauseIcon(false)
    tab.eqEditorController.clearSpectrum()
  }
}
