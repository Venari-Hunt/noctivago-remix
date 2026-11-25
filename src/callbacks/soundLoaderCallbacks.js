import { closeMarkerPopover } from '../components/markerUi.js'
import { loadMarkers } from '../domain/markerStore.js'

// What the sound loader asks the tab (createSoundLoader options).
export function soundLoaderCallbacks(tab) {
  return {
    api: tab.api,
    beforeLoad: () => {
      tab.leaveCompareView()
      clearTimeout(tab.detailPeaksDebounceTimer)
      clearTimeout(tab._seamDetailPeaksTimer)
      tab.seamView?.resetZoom()
    },
    findEntry: (id) => tab.library.find((s) => s.id === id),
    currentId: () => tab.currentEntry?.id,
    clearSolo: () => tab.setSolo(false),
    setCurrentEntry: (entry) => { tab.currentEntry = entry },
    // `entry` (from tab.library) is already the effective view (baseline merged
    // with tab preset's own override) as of refreshLibrary()'s last call.
    pinEditingPreset: () => {
      tab.editingPresetId = tab.activePresetId
      return tab.editingPresetId
    },
    disposePreview: () => tab.disposePreview(),
    showEditor: (entry) => {
      tab.els.empty.classList.add('hidden')
      tab.els.panel.classList.remove('hidden')
      tab.setBarEnabled(true)
      tab.els.soundName.textContent = entry.name
      tab.els.soundName.title = entry.name
      tab.layout?.refreshStudio?.()
      tab.setPlayPauseIcon(false)
      tab.els.saveStatus.textContent = ''
    },
    setFilterSliders: (filters) => tab.setFilterSliders(filters),
    setSavedEqSnapshot: (eq) => { tab.savedEqSnapshot = eq },
    resetEqCompare: () => tab.resetEqCompare(),
    setCrossfade: (ms) => {
      tab.els.crossfade.value = String(ms)
      tab.updateCrossfadeLabel(ms)
    },
    setSpeedPitchControls: (sp) => tab.setSpeedPitchControls(sp),
    updateSpeedPitchLabels: (sp) => tab.updateSpeedPitchLabels(sp),
    loopEditor: () => tab.loopEditorController,
    setPlayModeControls: (mode) => tab.setPlayModeControls(mode),
    setScatterControls: (c) => tab.setScatterControls(c),
    setScheduleControls: (c) => tab.setScheduleControls(c),
    setFluctuationControls: (c) => tab.setFluctuationControls(c),
    startPreview: ({ entry, presetId, crossfadeMs, speedPitch, fluctuation }) => tab.previewCtl.start({
      soundId: entry.id,
      presetId,
      volume: tab.effectivePreviewVolume(),
      sourceOptions: {
        loopStart: entry.loopStart,
        loopEnd: entry.loopEnd,
        looping: tab.looping,
        crossfadeSeconds: crossfadeMs / 1000,
        speedPitch,
        fluctuation,
        onNoiseProfile: (curve) => tab.filterControls?.setNoiseProfile(curve)
      },
      // Only fires when Loop preview is off and playback runs off the end on
      // its own - the button/playhead-tracking RAF otherwise only stop via
      // the explicit Play/Pause click handler.
      onEnded: () => {
        tab.stopPreviewTicking()
        tab.setPlayPauseIcon(false)
        tab.eqEditorController.clearSpectrum()
      },
      onReverseStateChange: (state) => tab.showReverseState(state)
    }),
    showReverseState: () => tab.showReverseState(tab.previewSource.reverseState),
    previewSource: () => tab.previewSource,
    previewFilters: () => tab.previewFilters(),
    getFluctuation: () => tab.fluctuation,
    closeMarkerPopover,
    loadMarkers,
    setMarkers: (markers) => tab.setMarkers(markers, { save: false }),
    setSpectralRegions: (regions) => tab.spectralView.setRegions(regions),
    updateSpectralControls: () => tab.updateSpectralControls(),
    syncNoiseBand: () => tab.syncNoiseBand(),
    resetSpectrogramKey: () => { tab._spectrogramKey = null },
    syncSpectralView: () => tab.syncSpectralView(),
    updateFadeVisual: () => tab.updateFadeVisual(),
    updateLoopTimeInputs: (start, end) => tab.updateLoopTimeInputs(start, end),
    updateStickyProgress: (t) => tab.updateStickyProgress(t),
    resetSuggestLoop: () => {
      tab.els.suggestStatus.textContent = ''
      tab.els.suggestLoopBtn.disabled = false
    },
    setBandEnergy: (freqs, energies) => tab.eqEditorController.setBandEnergy(freqs, energies),
    snapshotOf: (...args) => tab.snapshotOf(...args),
    // Undo history is per-editing-session, same scope as A/B Compare - a fresh
    // load starts a fresh stack seeded with the just-loaded state.
    resetHistory: (snapshot) => {
      tab.savedSnapshot = snapshot
      clearTimeout(tab._historyCommitTimer)
      tab.history.reset(JSON.parse(snapshot))
    },
    updateUndoRedoButtonsUI: () => tab.updateUndoRedoButtonsUI(),
    updateSaveButtonState: () => tab.updateSaveButtonState(),
    hasPeaksCached: (id) => tab.waveformPeaksCache.has(id),
    setWaveformStatus: (text) => { tab.els.waveformStatus.textContent = text },
    getWaveformPeaks: (id) => tab.getWaveformPeaks(id),
    syncSeamView: () => tab.syncSeamView()
  }
}
