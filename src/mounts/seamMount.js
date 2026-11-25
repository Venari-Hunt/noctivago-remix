import { createSeamViewController } from '../components/SeamView.js'
import { DEFAULT_CROSSFADE_MS } from '../domain/mixSettings.js'
import { clipToSource } from '../domain/loopLayout.js'

// Seam panel: creates the seam view controller and wires its listeners.
// loopEditor: the trim waveform controller (its playhead follows a seam scrub).
// c: applyCrossfadeControl, scheduleSeamDetailPeaks, liveLayout, scrubPreview(sourceSec, fromSeam), updateStickyProgress.
export function mountSeam(els, loopEditor, c, create = createSeamViewController) {
  const seamView = create(els.seamCanvas)
  seamView.setLimits({
    maxSeconds: Number(els.crossfade.max) / 1000,
    stepSeconds: Number(els.crossfade.step) / 1000,
    defaultSeconds: DEFAULT_CROSSFADE_MS / 1000
  })
  seamView.onCrossfadeChange((seconds) => {
    els.crossfade.value = String(Math.round(seconds * 1000))
    c.applyCrossfadeControl()
  })
  seamView.onViewportChange((sourceRanges) => c.scheduleSeamDetailPeaks(sourceRanges))
  seamView.onScrub((liveClipTime) => {
    const source = clipToSource(c.liveLayout(), liveClipTime)
    c.scrubPreview(source, true)
    loopEditor.setPlayhead(source)
  })
  return seamView
}
