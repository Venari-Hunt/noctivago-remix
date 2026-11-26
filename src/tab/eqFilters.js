// EQ and filter methods of the Remix tab. Each takes the tab.
import { Q_MIN, Q_MAX, SLOPE_CAPABLE_EQ_TYPES } from '../components/EqEditor.js'

// Shared by Reset filters and every preset button, both of which just set
// all five slider values from a filters object before re-applying. Presets
// (see FILTER_PRESETS) don't define .eq at all - the EQ graph is a
// separate, more precise tool than a one-click coloration preset, so a
// preset click deliberately leaves it untouched; only an explicit
// filters.eq (Reset filters' NEUTRAL_FILTERS, or a loaded sound's own
// saved bands) actually replaces it.
export function setFilterSliders(tab, filters) {
  tab.filterControls.setValues({
    highpassHz: filters.highpassHz,
    lowpassHz: filters.lowpassHz,
    gainDb: filters.gainDb,
    // Effect presets don't define pan (placement isn't part of a sound's
    // character), so a preset click leaves it where it is - setValues
    // skips undefined keys.
    pan: filters.pan,
    gateThresholdDb: filters.gateThresholdDb ?? -80,
    gateRangeDb: filters.gateRangeDb ?? 0,
    gateAttackMs: filters.gateAttackMs ?? 10,
    gateReleaseMs: filters.gateReleaseMs ?? 150,
    denoiseEnabled: Boolean(filters.denoiseEnabled),
    denoiseStrengthDb: filters.denoiseStrengthDb ?? 12,
    denoiseSampleStartSec: filters.denoiseSampleStartSec ?? 0,
    denoiseSampleEndSec: filters.denoiseSampleEndSec ?? 0,
    echoDelayMs: filters.echoDelayMs ?? 0,
    echoDecay: filters.echoDecay ?? 0,
    reverbSizeMs: filters.reverbSizeMs ?? 0,
    reverbMix: filters.reverbMix ?? 0
  })
  if (filters.eq) {
    tab.eqEditorController.load(filters.eq)
    tab.updateEqFieldsFromSelection()
  }
  if (filters.volumeEnvelope) {
    tab.loopEditorController.setEnvelope(filters.volumeEnvelope.enabled, filters.volumeEnvelope.points)
    tab.els.envelopeEnabled.checked = Boolean(filters.volumeEnvelope.enabled)
  }
  // Effect presets don't define it, so a preset click keeps the boxes.
  if (filters.spectralRepairs) {
    tab.spectralView.setRegions(filters.spectralRepairs)
    tab.updateSpectralControls()
  }
  tab.syncNoiseBand()
}

export function currentFilters(tab) {
  return {
    ...tab.filterControls.getValues(),
    eq: tab.eqEditorController.getBands(),
    volumeEnvelope: tab.loopEditorController.getEnvelope(),
    spectralRepairs: tab.spectralView.getRegions()
  }
}

// What the *live preview* should actually hear, distinct from
// currentFilters() (the real, saved-and-savable state) - a soloed band
// bypasses every other band for the preview only, without touching their
// real .muted values, since Solo is an audition aid that's never part of
// what gets persisted or baked. The soloed band itself is force-unmuted so
// soloing still lets you hear it even if it happens to be muted for real.
export function previewFilters(tab) {
  const filters = tab.currentFilters()
  const soloIndex = tab.eqEditorController.getSoloIndex()
  if (soloIndex === -1) return filters
  return {
    ...filters,
    eq: filters.eq.map((band, i) => ({ ...band, muted: i !== soloIndex }))
  }
}

// Reflects the EQ editor's currently-selected node in the precision-entry
// fields (see EqEditor.js's setSelectedBand for the reverse direction) -
// called whenever the selection or its values change, whatever the source
// (a drag, a wheel Q adjustment, a fresh load, or Reset EQ).
export function updateEqFieldsFromSelection(tab) {
  const bands = tab.eqEditorController.getSlots()
  const index = tab.eqEditorController.getSelectedIndex()
  const band = bands[index]
  // Nothing selected - either a blank EQ, or a band was just deleted
  // (which always clears selection, see EqEditor.js's removeSelectedBand).
  // Disable the precision fields entirely rather than leaving them
  // showing a stale, no-longer-meaningful value from whatever was
  // previously selected. `disabled` (below) additionally locks the fields
  // while viewing the read-only B (last saved) reference - "just a display
  // for the user" - but `hasSelection` alone still governs whether they
  // show B's real values or blank, so a selected B band reads as a real,
  // inspectable (if uneditable) value rather than going blank.
  const readOnly = tab.eqEditorController.isReadOnly()
  const hasSelection = Boolean(band)
  const disabled = readOnly || !hasSelection
  tab.els.eqType.disabled = disabled
  tab.els.eqFreq.disabled = disabled
  tab.els.eqGain.disabled = disabled
  tab.els.eqQ.disabled = disabled
  tab.els.eqMute.disabled = disabled
  tab.els.eqSolo.disabled = disabled
  tab.els.eqRemoveBand.disabled = disabled
  tab.els.eqAddBand.disabled = readOnly
  if (!hasSelection) {
    tab.els.eqType.value = 'peaking'
    tab.els.eqFreq.value = ''
    tab.els.eqGain.value = ''
    tab.els.eqQ.value = ''
    tab.els.eqSlope.value = 'gentle'
    tab.els.eqSlope.disabled = true
    tab.els.eqSlopeLabel.classList.add('hidden')
    tab.els.eqMute.classList.remove('editor-eq-mute-active')
    tab.els.eqSolo.classList.remove('editor-eq-solo-active')
    return
  }
  tab.els.eqType.value = band.type ?? 'peaking'
  tab.els.eqFreq.value = String(Math.round(band.freqHz))
  tab.els.eqGain.value = String(band.gainDb)
  tab.els.eqQ.value = String(band.q)
  // Slope only means anything for the four filter-*shaped* types (a
  // rolloff steepness) - peaking/shelf bands are gain-shaped, not
  // rolloff-shaped, and 'off' does nothing at all, so the control hides
  // entirely rather than showing a value with no real effect.
  const slopeCapable = SLOPE_CAPABLE_EQ_TYPES.includes(band.type)
  tab.els.eqSlope.value = band.slope ?? 'gentle'
  tab.els.eqSlope.disabled = disabled || !slopeCapable
  tab.els.eqSlopeLabel.classList.toggle('hidden', !slopeCapable)
  tab.els.eqMute.classList.toggle('editor-eq-mute-active', Boolean(band.muted))
  tab.els.eqSolo.classList.toggle('editor-eq-solo-active', tab.eqEditorController.getSoloIndex() === index)
}

