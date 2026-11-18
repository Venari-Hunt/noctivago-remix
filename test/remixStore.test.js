import test from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '../src/state/remixStore.js'

test('starts at the defaults and does not alias them', () => {
  const defaults = { a: 1 }
  const s = createStore(defaults)
  assert.deepEqual(s.get(), { a: 1 })
  s.set({ a: 2 })
  assert.equal(defaults.a, 1)
})

test('set is readable right away and notifies once per call', () => {
  const s = createStore({ a: 1, b: 2 })
  let calls = 0
  s.subscribe(() => calls++)
  s.set({ a: 5, b: 6 })
  assert.deepEqual(s.get(), { a: 5, b: 6 })
  assert.equal(calls, 1)
})

test('ignores unknown keys and undefined values', () => {
  const s = createStore({ a: 1 })
  let calls = 0
  s.subscribe(() => calls++)
  s.set({ x: 9, a: undefined })
  assert.deepEqual(s.get(), { a: 1 })
  assert.equal(calls, 0)
})

test('no change keeps the same object and stays silent', () => {
  const s = createStore({ a: 1 })
  const before = s.get()
  let calls = 0
  s.subscribe(() => calls++)
  s.set({ a: 1 })
  assert.equal(s.get(), before)
  assert.equal(calls, 0)
  s.set({ a: 2 })
  assert.notEqual(s.get(), before)
})

test('normalize runs on every value', () => {
  const s = createStore({ a: 0 }, (_k, v) => Math.min(10, Number(v) || 0))
  s.set({ a: 99 })
  assert.equal(s.get().a, 10)
  s.set({ a: 'x' })
  assert.equal(s.get().a, 0)
})

test('unsubscribe stops notifications', () => {
  const s = createStore({ a: 1 })
  let calls = 0
  const off = s.subscribe(() => calls++)
  off()
  s.set({ a: 2 })
  assert.equal(calls, 0)
})
