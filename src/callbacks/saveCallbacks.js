// What the save controller asks the tab (createSaveController options).
export function saveCallbacks(tab) {
  return {
    api: tab.api,
    emit: (name, detail) => window.dispatchEvent(new CustomEvent(name, { detail })),
    getEntry: () => tab.currentEntry,
    getEditingPresetId: () => tab.editingPresetId,
    getFluctuation: () => tab.fluctuation,
    getPresets: () => tab.presets,
    setPresets: (presets) => { tab.presets = presets },
    hasLoopEditor: () => !!tab.loopEditorController,
    getLoopPoints: () => tab.loopEditorController.getLoopPoints(),
    isViewingB: () => tab.eqCompareViewing === 'B',
    isCompareSaved: () => tab.compare.isSaved,
    hasUnsavedChanges: () => tab.hasUnsavedChanges(),
    fluctuationDirty: () => tab.fluctuationDirty(),
    currentFilters: () => tab.currentFilters(),
    currentCrossfadeMs: () => tab.currentCrossfadeMs(),
    currentSpeedPitch: () => tab.currentSpeedPitch(),
    currentPlayMode: () => tab.currentPlayMode(),
    currentScatterConfig: () => tab.currentScatterConfig(),
    currentScheduleConfig: () => tab.currentScheduleConfig(),
    nextCopyName: (baseName) => tab.nextCopyName(baseName),
    refreshLibrary: () => tab.refreshLibrary(),
    updateSaveButtonState: () => tab.updateSaveButtonState(),
    setStatus: (text) => { tab.els.saveStatus.textContent = text },
    setSaveAsCopyDisabled: (disabled) => { tab.els.saveAsCopy.disabled = disabled },
    setSaveSegmentDisabled: (disabled) => { tab.els.saveSegment.disabled = disabled },
    saveWorking: (word) => tab.saveMorph?.working(word),
    saveDone: (word) => tab.saveMorph?.done(word),
    saveFail: (word) => tab.saveMorph?.fail(word),
    beginBake: (trigger) => {
      tab.els.save.disabled = true
      if (!tab.saveMorph) tab.setSaveLabel(trigger === 'auto' ? 'Auto-saving…' : 'Saving…')
    },
    commitSavedSnapshot: (...settings) => { tab.savedSnapshot = tab.snapshotOf(...settings) },
    cancelPendingFluctuation: () => {
      clearTimeout(tab._fluctuationSaveTimer)
      tab._pendingFluctuation = null
    },
    fluctuationSnapshot: () => tab.fluctuationSnapshot(),
    commitFluctuationSnapshot: () => { tab.savedFluctuationSnapshot = tab.fluctuationSnapshot() },
    releaseBakedPreview: () => tab.releaseBakedPreviewForRebake(),
    restoreBakedPreview: (args) => tab.restoreBakedPreviewAfterRebake(args)
  }
}
