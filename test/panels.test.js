import test from 'node:test'
import assert from 'node:assert/strict'
import { lookupEls } from '../src/panels/lookup.js'
import { findAllEls } from '../src/panels/index.js'
import { SHELL_SELECTORS } from '../src/panels/shellPanel.js'

function fakeContainer() {
  const asked = []
  return {
    asked,
    querySelector: (s) => (asked.push(s), { sel: s }),
    querySelectorAll: (s) => (asked.push(s), [{ sel: s }])
  }
}

test('lookupEls maps names to elements and lists', () => {
  const c = fakeContainer()
  const els = lookupEls(c, { a: '#a', b: { all: '[data-b]' } })
  assert.deepEqual(els.a, { sel: '#a' })
  assert.deepEqual(els.b, [{ sel: '[data-b]' }])
})

test('findAllEls asks for each selector once and keeps the shell ids', () => {
  const c = fakeContainer()
  const els = findAllEls(c)
  assert.equal(Object.keys(els).length, 240)
  assert.equal(new Set(c.asked).size, c.asked.length)
  assert.deepEqual(els.saveStatus, { sel: SHELL_SELECTORS.saveStatus })
  assert.equal(els.soundSearch.sel, '#editor-sound-search')
  assert.equal(els.presetButtons[0].sel, '[data-preset]')
})
