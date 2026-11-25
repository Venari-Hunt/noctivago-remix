import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAutosave } from '../src/domain/autosave.js'

const make = (over = {}) => {
  const calls = []
  const a = createAutosave({
    idleMs: 10,
    canSchedule: () => true,
    canRun: () => true,
    isBusy: () => false,
    save: async () => { calls.push('save') },
    onError: (e) => calls.push('err:' + e.message),
    ...over
  })
  return { a, calls }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

test('schedule debounces to one save', async () => {
  const { a, calls } = make()
  a.schedule(); a.schedule()
  await wait(40)
  assert.deepEqual(calls, ['save'])
})

test('cancel prevents the save', async () => {
  const { a, calls } = make()
  a.schedule(); a.cancel()
  await wait(40)
  assert.deepEqual(calls, [])
})

test('canSchedule false does nothing', async () => {
  const { a, calls } = make({ canSchedule: () => false })
  a.schedule()
  await wait(40)
  assert.deepEqual(calls, [])
})

test('busy retries until free', async () => {
  let busy = true
  const { a, calls } = make({ isBusy: () => busy })
  a.schedule()
  await wait(25)
  assert.deepEqual(calls, [])
  busy = false
  await wait(30)
  assert.deepEqual(calls, ['save'])
})

test('save errors go to onError', async () => {
  const { a, calls } = make({ save: async () => { throw new Error('x') } })
  await a.run()
  assert.deepEqual(calls, ['err:x'])
})
