// One EQ target (rebuild plan step 8): everything a Group or Preset EQ needs
// around its EqEditor controller: band fields, add/remove/invert/mute/solo,
// A/B compare, the revert banner. It replaces the two copies RemixTab kept
// (presetEq* and groupEq*). Plain JS so RemixTab (a class) and React can both
// use it: `useEqTarget` is the hook form, `createEqTarget` the plain one.
//
// The caller owns what "saved" and "apply" mean:
//   getSavedBands() -> bands the target was last saved with (B in compare)
//   onApply(bands)  -> store the new bands, refresh mode UI, preview
// No DOM is created here; `els` are the ids EqView.jsx already renders.
import { useMemo } from 'react'
import { createEqEditorController, Q_MIN, Q_MAX, SLOPE_CAPABLE_EQ_TYPES } from './EqEditor.js'
import { defaultEqBands } from '../domain/mixSettings.js'

const ELS = ['canvas', 'compare-a', 'compare-b', 'revert-banner', 'add-band', 'remove-band', 'zoom-in', 'zoom-out', 'invert', 'type', 'slope', 'slope-label', 'freq', 'gain', 'q', 'mute', 'solo', 'reset']
const camel = (s) => s.replace(/-(\w)/g, (_, c) => c.toUpperCase())

export function eqElements(root, prefix) {
  const out = {}
  for (const name of ELS) out[camel(name)] = root.querySelector(`#${prefix}-${name}`)
  return out
}

// Same clamps the three copies used.
export function readBandFields(values) {
  const num = (v, lo, hi) => Math.min(hi, Math.max(lo, Number(v)))
  return {
    type: values.type,
    slope: values.slope,
    freqHz: num(values.freq, 20, 20000),
    gainDb: num(values.gain, -24, 24),
    q: num(values.q, Q_MIN, Q_MAX)
  }
}

export function bandsDiffer(a, b) {
  return JSON.stringify(a) !== JSON.stringify(b ?? [])
}

const copyBands = (bands) => bands.map((b) => ({ ...b }))

export function createEqTarget({ els, getSavedBands, onApply, controller }) {
  const eq = controller ?? createEqEditorController(els.canvas)
  let viewing = 'A'
  let stash = null

  const updateFields = () => {
    const band = eq.getSlots()[eq.getSelectedIndex()]
    const readOnly = eq.isReadOnly()
    const disabled = readOnly || !band
    for (const k of ['type', 'freq', 'gain', 'q', 'mute', 'solo', 'removeBand']) els[k].disabled = disabled
    els.addBand.disabled = readOnly
    if (!band) {
      els.type.value = 'peaking'
      els.freq.value = ''
      els.gain.value = ''
      els.q.value = ''
      els.slope.value = 'gentle'
      els.slope.disabled = true
      els.slopeLabel.classList.add('hidden')
      els.mute.classList.remove('editor-eq-mute-active')
      els.solo.classList.remove('editor-eq-solo-active')
      return
    }
    els.type.value = band.type ?? 'peaking'
    els.freq.value = String(Math.round(band.freqHz))
    els.gain.value = String(band.gainDb)
    els.q.value = String(band.q)
    const slopeCapable = SLOPE_CAPABLE_EQ_TYPES.includes(band.type)
    els.slope.value = band.slope ?? 'gentle'
    els.slope.disabled = disabled || !slopeCapable
    els.slopeLabel.classList.toggle('hidden', !slopeCapable)
    els.mute.classList.toggle('editor-eq-mute-active', Boolean(band.muted))
    els.solo.classList.toggle('editor-eq-solo-active', eq.getSoloIndex() === eq.getSelectedIndex())
  }
  const differs = () => bandsDiffer(eq.getBands(), getSavedBands())
  const updateBanner = () => els.revertBanner.classList.toggle('hidden', !(viewing === 'A' && differs()))
  const updateCompareButtons = () => {
    els.compareA.classList.toggle('editor-eq-compare-btn-active', viewing === 'A')
    els.compareB.classList.toggle('editor-eq-compare-btn-active', viewing === 'B')
  }
  const apply = () => {
    updateFields()
    onApply(eq.getBands())
    updateBanner()
  }
  // The graph just changed by itself: refresh the fields, then apply.
  const edit = (change) => {
    change()
    apply()
  }
  const selectAnd = (index, band) => {
    eq.setSelectedIndex(index)
    eq.setSelectedBand(band)
    apply()
  }
  const switchCompare = (target) => {
    if (target === viewing) return
    if (target === 'B') {
      stash = eq.getBands()
      eq.load(copyBands(getSavedBands() ?? []))
    } else {
      eq.load(copyBands(stash ?? eq.getBands()))
      stash = null
    }
    viewing = target
    eq.setReadOnly(target === 'B')
    apply()
    updateCompareButtons()
  }
  const revert = () => {
    stash = null
    viewing = 'A'
    eq.setReadOnly(false)
    eq.load(copyBands(getSavedBands() ?? []))
    apply()
    updateCompareButtons()
  }
  const resetCompare = () => {
    viewing = 'A'
    stash = null
    eq.setReadOnly(false)
    updateCompareButtons()
    updateBanner()
  }

  eq.onChange(apply)
  eq.onDoubleClick((index) => selectAnd(index, { gainDb: 0 }))
  eq.onAltClick((index) => selectAnd(index, { gainDb: 0, q: 1, type: 'peaking', slope: 'gentle' }))
  eq.setTrashDropTarget(els.removeBand)

  const fieldsToBand = () => edit(() => eq.setSelectedBand(readBandFields({ type: els.type.value, slope: els.slope.value, freq: els.freq.value, gain: els.gain.value, q: els.q.value })))
  els.type.addEventListener('change', fieldsToBand)
  els.slope.addEventListener('change', fieldsToBand)
  for (const k of ['freq', 'gain', 'q']) els[k].addEventListener('input', fieldsToBand)
  els.reset.addEventListener('click', () => edit(() => eq.load(defaultEqBands())))
  els.addBand.addEventListener('click', () => edit(() => eq.addBand()))
  els.removeBand.addEventListener('click', () => edit(() => eq.removeSelectedBand()))
  els.invert.addEventListener('click', () => edit(() => eq.invertBands()))
  els.zoomIn.addEventListener('click', () => eq.zoomIn())
  els.zoomOut.addEventListener('click', () => eq.zoomOut())
  els.compareA.addEventListener('click', () => switchCompare('A'))
  els.compareB.addEventListener('click', () => switchCompare('B'))
  els.revertBanner.addEventListener('click', revert)
  els.mute.addEventListener('click', () => {
    const band = eq.getSlots()[eq.getSelectedIndex()]
    if (!band) return
    eq.setSelectedBand({ muted: !band.muted })
    apply()
  })
  els.solo.addEventListener('click', () => {
    const idx = eq.getSelectedIndex()
    if (idx === -1) return
    eq.setSoloIndex(eq.getSoloIndex() === idx ? -1 : idx)
    apply()
  })

  return {
    eq,
    apply,
    updateFields,
    updateBanner,
    differs,
    resetCompare,
    // Load bands from outside (selection changed, save finished) without applying.
    load(bands) {
      eq.load(bands)
      updateFields()
    },
    get viewing() {
      return viewing
    },
    destroy: () => eq.destroy?.()
  }
}

// Hook form: one target per component, created on first render.
export function useEqTarget(options) {
  return useMemo(() => createEqTarget(options), []) // eslint-disable-line react-hooks/exhaustive-deps
}
