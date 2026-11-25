import { test } from 'node:test'
import assert from 'node:assert/strict'
import { markerKeyAction } from '../src/domain/markerKeys.js'

const ctx = { mode: 'sound', typing: false, hasSelected: true, onSpectral: false }

test('Ctrl+M adds', () => {
  assert.equal(markerKeyAction({ ctrlKey: true, key: 'm' }, ctx), 'add')
  assert.equal(markerKeyAction({ ctrlKey: true, key: 'M' }, ctx), 'add')
  assert.equal(markerKeyAction({ ctrlKey: true, shiftKey: true, key: 'm' }, ctx), null)
  assert.equal(markerKeyAction({ ctrlKey: true, altKey: true, key: 'm' }, ctx), null)
})

test('Delete removes only with a selection, not on the spectrum canvas', () => {
  assert.equal(markerKeyAction({ key: 'Delete' }, ctx), 'delete')
  assert.equal(markerKeyAction({ key: 'Delete' }, { ...ctx, hasSelected: false }), null)
  assert.equal(markerKeyAction({ key: 'Delete' }, { ...ctx, onSpectral: true }), null)
})

test('ignored while typing or outside Sound mode', () => {
  assert.equal(markerKeyAction({ ctrlKey: true, key: 'm' }, { ...ctx, typing: true }), null)
  assert.equal(markerKeyAction({ ctrlKey: true, key: 'm' }, { ...ctx, mode: 'group' }), null)
})
