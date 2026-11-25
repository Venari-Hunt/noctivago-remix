import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCompare } from '../src/domain/compareView.js'

test('starts on now', () => {
  const c = createCompare()
  assert.equal(c.viewing, 'now')
  assert.equal(c.isSaved, false)
})

test('enterSaved stashes, leave returns the stash once', () => {
  const c = createCompare()
  c.enterSaved({ a: 1 })
  assert.equal(c.isSaved, true)
  assert.deepEqual(c.leave(), { a: 1 })
  assert.equal(c.viewing, 'now')
  assert.equal(c.leave(), null)
})
