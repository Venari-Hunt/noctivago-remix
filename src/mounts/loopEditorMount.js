import { createLoopEditorController } from '../components/LoopEditor.js'
import { createWaveformScrollbar } from '../components/WaveformScrollbar.js'

// Trim waveform: creates the loop editor controller and wires its listeners.
// c: commitLoopPoints, scrubPreview(sourceSec, fromSeam), updateSaveButtonState, applyFilterControls, currentPlayMode, syncFadeToggle.
export function mountLoopEditor(els, c, create = createLoopEditorController) {
  const loopEditor = create(els.canvas)
  loopEditor.onLoopChange(({ loopStart, loopEnd }) => c.commitLoopPoints(loopStart, loopEnd))
  loopEditor.onScrub((t) => c.scrubPreview(t, false))
  // Dragging (or double-click-resetting) the Doppler "closest point" marker:
  // the preview already follows the curve, this is the dirty-check/history hook.
  loopEditor.onDopplerChange(() => c.updateSaveButtonState())
  // Dragging a fade handle writes straight back into whichever numeric field
  // is showing (scatter vs. scheduled, never both), so the text inputs and
  // the drag stay one source of truth, same as onLoopChange for Start/End.
  loopEditor.onFadesChange(({ fadeInSec, fadeOutSec }) => {
    const fadeInMs = Math.round(fadeInSec * 1000)
    const fadeOutMs = Math.round(fadeOutSec * 1000)
    const playMode = c.currentPlayMode()
    if (playMode === 'scatter') {
      els.scatterFadeIn.value = String(fadeInMs)
      els.scatterFadeOut.value = String(fadeOutMs)
      c.syncFadeToggle(els.scatterFadeEnabled, els.scatterFadeIn, els.scatterFadeOut)
    } else if (playMode === 'scheduled') {
      els.scheduleFadeIn.value = String(fadeInMs)
      els.scheduleFadeOut.value = String(fadeOutMs)
      c.syncFadeToggle(els.scheduleFadeEnabled, els.scheduleFadeIn, els.scheduleFadeOut)
    }
    c.updateSaveButtonState()
  })
  // An envelope point lives inside `filters`, so it takes the same live-preview
  // and dirty-check path every other filter control uses.
  loopEditor.onEnvelopeChange(() => c.applyFilterControls())
  return loopEditor
}

// The scrollbar under the waveform and the viewport it drives. c: maybeFetchDetailPeaks.
export function mountWaveformScrollbar(els, loopEditor, c, create = createWaveformScrollbar) {
  const scrollbar = create(els.scrollbarTrack, els.scrollbarThumb)
  scrollbar.onNavigate((start, end) => loopEditor.setViewport(start, end))
  loopEditor.onViewportChange(({ viewStart, viewEnd, duration }) => {
    scrollbar.update(duration, viewStart, viewEnd)
    c.maybeFetchDetailPeaks(viewStart, viewEnd, duration)
  })
  return scrollbar
}
