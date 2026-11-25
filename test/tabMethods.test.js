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
