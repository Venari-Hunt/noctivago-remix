import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSaveController, effectiveCrossfade, nextCopyName } from '../src/controllers/saveController.js'

test('effectiveCrossfade is 0 for one-shot playback and Doppler', () => {
  assert.equal(effectiveCrossfade('loop', { dopplerEnabled: false }, 0.4), 0.4)
  assert.equal(effectiveCrossfade('scatter', { dopplerEnabled: false }, 0.4), 0)
  assert.equal(effectiveCrossfade('scheduled', { dopplerEnabled: false }, 0.4), 0)
  assert.equal(effectiveCrossfade('loop', { dopplerEnabled: true }, 0.4), 0)
})

test('nextCopyName picks the first free "copy" name', () => {
  assert.equal(nextCopyName([], 'Rain'), 'Rain copy')
  assert.equal(nextCopyName(['Rain copy'], 'Rain'), 'Rain copy 2')
  assert.equal(nextCopyName(['Rain copy', 'Rain copy 2'], 'Rain'), 'Rain copy 3')
})

function deps(over = {}) {
  const calls = []
  const entry = { id: 's1', name: 'Rain' }
  const d = {
    api: {},
    emit: (name, detail) => calls.push(['emit', name, detail.soundId]),
    getEntry: () => entry,
    hasLoopEditor: () => true,
    isViewingB: () => false,
    isCompareSaved: () => false,
    saveWorking: (w) => calls.push(['working', w]),
    saveDone: (w) => calls.push(['done', w]),
    saveFail: (w) => calls.push(['fail', w]),
    updateSaveButtonState: () => calls.push(['update']),
    hasUnsavedChanges: () => false,
    fluctuationDirty: () => false,
    getEditingPresetId: () => null,
    getFluctuation: () => ({}),
    ...over
  }
  return { d, calls }
}

test('save does nothing while viewing B, comparing Saved, or with no sound', async () => {
  for (const over of [{ isViewingB: () => true }, { isCompareSaved: () => true }, { getEntry: () => null }, { hasLoopEditor: () => false }]) {
    const { d, calls } = deps(over)
    await createSaveController(d).save()
    assert.deepEqual(calls, [])
  }
})

test('save reports a failure, rethrows and frees the guard', async () => {
  const { d, calls } = deps({ getLoopPoints: () => { throw new Error('boom') } })
  const ctl = createSaveController(d)
  await assert.rejects(ctl.save({ trigger: 'auto' }), /boom/)
  assert.deepEqual(calls, [['working', 'Auto-saving'], ['fail', "Couldn't save. Try again"], ['update']])
  assert.equal(ctl.isSaving(), false)
})

test('a second save while one runs is ignored', async () => {
  let release
  const gate = new Promise((r) => { release = r })
  const { d, calls } = deps({
    getLoopPoints: () => ({ loopStart: 0, loopEnd: 1 }),
    hasUnsavedChanges: () => false,
    fluctuationDirty: () => false,
    currentFilters: () => ({}),
    currentCrossfadeMs: () => 0,
    currentSpeedPitch: () => ({}),
    currentPlayMode: () => 'loop',
    currentScatterConfig: () => ({}),
    currentScheduleConfig: () => ({}),
    getEditingPresetId: () => null,
    getFluctuation: () => ({}),
    commitSavedSnapshot: () => {},
    setStatus: () => {},
    api: {
      library: {
        updateLoopPoints: () => gate, updateFilters: async () => {}, updateCrossfade: async () => {},
        updateSpeedPitch: async () => {}, updatePlayMode: async () => {}, updateScatterConfig: async () => {}, updateSchedule: async () => {}
      }
    }
  })
  const ctl = createSaveController(d)
  const first = ctl.save()
  assert.equal(ctl.isSaving(), true)
  await ctl.save()
  assert.equal(calls.filter((c) => c[0] === 'working').length, 1)
  release()
  await first
  assert.deepEqual(calls.at(-3), ['emit', 'noctivago:sound-baseline-changed', 's1'])
  assert.deepEqual(calls.at(-1), ['done', 'Changes saved'])
  assert.equal(ctl.isSaving(), false)
})

test('Save as copy writes a new sound with the current settings and bakes it', async () => {
  const written = []
  const status = []
  const rec = (name) => async (...a) => { written.push([name, ...a]) }
  const { d } = deps({
    getLoopPoints: () => ({ loopStart: 1, loopEnd: 3 }),
    currentFilters: () => ({ f: 1 }),
    currentCrossfadeMs: () => 500,
    currentSpeedPitch: () => ({ dopplerEnabled: false }),
    currentPlayMode: () => 'scatter',
    currentScatterConfig: () => ({ s: 1 }),
    currentScheduleConfig: () => ({ c: 1 }),
    nextCopyName: (n) => `${n} copy`,
    setStatus: (t) => status.push(t),
    setSaveAsCopyDisabled: (v) => status.push(`disabled:${v}`),
    refreshLibrary: async () => status.push('refresh'),
    api: {
      library: {
        duplicateSound: async (id, o) => ({ id: 'new', ...o, from: id }),
        updateLoopPoints: rec('loop'), updateFilters: rec('filters'), updateCrossfade: rec('xfade'),
        updateSpeedPitch: rec('sp'), updatePlayMode: rec('mode'), updateScatterConfig: rec('scatter'), updateSchedule: rec('schedule')
      },
      audio: { renderLoopClip: async (id, o) => { written.push(['bake', id, o.crossfadeSeconds]); return { ok: true } } }
    }
  })
  await createSaveController(d).saveAsCopy()
  assert.deepEqual(written.find((w) => w[0] === 'loop'), ['loop', 'new', { loopStart: 1, loopEnd: 3 }])
  assert.deepEqual(written.find((w) => w[0] === 'xfade'), ['xfade', 'new', 0.5])
  assert.deepEqual(written.at(-1), ['bake', 'new', 0])
  assert.deepEqual(status, ['disabled:true', 'Saving a copy as "Rain copy"…', 'disabled:false', 'Saved a copy: "Rain copy".', 'refresh'])
})

test('Save segment reports a failure to create the sound', async () => {
  const status = []
  const { d } = deps({
    getLoopPoints: () => ({ loopStart: 0, loopEnd: 1 }),
    nextCopyName: (n) => `${n} copy`,
    setStatus: (t) => status.push(t),
    setSaveSegmentDisabled: (v) => status.push(`disabled:${v}`),
    api: { library: { duplicateSound: async () => null } }
  })
  await createSaveController(d).saveSegmentAsNew()
  assert.deepEqual(status, ['disabled:true', 'Saving the segment as "Rain copy"…', 'disabled:false', 'Save segment failed — could not create the new sound.'])
})
