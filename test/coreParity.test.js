import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadCore } from './helpers/core.js'
import { stereoPanMatrix } from '../src/audio/PanStage.js'
import { MAX_BUFFER_CLIP_SECONDS, OVERRIDABLE_SOUND_KEYS } from '../src/domain/mixSettings.js'

test("stereoPanMatrix matches the app's src/shared/pan.js", async (t) => {
  const core = await loadCore('src/shared/pan.js')
  if (!core) return t.skip('GitHub unreachable')
  for (let p = -1; p <= 1; p += 0.01) assert.deepEqual(stereoPanMatrix(p), core.module.stereoPanMatrix(p))
})

test("constants match the app's src/shared/constants.js", async (t) => {
  const core = await loadCore('src/shared/constants.js')
  if (!core) return t.skip('GitHub unreachable')
  assert.equal(MAX_BUFFER_CLIP_SECONDS, core.module.MAX_BUFFER_CLIP_SECONDS)
  assert.deepEqual(OVERRIDABLE_SOUND_KEYS, core.module.OVERRIDABLE_SOUND_KEYS)
})

test("dopplerSemitones matches the app's src/shared/doppler.js", async (t) => {
  const core = await loadCore('src/shared/doppler.js')
  if (!core) return t.skip('GitHub unreachable, or the app has not published doppler.js yet')
  const { dopplerSemitones } = await import('../src/domain/doppler.js')
  for (const reversed of [false, true]) {
    for (const sharp of [0, 0.5, 1]) {
      for (let tt = 0; tt <= 10; tt += 0.25) {
        assert.equal(dopplerSemitones(tt, 10, 0.3, 6, reversed, sharp), core.module.dopplerSemitones(tt, 10, 0.3, 6, reversed, sharp))
      }
    }
  }
})

test("the Spectral repair and noise DSP files match the app's copies", async (t) => {
  const fs = await import('node:fs')
  for (const name of ['spectralRepairDsp.js', 'noiseReductionDsp.js']) {
    const core = await loadCore('src/shared/' + name)
    if (!core) return t.skip('GitHub unreachable, or the app has not published ' + name + ' yet')
    const mine = fs.readFileSync(new URL('../src/audio/' + name, import.meta.url), 'utf8')
    assert.ok(mine.endsWith(core.text) || mine.includes(core.text.trim()), name + ' differs from the app copy')
  }
})