export function applyEqFieldsToSelectedBand(tab) {
  const type = tab.els.eqType.value
  const slope = tab.els.eqSlope.value
  const freqHz = Math.min(20000, Math.max(20, Number(tab.els.eqFreq.value)))
  const gainDb = Math.min(24, Math.max(-24, Number(tab.els.eqGain.value)))
  const q = Math.min(Q_MAX, Math.max(Q_MIN, Number(tab.els.eqQ.value)))
  tab.eqEditorController.setSelectedBand({ type, slope, freqHz, gainDb, q })
  tab.applyEqControls()
}

// Fires on every EQ graph change (drag, wheel Q) and every precision-field
// edit - same live-preview + dirty-state pattern as applyFilterControls,
// since EQ is just another part of the same filters bag now.
export function applyEqControls(tab) {
  tab.updateEqFieldsFromSelection()
  tab.previewSource?.setFilters(tab.previewFilters())
  tab.updateSaveButtonState()
  tab.updateEqRevertBannerVisibility()
}

// True whenever the live EQ bands (A) differ from the immutable saved
// snapshot (B) - a plain JSON comparison, same technique the dirty-check
// elsewhere in this file already uses, just scoped to EQ only.
export function eqDiffersFromSaved(tab) {
  if (!tab.eqEditorController) return false
  return JSON.stringify(tab.eqEditorController.getBands()) !== JSON.stringify(tab.savedEqSnapshot)
}

// The revert prompt only makes sense while actively editing (viewing A)
// and only when there's actually something to discard - showing an
// actionable "revert" banner when A already matches B would be confusing.
export function updateEqRevertBannerVisibility(tab) {
  const show = tab.eqCompareViewing === 'A' && tab.eqDiffersFromSaved()
  tab.els.eqRevertBanner.classList.toggle('hidden', !show)
}

// Switches which side of the compare is being viewed. B is a read-only
// reference (see EqEditorController.setReadOnly) - switching to it stashes
// A's live bands so editing can resume exactly where it left off when
// switching back, rather than losing in-progress work.
export function switchEqCompareView(tab, target) {
  if (target === tab.eqCompareViewing || !tab.eqEditorController) return
  if (target === 'B') {
    tab.eqLiveBandsStash = tab.eqEditorController.getBands()
    tab.eqEditorController.load(tab.savedEqSnapshot.map((b) => ({ ...b })))
  } else {
    tab.eqEditorController.load((tab.eqLiveBandsStash ?? tab.eqEditorController.getBands()).map((b) => ({ ...b })))
    tab.eqLiveBandsStash = null
  }
  tab.eqCompareViewing = target
  tab.eqEditorController.setReadOnly(target === 'B')
  tab.updateEqFieldsFromSelection()
  tab.applyEqControls()
  tab.updateEqCompareButtonsUI()
}

export function updateEqCompareButtonsUI(tab) {
  tab.els.eqCompareA.classList.toggle('editor-eq-compare-btn-active', tab.eqCompareViewing === 'A')
  tab.els.eqCompareB.classList.toggle('editor-eq-compare-btn-active', tab.eqCompareViewing === 'B')
}

// The revert banner's action: discards every unsaved EQ edit, replacing
// the live (A) bands with an exact copy of the saved (B) snapshot -
// switches back to viewing A first if B was on screen, since after this
// there's nothing left to distinguish them anyway.
export function revertEqToSaved(tab) {
  if (!tab.eqEditorController) return
  tab.eqLiveBandsStash = null
  tab.eqCompareViewing = 'A'
  tab.eqEditorController.setReadOnly(false)
  tab.eqEditorController.load(tab.savedEqSnapshot.map((b) => ({ ...b })))
  tab.updateEqFieldsFromSelection()
  tab.applyEqControls()
  tab.updateEqCompareButtonsUI()
}

// Resets compare state for a freshly loaded sound - A/B is a per-editing-
// session workflow aid, not something that should carry over between
// sounds. savedEqSnapshot itself is captured separately in loadSound()
// (needs the just-loaded entry's own filters.eq, not available here).
export function resetEqCompare(tab) {
  tab.eqCompareViewing = 'A'
  tab.eqLiveBandsStash = null
  tab.eqEditorController?.setReadOnly(false)
  tab.updateEqCompareButtonsUI()
  tab.updateEqRevertBannerVisibility()
}

export function applyFilterControls(tab) {
  tab.previewSource?.setFilters(tab.previewFilters())
  tab.updateSaveButtonState()
  tab.syncNoiseBand()
}
