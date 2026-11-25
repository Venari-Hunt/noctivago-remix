// The tab methods and state the per-panel mount functions (src/mounts/) call; all lazy.
export function mountCallbacks(tab) {
  const bind = (...names) => Object.fromEntries(names.map((n) => [n, tab[n].bind(tab)]))
  return {
    ...bind(
      'updateSpectralControls', 'applyFilterControls', 'syncSpectralTool', 'setMarkers', 'editMarker', 'syncSpectralView',
      'setSpectralTool', 'useShapeAsNoiseSample', 'applyCrossfadeControl', 'scheduleSeamDetailPeaks', 'liveLayout',
      'updateStickyProgress', 'commitLoopPoints', 'updateSaveButtonState', 'currentPlayMode', 'syncFadeToggle',
      'applyEqControls', 'togglePreviewMode', 'maybeFetchDetailPeaks', 'readPresetMixControlsAndPreview',
      'readGroupControlsAndPreview'
    ),
    hasSpectrogram: typeof tab.api.audio.getSpectrogram === 'function',
    setFilterValues: (values) => tab.filterControls.setValues(values),
    isSavedPreview: () => tab.previewMode === 'saved',
    // fromSeam: the seam view also moves the sticky progress bar when playing the live source.
    scrubPreview: (source, fromSeam) => {
      if (tab.previewMode === 'saved' && tab.bakedPreview) {
        const clipTime = tab.sourceTimeToClip(source)
        tab.bakedPreview.scrubTo(clipTime)
        tab.updateStickyProgress(clipTime)
      } else {
        tab.previewSource?.scrubTo(source)
        if (fromSeam) tab.updateStickyProgress(source)
      }
    },
    seekPreview: (sec) => {
      const active = tab.activePreview()
      if (!active) return
      const t = tab.previewMode === 'saved' ? tab.sourceTimeToClip(sec) : sec
      active.scrubTo(t)
      tab.spectralView.setPlayhead(sec)
      tab.loopEditorController?.setPlayhead(sec)
      tab.updateStickyProgress(t)
    },
    getPresetSavedBands: () => tab.wholeMixSaved.eq,
    getGroupSavedBands: () => tab.groupSaved.eq,
    onPresetApply: (bands) => {
      tab.wholeMixCurrent = { ...tab.wholeMixCurrent, eq: bands }
      tab.updateModeUI()
      if (tab.mode === 'preset') tab.dispatchWholeMixPreview(tab.wholeMixCurrent)
    },
    onGroupApply: (bands) => {
      tab.groupCurrent = { ...tab.groupCurrent, eq: bands }
      tab.updateModeUI()
      if (tab.mode === 'group') tab.dispatchGroupPreview(tab.groupCurrent)
    },
    patchPresetVolume: (vals) => {
      tab.wholeMixCurrent.fluctuation = { ...tab.wholeMixCurrent.fluctuation, volume: { ...tab.wholeMixCurrent.fluctuation.volume, ...vals } }
    },
    patchGroupVolume: (vals) => {
      tab.groupCurrent.fluctuation = { ...tab.groupCurrent.fluctuation, volume: { ...tab.groupCurrent.fluctuation.volume, ...vals } }
    }
  }
}
