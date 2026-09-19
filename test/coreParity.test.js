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
