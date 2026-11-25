import test from 'node:test'
import assert from 'node:assert/strict'
import { entryLoadState, waveformStatusText, waveformTimeout, createSoundLoader } from '../src/controllers/soundLoader.js'

test('entryLoadState defaults every field of a bare entry', () => {
  const s = entryLoadState({ id: 'a' })
  assert.equal(s.playMode, 'loop')
  assert.equal(s.speedPitch.speed, 1)
  assert.equal(s.speedPitch.dopplerEnabled, false)
  assert.ok(Array.isArray(s.filters.eq))
  assert.ok(s.scatter && s.schedule && s.fluctuation)
  assert.equal(typeof s.crossfadeMs, 'number')
})

test('entryLoadState keeps saved values and rounds crossfade to ms', () => {
  const eq = [{ freqHz: 100, gainDb: 3 }]
  const sp = { speed: 2 }
  const s = entryLoadState({ crossfadeSeconds: 1.2344, speedPitch: sp, playMode: 'scatter', filters: { eq } })
  assert.equal(s.crossfadeMs, 1234)
  assert.equal(s.speedPitch, sp)
  assert.equal(s.playMode, 'scatter')
  assert.deepEqual(s.filters.eq, eq)
})

test('entryLoadState snapshot of the EQ is a copy', () => {
  const eq = [{ freqHz: 100, gainDb: 3 }]
  const s = entryLoadState({ filters: { eq } })
  assert.notEqual(s.eqSnapshot[0], s.filters.eq[0])
  s.filters.eq[0].gainDb = 9
  assert.equal(s.eqSnapshot[0].gainDb, 3)
})

test('entryLoadState neutral speedPitch is not shared between calls', () => {
  const a = entryLoadState({}).speedPitch
  a.speed = 5
  assert.equal(entryLoadState({}).speedPitch.speed, 1)
})

test('waveformStatusText', () => {
  assert.equal(waveformStatusText([1], null), '')
  assert.equal(waveformStatusText(null, 'boom'), 'Waveform failed to load: boom')
  assert.equal(waveformStatusText(null, null), 'Waveform preview unavailable for this file.')
})

test('waveformTimeout rejects after the delay and can be cleared', async () => {
  const t = waveformTimeout(5)
  await assert.rejects(t.promise, /no answer after 60 s/)
  const t2 = waveformTimeout(5)
  t2.clear()
  t2.promise.catch(() => {})
})

function harness(over = {}) {
  const calls = []
  const src = {
    waitForMetadata: async () => 10,
    setLoopPoints: () => calls.push('loopPoints'),
    setFilters: () => {}, setFluctuation: () => {}, scrubTo: () => {}
  }
  const loop = new Proxy({}, { get: (_, k) => (...a) => { calls.push(`loop.${String(k)}`) } })
  let current = null
  const d = new Proxy({
    api: { library: { updateMeta: async () => {} }, audio: { getBandEnergy: async () => null } },
    findEntry: (id) => (id === 'a' ? { id: 'a', name: 'A', loopStart: 1 } : null),
    currentId: () => current,
    setCurrentEntry: (e) => { current = e.id },
    pinEditingPreset: () => 'p',
    loopEditor: () => loop,
    previewSource: () => src,
    startPreview: async () => {},
    loadMarkers: () => [],
    snapshotOf: () => '{}',
    hasPeaksCached: () => true,
    getWaveformPeaks: async () => [1, 2],
    ...over
  }, { get: (t, k) => (k in t ? t[k] : (...a) => { calls.push(String(k)) }) })
  return { d, calls }
}

test('load does nothing past the entry lookup for an unknown id', async () => {
  const { d, calls } = harness()
  await createSoundLoader(d).load('missing')
  assert.deepEqual(calls, ['beforeLoad'])
})

test('load runs the whole sequence for a known sound', async () => {
  const { d, calls } = harness()
  await createSoundLoader(d).load('a')
  assert.ok(calls.indexOf('disposePreview') < calls.indexOf('showEditor'))
  assert.ok(calls.indexOf('loop.load') < calls.indexOf('loop.setEnvelope'))
  assert.ok(calls.includes('updateSaveButtonState'))
  assert.ok(calls.includes('loop.setPeaks'))
  assert.ok(calls.includes('setWaveformStatus'))
})

test('load stops when another sound was picked while metadata loaded', async () => {
  let current
  const { d, calls } = harness({
    setCurrentEntry: (e) => { current = e.id },
    currentId: () => current,
    previewSource: () => ({ waitForMetadata: async () => { current = 'other'; return 10 } })
  })
  await createSoundLoader(d).load('a')
  assert.ok(!calls.includes('loop.load'))
})

test('load reports a peaks failure in the status line', async () => {
  const texts = []
  const { d } = harness({
    getWaveformPeaks: async () => { throw new Error('nope') },
    setWaveformStatus: (t) => texts.push(t)
  })
  const orig = console.error
  console.error = () => {}
  try { await createSoundLoader(d).load('a') } finally { console.error = orig }
  assert.equal(texts.at(-1), 'Waveform failed to load: nope')
})
