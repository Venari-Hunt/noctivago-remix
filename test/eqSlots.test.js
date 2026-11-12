import test from 'node:test'
import assert from 'node:assert/strict'
import { EQ_SLOT_COUNT, EMPTY_SLOT, isEmptySlot, padEqSlots, compactEqSlots, freeSlotIndex } from '../src/domain/eqSlots.js'

const peak = { freqHz: 500, gainDb: 3, q: 1, type: 'peaking', slope: 'gentle', muted: false }

test('a saved list round-trips through the slots unchanged', () => {
  for (const saved of [[], [peak], [peak, { ...peak, type: 'off' }, peak]]) {
    const slots = padEqSlots(saved)
    assert.equal(slots.length, Math.max(EQ_SLOT_COUNT, saved.length))
    assert.deepEqual(compactEqSlots(slots), saved)
  }
})

test('more saved bands than slots keeps them all', () => {
  const ten = Array.from({ length: 10 }, () => ({ ...peak }))
  assert.equal(padEqSlots(ten).length, 10)
})

test('only trailing empty slots are dropped, so band indexes hold', () => {
  const slots = padEqSlots([])
  slots[2] = { ...peak }
  const saved = compactEqSlots(slots)
  assert.equal(saved.length, 3)
  assert.equal(saved[2].type, 'peaking')
  assert.ok(isEmptySlot(saved[0]))
})

test('an Off band someone edited is not an empty slot', () => {
  assert.ok(isEmptySlot({ ...EMPTY_SLOT }))
  assert.ok(!isEmptySlot({ ...EMPTY_SLOT, freqHz: 200 }))
  assert.ok(!isEmptySlot({ ...EMPTY_SLOT, extra: 1 }))
  assert.ok(!isEmptySlot({ ...peak }))
})

test('the free slot is an empty one first, then any Off band', () => {
  const slots = [{ ...peak, type: 'off' }, { ...peak }, { ...EMPTY_SLOT }]
  assert.equal(freeSlotIndex(slots), 2)
  assert.equal(freeSlotIndex(slots.slice(0, 2)), 0)
  assert.equal(freeSlotIndex([{ ...peak }]), -1)
})
