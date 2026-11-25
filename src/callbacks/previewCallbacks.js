import { PreviewSource } from '../audio/PreviewSource.js'
import { BakedClipPreview } from '../audio/BakedClipPreview.js'

// What the preview controller asks the tab (createPreviewController options).
export function previewCallbacks(tab) {
  return {
    engine: tab.engine,
    PreviewSource,
    BakedClipPreview,
    setLiveMode: () => { tab.previewMode = 'live' },
    getPreviewMode: () => tab.previewMode,
    getVolume: () => tab.effectivePreviewVolume(),
    stopTicking: () => tab.stopPreviewTicking(),
    setPlayPauseIcon: (playing) => tab.setPlayPauseIcon(playing),
    setClipRebaking: (v) => { tab._clipRebaking = v },
    tickPlayhead: () => tab.tickPreviewPlayhead(),
    updateSaveButtonState: () => tab.updateSaveButtonState()
  }
}
