import test from 'node:test'
import assert from 'node:assert/strict'
import { mountLoopEditor, mountWaveformScrollbar } from '../src/mounts/loopEditorMount.js'
import { mountSeam } from '../src/mounts/seamMount.js'
import { mountSpectral } from '../src/mounts/spectralMount.js'
import { mountEqEditor, mountMixEqTargets } from '../src/mounts/eqMount.js'
import { mountMixFluctuation } from '../src/mounts/mixFlucMount.js'

// A controller whose onX methods record the handler, so a test can fire it.
function fakeController(extra = {}) {
  const handlers = {}
  const calls = []
  return new Proxy(
    { handlers, calls, ...extra },
    {
      get(t, k) {
        if (k in t) return t[k]
        if (typeof k !== 'string') return undefined
        if (/^on[A-Z]/.test(k)) return (fn) => (handlers[k] = fn)
        return (...a) => calls.push([k, ...a])
      }
    }
  )
}

function fakeEl(extra = {}) {
  const listeners = {}
  return { value: '', listeners, addEventListener: (n, fn) => (listeners[n] = fn), classList: { toggle(n, on) { this.last = [n, on] } }, ...extra }
}

function recorder() {
  const log = []
  const c = new Proxy({}, { get: (t, k) => (k in t ? t[k] : typeof k === 'string' ? (...a) => (log.push([k, ...a]), undefined) : undefined) })
  return { c, log }
}

test('mountLoopEditor routes loop, scrub, doppler and envelope events to the tab', () => {
  const ctl = fakeController()
  const { c, log } = recorder()
  const got = mountLoopEditor({ canvas: 'cv' }, c, () => ctl)
  assert.equal(got, ctl)
  ctl.handlers.onLoopChange({ loopStart: 1, loopEnd: 2 })
  ctl.handlers.onScrub(3)
  ctl.handlers.onDopplerChange()
  ctl.handlers.onEnvelopeChange()
  assert.deepEqual(log, [['commitLoopPoints', 1, 2], ['scrubPreview', 3, false], ['updateSaveButtonState'], ['applyFilterControls']])
})

test('mountLoopEditor writes fades into the active play mode fields', () => {
  const ctl = fakeController()
  const els = { canvas: 'cv', scatterFadeIn: {}, scatterFadeOut: {}, scatterFadeEnabled: 'se', scheduleFadeIn: {}, scheduleFadeOut: {}, scheduleFadeEnabled: 'ce' }
  const synced = []
  let mode = 'scatter'
  const c = { commitLoopPoints() {}, scrubPreview() {}, updateSaveButtonState() { synced.push('save') }, applyFilterControls() {}, currentPlayMode: () => mode, syncFadeToggle: (...a) => synced.push(a) }
  mountLoopEditor(els, c, () => ctl)
  ctl.handlers.onFadesChange({ fadeInSec: 0.25, fadeOutSec: 1 })
  assert.equal(els.scatterFadeIn.value, '250')
  assert.equal(els.scatterFadeOut.value, '1000')
  assert.equal(els.scheduleFadeIn.value, undefined)
  mode = 'scheduled'
  ctl.handlers.onFadesChange({ fadeInSec: 2, fadeOutSec: 3 })
  assert.equal(els.scheduleFadeIn.value, '2000')
  assert.equal(synced.filter((x) => x === 'save').length, 2)
})

test('mountWaveformScrollbar links scrollbar and viewport both ways', () => {
  const bar = fakeController()
  const ed = fakeController()
  const { c, log } = recorder()
  mountWaveformScrollbar({ scrollbarTrack: 't', scrollbarThumb: 'h' }, ed, c, () => bar)
  bar.handlers.onNavigate(1, 2)
  ed.handlers.onViewportChange({ viewStart: 1, viewEnd: 2, duration: 9 })
  assert.deepEqual(ed.calls, [['setViewport', 1, 2]])
  assert.deepEqual(bar.calls, [['update', 9, 1, 2]])
  assert.deepEqual(log, [['maybeFetchDetailPeaks', 1, 2, 9]])
})

test('mountSeam sets limits from the crossfade input and maps scrubs to source time', () => {
  const ctl = fakeController()
  const editor = fakeController()
  const els = { seamCanvas: 'cv', crossfade: { max: '4000', step: '50', value: '' } }
  const { c, log } = recorder()
  c.liveLayout = () => ({ loopStart: 0, loopEnd: 10, crossfade: 0, lead: 0, tail: 0 })
  mountSeam(els, editor, c, () => ctl)
  assert.deepEqual(ctl.calls[0].slice(0, 2), ['setLimits', { maxSeconds: 4, stepSeconds: 0.05, defaultSeconds: ctl.calls[0][1].defaultSeconds }])
  ctl.handlers.onCrossfadeChange(1.5)
  assert.equal(els.crossfade.value, '1500')
  assert.deepEqual(log, [['applyCrossfadeControl']])
})

