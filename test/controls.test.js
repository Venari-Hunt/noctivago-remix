import test from 'node:test'
import assert from 'node:assert/strict'
import { wireTrimControls } from '../src/controls/trimControls.js'
import { wirePickerControls } from '../src/controls/pickerControls.js'

function fakeEl() {
  const h = {}
  return { h, attrs: { 'aria-invalid': '1' }, value: '', addEventListener: (t, f) => (h[t] = f), removeAttribute(n) { delete this.attrs[n] }, blur() {} }
}

test('trim fields call their callbacks and needle input clears aria-invalid', () => {
  const els = { startInput: fakeEl(), endInput: fakeEl(), lengthInput: fakeEl(), needleInput: fakeEl(), suggestLoopBtn: fakeEl() }
  const calls = []
  const c = { applyManualLoopPoints: () => calls.push('pts'), applyManualLength: () => calls.push('len'), applyManualNeedle: () => calls.push('needle'), suggestLoopPoint: () => calls.push('suggest') }
  wireTrimControls(els, c)
  els.startInput.h.change(); els.endInput.h.change(); els.lengthInput.h.change(); els.needleInput.h.change(); els.suggestLoopBtn.h.click()
  els.needleInput.h.input()
  assert.deepEqual(calls, ['pts', 'pts', 'len', 'needle', 'suggest'])
  assert.equal(els.needleInput.attrs['aria-invalid'], undefined)
})

test('picker keys move the highlight, Enter picks, Escape closes', () => {
  const els = { soundSearch: fakeEl() }
  let hi = -1, picked = null, closed = 0
  const opts = [{ id: 'a' }, { id: 'b' }]
  wirePickerControls(els, {
    openPicker() {}, closePicker: () => closed++, renderPickerOptions() {}, selectPickerSound: (id) => (picked = id),
    filteredPickerSounds: () => opts, setQuery() {}, getHighlight: () => hi, setHighlight: (i) => (hi = i)
  })
  const key = (k) => els.soundSearch.h.keydown({ key: k, preventDefault() {} })
  key('ArrowDown'); assert.equal(hi, 0)
  key('ArrowDown'); assert.equal(hi, 1)
  key('Enter'); assert.equal(picked, 'b')
  key('Escape'); assert.equal(closed, 1)
})
