import { test } from 'node:test'
import assert from 'node:assert/strict'
import { previewModeToggleState, mustFallBackToLive } from '../src/domain/previewMode.js'

test('live mode', () => {
  const s = previewModeToggleState({ mode: 'live', eligible: true, stale: true })
  assert.equal(s.text, 'Live edit')
  assert.equal(s.active, false)
  assert.equal(s.stale, false)
  assert.match(s.title, /live editable preview/)
})

test('saved mode, fresh and stale', () => {
  const fresh = previewModeToggleState({ mode: 'saved', eligible: true, stale: false })
  assert.equal(fresh.text, 'Saved audio')
  assert.equal(fresh.active, true)
  assert.match(fresh.title, /actual saved\/baked audio/)
  const stale = previewModeToggleState({ mode: 'saved', eligible: true, stale: true })
  assert.equal(stale.stale, true)
  assert.match(stale.title, /edited since then/)
})

test('not eligible asks to render', () => {
  assert.equal(previewModeToggleState({ mode: 'live', eligible: false, stale: false }).title, 'Click to render and hear the actual saved audio')
})

test('fallback to live', () => {
  assert.equal(mustFallBackToLive({ mode: 'saved', eligible: false, rebaking: false }), true)
  assert.equal(mustFallBackToLive({ mode: 'saved', eligible: false, rebaking: true }), false)
  assert.equal(mustFallBackToLive({ mode: 'live', eligible: false, rebaking: false }), false)
  assert.equal(mustFallBackToLive({ mode: 'saved', eligible: true, rebaking: false }), false)
})