test('mountSpectral clamps the reduction field and shows the panel only with getSpectrogram', () => {
  const ctl = fakeController()
  const editor = fakeController()
  const els = {
    spectralCanvas: 'cv',
    spectralReduction: fakeEl({ value: '120' }),
    spectralShape: fakeEl(),
    spectralUseNoise: fakeEl(),
    spectralDelete: fakeEl(),
    spectralClear: fakeEl(),
    spectralSection: fakeEl()
  }
  const { c, log } = recorder()
  c.hasSpectrogram = false
  mountSpectral(els, editor, c, () => ctl)
  assert.deepEqual(els.spectralSection.classList.last, ['hidden', true])
  
  els.spectralReduction.listeners.input()
  assert.equal(ctl.calls.length, 0)
  els.spectralReduction.listeners.change()
  assert.equal(els.spectralReduction.value, '80')
  assert.deepEqual(ctl.calls.at(-1), ['setSelectedReduction', 80])
  els.spectralReduction.value = 'abc'
  els.spectralReduction.listeners.change()
  assert.equal(els.spectralReduction.value, '40')
  els.spectralShape.listeners.click({ target: { closest: () => ({ dataset: { shape: 'box' } }) } })
  assert.deepEqual(log.at(-1), ['setSpectralTool', 'box'])
  els.spectralShape.listeners.click({ target: { closest: () => null } })
  assert.equal(log.at(-1)[0], 'setSpectralTool')
  assert.equal(log.filter((l) => l[0] === 'setSpectralTool').length, 1)
})

test('mountSpectral noise drag fills the From/To fields and applies only on the final event', () => {
  const ctl = fakeController()
  const editor = fakeController()
  const els = { spectralCanvas: 'cv', spectralReduction: fakeEl(), spectralShape: fakeEl(), spectralUseNoise: fakeEl(), spectralDelete: fakeEl(), spectralClear: fakeEl(), spectralSection: fakeEl() }
  const { c, log } = recorder()
  c.hasSpectrogram = true
  mountSpectral(els, editor, c, () => ctl)
  assert.deepEqual(els.spectralSection.classList.last, ['hidden', false])
  ctl.handlers.onNoiseChange({ startSec: 1, endSec: 2, final: false })
  assert.deepEqual(log.at(-1), ['setFilterValues', { denoiseSampleStartSec: 1, denoiseSampleEndSec: 2 }])
  editor.handlers.onNoiseSampleChange({ startSec: 1, endSec: 2, final: true })
  assert.deepEqual(log.slice(-2), [
    ['setFilterValues', { denoiseSampleStartSec: 1, denoiseSampleEndSec: 2, denoiseEnabled: true }],
    ['applyFilterControls']
  ])
})

test('mountEqEditor resets a node on double-click and alt-click', () => {
  const ctl = fakeController()
  const { c, log } = recorder()
  c.isSavedPreview = () => true
  mountEqEditor({ eqCanvas: 'cv' }, c, () => ctl)
  ctl.handlers.onNeedLive()
  assert.deepEqual(log, [['togglePreviewMode']])
  ctl.handlers.onDoubleClick(2)
  ctl.handlers.onAltClick(3)
  assert.deepEqual(ctl.calls, [
    ['setSelectedIndex', 2],
    ['setSelectedBand', { gainDb: 0 }],
    ['setSelectedIndex', 3],
    ['setSelectedBand', { gainDb: 0, q: 1, type: 'peaking', slope: 'gentle' }]
  ])
})

test('mountMixEqTargets builds a preset and a group target from their element ids', () => {
  const made = []
  const make = (o) => (made.push(o), { eq: { id: made.length } })
  const c = { getPresetSavedBands: () => 'p', getGroupSavedBands: () => 'g', onPresetApply: () => {}, onGroupApply: () => {} }
  const out = mountMixEqTargets('root', c, make, (root, id) => ({ root, id }))
  assert.deepEqual(made.map((m) => m.els.id), ['editor-mix-preset-eq', 'editor-mix-group-eq'])
  assert.equal(made[0].getSavedBands(), 'p')
  assert.equal(made[1].onApply, c.onGroupApply)
  assert.deepEqual([out.presetEq.id, out.groupEq.id], [1, 2])
})

test('mountMixFluctuation builds four bars and the control bundles', () => {
  const bars = []
  const els = new Proxy({}, { get: (_t, k) => `el:${String(k)}` })
  const { c, log } = recorder()
  const out = mountMixFluctuation(els, c, (el, opts) => {
    const bar = { el, opts }
    bars.push(bar)
    return bar
  })
  assert.deepEqual(bars.map((b) => b.el), ['el:mixPresetFlucBar', 'el:mixGroupFlucBar', 'el:mixGroupFlucPitchBar', 'el:mixGroupFlucPanBar'])
  assert.equal(bars[0].opts.format(0.5), '50%')
  assert.equal(bars[2].opts.format(1), '+1.0 st')
  bars[0].opts.onChange({ min: 0.1 })
  bars[1].opts.onChange({ max: 0.9 })
  bars[2].opts.onChange()
  assert.deepEqual(log.map((l) => l[0]), ['patchPresetVolume', 'readPresetMixControlsAndPreview', 'patchGroupVolume', 'readGroupControlsAndPreview', 'readGroupControlsAndPreview'])
  assert.equal(out.presetFlucEls.bar, bars[0])
  assert.equal(out.groupFlucEls.pitch.bar, bars[2])
  assert.equal(out.groupFlucEls.pan.bar, bars[3])
  assert.equal(out.groupFlucEls.pitch.perSoundLocked, true)
  assert.equal(out.groupFlucEls.enabledEl, 'el:mixGroupFlucEnabled')
})
