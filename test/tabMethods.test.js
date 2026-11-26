import test from 'node:test'
import assert from 'node:assert/strict'

// presetGroupMode.js and markers.js take the tab; a plain object stands in for it.
let markers, presetGroupMode
try {
  markers = await import('../src/tab/markers.js')
  presetGroupMode = await import('../src/tab/presetGroupMode.js')
} catch (e) {
  // A Vite-only import (?raw) cannot load in plain node.
  markers = null
}

test('marker methods take the tab', { skip: !markers }, () => {
  const calls = []
  const tab = {
    markers: [],
    currentEntry: null,
    loopEditorController: { setMarkers: (l) => calls.push(['loop', l]) },
    spectralView: { setMarkers: (l) => calls.push(['spec', l]) },
    refreshMarkerUi: () => calls.push(['ui'])
  }
  markers.setMarkers(tab, [{ id: 'a' }], { save: false })
  assert.deepEqual(tab.markers, [{ id: 'a' }])
  assert.deepEqual(calls.map((c) => c[0]), ['loop', 'spec', 'ui'])
})

test('marker key handler ignores keys outside Sound mode', { skip: !markers }, () => {
  globalThis.document = { activeElement: null }
  const tab = { mode: 'preset', els: {}, loopEditorController: null }
  const evt = { key: 'm', ctrlKey: true, target: null, preventDefault: () => assert.fail('should not handle') }
  assert.equal(markers.handleMarkerKey(tab, evt), false)
  delete globalThis.document
})

test('addMarkerAtPlayhead does nothing without a sound', { skip: !markers }, () => {
  const tab = { currentEntry: null, mode: 'sound', markers: [] }
  assert.equal(markers.addMarkerAtPlayhead(tab), undefined)
})

test('preset/group module exports the mode methods', { skip: !presetGroupMode }, () => {
  for (const name of ['refreshMixPanel', 'selectMixPreset', 'selectGroup', 'saveGroupNow', 'dispatchGroupPreview']) {
    assert.equal(typeof presetGroupMode[name], 'function', name)
  }
})

test('dispatchGroupPreview needs a preset and a group', { skip: !presetGroupMode }, () => {
  const events = []
  globalThis.window = { dispatchEvent: (e) => events.push(e) }
  globalThis.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init.detail } }
  presetGroupMode.dispatchGroupPreview({ selectedPresetId: null, selectedGroupId: 'g' }, {})
  assert.equal(events.length, 0)
  presetGroupMode.dispatchGroupPreview({ selectedPresetId: 'p', selectedGroupId: 'g' }, {})
  assert.equal(events[0].type, 'noctivago:sound-group-preview')
  assert.equal(events[0].detail.groupId, 'g')
  delete globalThis.window
})

let fluctuation
try {
  fluctuation = await import('../src/tab/fluctuation.js')
} catch (e) {
  fluctuation = null
}

test('fluctuation module exports the drift methods', { skip: !fluctuation }, () => {
  for (const name of ['setFluctuationControls', 'applyFluctuationControls', 'persistFluctuation', 'flushFluctuation', 'fluctuationDirty']) {
    assert.equal(typeof fluctuation[name], 'function', name)
  }
})

test('persistFluctuation waits for a sound, then queues the write', { skip: !fluctuation }, () => {
  const idle = { currentEntry: null }
  fluctuation.persistFluctuation(idle)
  assert.equal(idle._pendingFluctuation, undefined)
  const tab = { currentEntry: { id: 's1' }, fluctuation: { volume: {} }, flushFluctuation: () => {} }
  fluctuation.persistFluctuation(tab)
  assert.deepEqual(tab._pendingFluctuation, { id: 's1', fluctuation: tab.fluctuation })
  clearTimeout(tab._fluctuationSaveTimer)
})

test('flushFluctuation does nothing without a pending edit', { skip: !fluctuation }, () => {
  const tab = { _pendingFluctuation: null, api: { library: { updateFluctuation: () => assert.fail('no write') } } }
  assert.equal(fluctuation.flushFluctuation(tab), undefined)
})

let spectralRepair
try {
  spectralRepair = await import('../src/tab/spectralRepair.js')
} catch (e) {
  spectralRepair = null
}

test('spectral repair module exports the repair methods', { skip: !spectralRepair }, () => {
  for (const name of ['syncSpectralView', 'setSpectralTool', 'syncSpectralTool', 'syncNoiseBand', 'useShapeAsNoiseSample', 'updateSpectralControls']) {
    assert.equal(typeof spectralRepair[name], 'function', name)
  }
})

test('syncSpectralView does nothing before the view is mounted', { skip: !spectralRepair }, () => {
  assert.equal(spectralRepair.syncSpectralView({ spectralView: null }), undefined)
})

test('syncNoiseBand does nothing without the filter controls', { skip: !spectralRepair }, () => {
  assert.equal(spectralRepair.syncNoiseBand({ spectralView: {}, filterControls: null }), undefined)
})

let loopLayoutMethods
try {
  loopLayoutMethods = await import('../src/tab/loopLayout.js')
} catch (e) {
  loopLayoutMethods = null
}

