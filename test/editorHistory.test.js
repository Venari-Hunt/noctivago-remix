import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHistory } from '../src/domain/editorHistory.js'

test('seeded reset: nothing to undo or redo', () => {
  const h = createHistory()
  h.reset({ a: 1 })
  assert.equal(h.canUndo(), false)
  assert.equal(h.canRedo(), false)
  assert.equal(h.undo(), null)
})

test('push dedupes equal states', () => {
  const h = createHistory()
  h.reset({ a: 1 })
  assert.equal(h.push({ a: 1 }), false)
  assert.equal(h.push({ a: 2 }), true)
  assert.equal(h.length, 2)
})

test('undo and redo walk the stack', () => {
  const h = createHistory()
  h.reset({ a: 1 })
  h.push({ a: 2 })
  assert.deepEqual(h.undo(), { a: 1 })
  assert.equal(h.undo(), null)
  assert.deepEqual(h.redo(), { a: 2 })
  assert.equal(h.redo(), null)
})

test('a new edit after undo drops the redo branch', () => {
  const h = createHistory()
  h.reset({ a: 1 })
  h.push({ a: 2 })
  h.undo()
  h.push({ a: 3 })
  assert.equal(h.canRedo(), false)
  assert.equal(h.length, 2)
})

test('limit drops the oldest', () => {
  const h = createHistory({ limit: 2 })
  h.push({ a: 1 })
  h.push({ a: 2 })
  h.push({ a: 3 })
  assert.equal(h.length, 2)
  assert.deepEqual(h.undo(), { a: 2 })
})

test('empty reset: index -1, first push works', () => {
  const h = createHistory()
  h.reset()
  assert.equal(h.index, -1)
  h.push({ a: 1 })
  assert.equal(h.index, 0)
})
