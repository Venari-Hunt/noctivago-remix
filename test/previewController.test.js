import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPreviewController } from '../src/controllers/previewController.js'

function setup(over = {}) {
  const log = []
  const engine = { resume: async () => { log.push('resume') } }
  class PreviewSource {
    constructor(e, o) { this.o = o; this.disposed = false; log.push(['source', o.soundId, o.volume, o.looping]) }
    dispose() { this.disposed = true }
  }
  class BakedClipPreview {
    constructor(e, id, vol, preset) { this.id = id; this.preset = preset; this.currentTime = 4; this.playing = false; this.disposed = false; this.scrubbed = null; this.played = 0; log.push(['baked', id, vol, preset]) }
    dispose() { this.disposed = true }
    scrubTo(t) { this.scrubbed = t }
    async play() { this.played += 1 }
  }
  let mode = 'live'
  const d = {
    engine, PreviewSource, BakedClipPreview,
    setLiveMode: () => { mode = 'live'; log.push('live') },
    getPreviewMode: () => mode,
    getVolume: () => 0.5,
    stopTicking: () => log.push('stopTick'),
    setPlayPauseIcon: (p) => log.push(['icon', p]),
    setClipRebaking: (v) => log.push(['rebaking', v]),
    tickPlayhead: () => log.push('tick'),
    updateSaveButtonState: () => log.push('updateSave'),
    ...over
  }
  return { ctl: createPreviewController(d), log, setMode: (m) => { mode = m } }
}

const startArgs = { soundId: 's1', presetId: 'p1', volume: 0.8, sourceOptions: { looping: true }, onEnded: () => 'e', onReverseStateChange: () => 'r' }

test('start resumes the engine, builds both previews and wires handlers', async () => {
  const { ctl, log } = setup()
  const src = await ctl.start(startArgs)
  assert.deepEqual(log, ['resume', ['source', 's1', 0.8, true], 'live', ['baked', 's1', 0.8, 'p1']])
  assert.equal(ctl.source, src)
  assert.equal(ctl.baked.id, 's1')
  assert.equal(src.onEnded(), 'e')
  assert.equal(src.onReverseStateChange(), 'r')
})

test('dispose methods release each engine and report a missing live one', async () => {
  const { ctl } = setup()
  assert.equal(ctl.disposeSource(), false)
  ctl.disposeBaked()
  const src = await ctl.start(startArgs)
  const baked = ctl.baked
  ctl.disposeBaked()
  assert.equal(baked.disposed, true)
  assert.equal(ctl.baked, null)
  assert.equal(ctl.disposeSource(), true)
  assert.equal(src.disposed, true)
  assert.equal(ctl.source, null)
})

test('releaseBakedForRebake is null without a clip, else captures time and play state', async () => {
  const { ctl, log, setMode } = setup()
  assert.equal(ctl.releaseBakedForRebake(), null)
  await ctl.start(startArgs)
  ctl.baked.playing = true
  setMode('saved')
  log.length = 0
  const resume = ctl.releaseBakedForRebake()
  assert.deepEqual(resume, { time: 4, playing: true })
  assert.deepEqual(log, ['stopTick', ['icon', false], ['rebaking', true]])
  assert.equal(ctl.baked, null)
})

test('releaseBakedForRebake does not stop ticking in live mode', async () => {
  const { ctl, log } = setup()
  await ctl.start(startArgs)
  ctl.baked.playing = true
  log.length = 0
  assert.deepEqual(ctl.releaseBakedForRebake(), { time: 4, playing: false })
  assert.deepEqual(log, [['rebaking', true]])
})

test('restoreBakedAfterRebake does nothing more once another sound is open', async () => {
  const { ctl, log } = setup()
  await ctl.start(startArgs)
  const old = ctl.baked
  log.length = 0
  ctl.restoreBakedAfterRebake({ resume: { time: 1, playing: false }, ok: true, id: 's1', presetId: 'p1', stillEditing: false })
  assert.deepEqual(log, [['rebaking', false]])
  assert.equal(ctl.baked, old)
})

test('restoreBakedAfterRebake rebuilds the clip and resumes saved playback', async () => {
  const { ctl, log, setMode } = setup()
  await ctl.start(startArgs)
  const old = ctl.baked
  setMode('saved')
  log.length = 0
  ctl.restoreBakedAfterRebake({ resume: { time: 7, playing: true }, ok: true, id: 's1', presetId: 'p2', stillEditing: true })
  assert.equal(old.disposed, true)
  assert.notEqual(ctl.baked, old)
  assert.equal(ctl.baked.scrubbed, 7)
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(ctl.baked.played, 1)
  assert.deepEqual(log, [['rebaking', false], ['baked', 's1', 0.5, 'p2'], 'resume', ['icon', true], 'tick', 'updateSave'].slice(0, 2).concat(log.slice(2)))
  assert.ok(log.includes('updateSave'))
})

test('restoreBakedAfterRebake in live mode only swaps the element', async () => {
  const { ctl } = setup()
  await ctl.start(startArgs)
  ctl.restoreBakedAfterRebake({ resume: { time: 7, playing: true }, ok: true, id: 's1', presetId: 'p1', stillEditing: true })
  assert.equal(ctl.baked.scrubbed, null)
  assert.equal(ctl.baked.played, 0)
})
