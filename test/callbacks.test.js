import test from 'node:test'
import assert from 'node:assert/strict'
import { autosaveCallbacks } from '../src/callbacks/autosaveCallbacks.js'
import { saveCallbacks } from '../src/callbacks/saveCallbacks.js'
import { mountCallbacks } from '../src/callbacks/mountCallbacks.js'


test('autosave callbacks read the tab lazily', () => {
  const tab = { _restoringHistory: false, currentEntry: null, eqCompareViewing: 'A', compare: { isSaved: false }, hasUnsavedChanges: () => true, saveCtl: { isSaving: () => false }, save: (o) => o }
  const cb = autosaveCallbacks(tab)
  assert.equal(cb.canSchedule(), false)
  assert.equal(cb.canRun(), false)
  tab.currentEntry = { id: 'a' }
  assert.equal(cb.canSchedule(), true)
  assert.equal(cb.canRun(), true)
  tab.eqCompareViewing = 'B'
  assert.equal(cb.canRun(), false)
  assert.equal(cb.isBusy(), false)
  assert.deepEqual(cb.save(), { trigger: 'auto' })
  assert.ok(cb.idleMs > 0)
})

test('save callbacks get and set tab state', () => {
  const tab = { currentEntry: { id: 'x' }, editingPresetId: 'p', presets: [], els: { saveStatus: {}, saveAsCopy: {}, saveSegment: {}, save: {} }, savedFluctuationSnapshot: null, fluctuationSnapshot: () => 'f', snapshotOf: (a) => 's' + a }
  const cb = saveCallbacks(tab)
  assert.equal(cb.getEntry().id, 'x')
  assert.equal(cb.getEditingPresetId(), 'p')
  cb.setPresets([1])
  assert.deepEqual(tab.presets, [1])
  cb.setStatus('hi')
  assert.equal(tab.els.saveStatus.textContent, 'hi')
  cb.setSaveAsCopyDisabled(true)
  assert.equal(tab.els.saveAsCopy.disabled, true)
  cb.commitSavedSnapshot(1)
  assert.equal(tab.savedSnapshot, 's1')
  cb.commitFluctuationSnapshot()
  assert.equal(tab.savedFluctuationSnapshot, 'f')
  assert.equal(cb.hasLoopEditor(), false)
})


test('mount callbacks bind named tab methods and read state', () => {
  const names = ['updateSpectralControls', 'applyFilterControls', 'syncSpectralTool', 'setMarkers', 'editMarker', 'syncSpectralView', 'setSpectralTool', 'useShapeAsNoiseSample', 'applyCrossfadeControl', 'scheduleSeamDetailPeaks', 'liveLayout', 'updateStickyProgress', 'commitLoopPoints', 'updateSaveButtonState', 'currentPlayMode', 'syncFadeToggle', 'applyEqControls', 'togglePreviewMode', 'maybeFetchDetailPeaks', 'readPresetMixControlsAndPreview', 'readGroupControlsAndPreview']
  const tab = { api: { audio: {} }, previewMode: 'saved', wholeMixSaved: { eq: [1] }, groupSaved: { eq: [2] } }
  for (const n of names) tab[n] = function () { return this === tab }
  const cb = mountCallbacks(tab)
  for (const n of names) assert.equal(cb[n](), true, n)
  assert.equal(cb.hasSpectrogram, false)
  assert.equal(cb.isSavedPreview(), true)
  assert.deepEqual(cb.getPresetSavedBands(), [1])
  assert.deepEqual(cb.getGroupSavedBands(), [2])
})