test('loop layout module exports the layout and seam methods', { skip: !loopLayoutMethods }, () => {
  for (const name of ['liveLayout', 'currentSpeedPitchDoppler', 'savedLayout', 'clipTimeToSource', 'sourceTimeToClip', 'syncSeamView', 'scheduleSeamPeaks', 'scheduleSeamDetailPeaks', 'updateSeamPlayhead', 'toggleSeamListen', 'stopSeamListen']) {
    assert.equal(typeof loopLayoutMethods[name], 'function', name)
  }
})

test('savedLayout falls back to the live trim and the default crossfade', { skip: !loopLayoutMethods }, () => {
  const tab = { currentEntry: null, loopEditorController: { getLoopPoints: () => ({ loopStart: 1, loopEnd: 5 }) } }
  const layout = loopLayoutMethods.savedLayout(tab)
  assert.equal(typeof layout, 'object')
  assert.equal(loopLayoutMethods.clipTimeToSource(tab, 0), loopLayoutMethods.clipTimeToSource(tab, 0))
})

test('syncSeamView does nothing before the seam view is mounted', { skip: !loopLayoutMethods }, () => {
  assert.equal(loopLayoutMethods.syncSeamView({ seamView: null }), undefined)
})

test('stopSeamListen does nothing without a pending timer', { skip: !loopLayoutMethods }, () => {
  assert.equal(loopLayoutMethods.stopSeamListen({ _seamTimer: null }), undefined)
})

test('currentSpeedPitchDoppler reads the Doppler checkbox', { skip: !loopLayoutMethods }, () => {
  assert.equal(loopLayoutMethods.currentSpeedPitchDoppler({ els: { doppler: { checked: true } } }), true)
  assert.equal(loopLayoutMethods.currentSpeedPitchDoppler({ els: {} }), false)
})

let eqFiltersMethods
try {
  eqFiltersMethods = await import('../src/tab/eqFilters.js')
} catch (e) {
  eqFiltersMethods = null
}

test('EQ and filters module exports the methods', { skip: !eqFiltersMethods }, () => {
  for (const name of ['setFilterSliders', 'currentFilters', 'previewFilters', 'updateEqFieldsFromSelection', 'applyEqFieldsToSelectedBand', 'applyEqControls', 'eqDiffersFromSaved', 'updateEqRevertBannerVisibility', 'switchEqCompareView', 'updateEqCompareButtonsUI', 'revertEqToSaved', 'resetEqCompare', 'applyFilterControls']) {
    assert.equal(typeof eqFiltersMethods[name], 'function', name)
  }
})

test('previewFilters mutes every band but the soloed one', { skip: !eqFiltersMethods }, () => {
  const bands = [{ freqHz: 100 }, { freqHz: 200, muted: true }]
  const tab = {
    filterControls: { getValues: () => ({ gainDb: 0 }) },
    eqEditorController: { getBands: () => bands, getSoloIndex: () => 1 },
    loopEditorController: { getEnvelope: () => ({ enabled: false, points: [] }) },
    spectralView: { getRegions: () => [] },
    currentFilters: () => eqFiltersMethods.currentFilters(tab)
  }
  const filters = eqFiltersMethods.previewFilters(tab)
  assert.deepEqual(filters.eq.map((b) => b.muted), [true, false])
  assert.equal(bands[1].muted, true)
})

test('eqDiffersFromSaved compares the live bands with the snapshot', { skip: !eqFiltersMethods }, () => {
  const tab = { eqEditorController: { getBands: () => [{ freqHz: 1 }] }, savedEqSnapshot: [{ freqHz: 1 }] }
  assert.equal(eqFiltersMethods.eqDiffersFromSaved(tab), false)
  tab.savedEqSnapshot = []
  assert.equal(eqFiltersMethods.eqDiffersFromSaved(tab), true)
  assert.equal(eqFiltersMethods.eqDiffersFromSaved({}), false)
})

let mixPlaybackMethods
try {
  mixPlaybackMethods = await import('../src/tab/mixPlayback.js')
} catch (e) {
  mixPlaybackMethods = null
}

test('mix playback module exports the methods', { skip: !mixPlaybackMethods }, () => {
  for (const name of ['startWholeMixSpectrumTicking', 'stopWholeMixSpectrumTicking', 'resetLevelHistory', 'tickWholeMixSpectrum', 'updateMixPlayPauseUI', 'updateMixVolumeUI', 'onMixPlayPauseClick', 'playGroupOnly', 'onMixSoloGroupClick']) {
    assert.equal(typeof mixPlaybackMethods[name], 'function', name)
  }
})

test('resetLevelHistory empties only the named history', { skip: !mixPlaybackMethods }, () => {
  const tab = { presetLevelHistory: [1, 2], groupLevelHistory: [3] }
  mixPlaybackMethods.resetLevelHistory(tab, 'preset')
  assert.deepEqual(tab.presetLevelHistory, [])
  assert.deepEqual(tab.groupLevelHistory, [3])
})

test('updateMixVolumeUI hides the volume row when the app reports no volume', { skip: !mixPlaybackMethods }, () => {
  const toggles = []
  const tab = { root: { classList: { toggle: (c, on) => toggles.push([c, on]) } }, els: {} }
  mixPlaybackMethods.updateMixVolumeUI(tab, {})
  assert.deepEqual(toggles, [['rx-mixvol-on', false]])
})
