// Fluctuation (drift) methods of the Remix tab. Each takes the tab.
import { loadedFluctuation, fluctuationFingerprint, isFluctuationDirty } from '../domain/driftState.js'
import { flucSeconds } from '../domain/mixSettings.js'

// --- Fluctuation (v0.1.164; flat-seconds timing + Fully-random v0.1.176) ---
// Pushes entry.fluctuation into the two bars + the seconds fields, called
// from loadSound. The bars own their own min/bias/max; the number fields +
// checkboxes own enabled / fullyRandom / changeMin/MaxSeconds /
// transitionSeconds.
export function setFluctuationControls(tab, fluctuation) {
  const f = loadedFluctuation(fluctuation)
  tab.fluctuation = f
  tab.writeFluctuationAxisFields('flucVol', f.volume)
  tab.flucVolBar.setValues(f.volume)
  tab.writeFluctuationAxisFields('flucPitch', f.pitch)
  tab.flucPitchBar.setValues(f.pitch)
  tab.writeFluctuationAxisFields('flucPan', f.pan)
  tab.flucPanBar.setValues(f.pan)
  tab.updateFluctuationEnabledUI()
  // Freshly loaded from the library == the saved baseline for the dirty-check.
  tab.savedFluctuationSnapshot = tab.fluctuationSnapshot()
}

export function writeFluctuationAxisFields(tab, key, axis) {
  tab.els[`${key}Enabled`].checked = axis.enabled
  tab.els[`${key}FullRandom`].checked = axis.fullyRandom
  tab.els[`${key}ChangeMin`].value = String(axis.changeMinSeconds)
  tab.els[`${key}ChangeMax`].value = String(axis.changeMaxSeconds)
  tab.els[`${key}Transition`].value = String(axis.transitionSeconds)
  tab.els[`${key}Bias`].checked = axis.biasEnabled !== false
}

export function updateFluctuationEnabledUI(tab) {
  for (const [key, bar] of [
    ['flucVol', tab.flucVolBar],
    ['flucPitch', tab.flucPitchBar],
    ['flucPan', tab.flucPanBar]
  ]) {
    const on = tab.els[`${key}Enabled`].checked
    const random = tab.els[`${key}FullRandom`].checked
    bar.setEnabled(on && !random)
    bar.setBiasEnabled(tab.els[`${key}Bias`].checked)
    tab.els[`${key}Bias`].disabled = !on || random
    tab.els[`${key}FullRandom`].disabled = !on
    tab.els[`${key}ChangeMin`].disabled = !on
    tab.els[`${key}ChangeMax`].disabled = !on
    tab.els[`${key}Transition`].disabled = !on
  }
  // Drift is a live-preview / Mixer behavior only - warn if the user has an
  // axis on but is auditioning the baked "Saved audio" clip, which by
  // design has no fluctuation (so it'd look like the feature does nothing).
  const anyOn = tab.els.flucVolEnabled.checked || tab.els.flucPitchEnabled.checked || tab.els.flucPanEnabled.checked
  tab.els.fluctuationSavedNote?.classList.toggle('hidden', !(anyOn && tab.previewMode === 'saved'))
  tab.updateGroupOverrideNotes()
}

export function readFluctuationAxisFields(tab, key, bar) {
  const v = bar.getValues()
  return {
    enabled: tab.els[`${key}Enabled`].checked,
    fullyRandom: tab.els[`${key}FullRandom`].checked,
    biasEnabled: tab.els[`${key}Bias`].checked,
    min: v.min,
    max: v.max,
    bias: v.bias,
    changeMinSeconds: flucSeconds(tab.els[`${key}ChangeMin`].value, 6),
    changeMaxSeconds: flucSeconds(tab.els[`${key}ChangeMax`].value, 14),
    transitionSeconds: flucSeconds(tab.els[`${key}Transition`].value, 8, true)
  }
}

// Reads every fluctuation control into this.fluctuation, previews it live,
// and (debounced) persists + tells the Mixer. No snapshot/undo hookup by
// design - see the wireControls comment.
export function applyFluctuationControls(tab) {
  tab.fluctuation = {
    volume: tab.readFluctuationAxisFields('flucVol', tab.flucVolBar),
    pitch: tab.readFluctuationAxisFields('flucPitch', tab.flucPitchBar),
    pan: tab.readFluctuationAxisFields('flucPan', tab.flucPanBar)
  }
  tab.updateFluctuationEnabledUI()
  tab.previewSource?.setFluctuation(tab.fluctuation)
  tab.persistFluctuation()
  // Light the Save button now (it clears again a moment later when the
  // debounced write below lands - see flushFluctuation) so a drift edit
  // never looks like it went nowhere.
  tab.updateSaveButtonState()
}

export function persistFluctuation(tab) {
  if (!tab.currentEntry) return
  tab._pendingFluctuation = { id: tab.currentEntry.id, fluctuation: tab.fluctuation }
  clearTimeout(tab._fluctuationSaveTimer)
  tab._fluctuationSaveTimer = setTimeout(() => tab.flushFluctuation(), 400)
}

// Writes any pending fluctuation edit now (keyed by the captured id, so
// it's safe regardless of what's currently open) and tells the Mixer.
// Called on the debounce timer, and synchronously from loadSound before a
// sound switch so a fast switch can't drop the edit.
export function flushFluctuation(tab) {
  clearTimeout(tab._fluctuationSaveTimer)
  const pending = tab._pendingFluctuation
  if (!pending) return
  tab._pendingFluctuation = null
  const { id, fluctuation } = pending
  tab.api.library
    .updateFluctuation(id, fluctuation)
    .then(() => {
      if (tab.currentEntry?.id === id) tab.currentEntry.fluctuation = fluctuation
      window.dispatchEvent(
        new CustomEvent('noctivago:sound-fluctuation-changed', { detail: { soundId: id, fluctuation } })
      )
      // Confirm the write so the Save button and status line stop implying
      // the drift edit is unsaved (fluctuation persists on its own, no
      // manual Save needed - but a silent write reads as "nothing happened").
      if (tab.currentEntry?.id === id) {
        tab.savedFluctuationSnapshot = fluctuationFingerprint(fluctuation)
        tab.updateSaveButtonState()
        tab.els.saveStatus.textContent = 'Fluctuation applied — saved automatically (no bake needed).'
      }
    })
    .catch((err) => {
      console.error('Editor: fluctuation save failed', err)
      if (tab.currentEntry?.id === id) tab.els.saveStatus.textContent = 'Fluctuation change could not be saved.'
    })
}

// Normalized fingerprint of the current Fluctuation config, compared
// against savedFluctuationSnapshot to know whether the drift settings have
// unsaved edits. Kept separate from hasUnsavedChanges()/snapshotOf() on
// purpose: fluctuation is never baked, so a fluctuation-only change must
// NOT mark the saved loop clip stale or drive undo/A-B - it just needs the
// Save button to light up and a "saved" confirmation once it's written.
export function fluctuationSnapshot(tab) {
  return fluctuationFingerprint(tab.fluctuation)
}

export function fluctuationDirty(tab) {
  return isFluctuationDirty(tab.fluctuation, tab.savedFluctuationSnapshot)
}
