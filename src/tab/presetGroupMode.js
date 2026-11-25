// Preset mode and Group mode methods of the Remix tab. Each takes the tab.
import { AudioEngine } from '../audio/AudioEngine.js'
import { normalizeFluctuationAxis } from '../audio/Modulator.js'
import { formatPan, defaultMixFluctuation, flucSeconds, cloneWholeMix, cloneGroupFilters } from '../domain/mixSettings.js'
import { escapeHtml } from '../domain/html.js'

// --- Preset mode ---

export async function refreshMixPanel(tab) {
  // BUG FIX (v0.1.227): this used to set this.library to the raw shared
  // defaults, so a sound opened in Sound mode after visiting Preset/Group
  // mode showed (and then saved over its preset settings with) the shared
  // defaults. refreshLibrary() keeps the per-preset effective view and
  // refreshes this.presets too.
  await tab.refreshLibrary()
  const previous = tab.selectedPresetId
  tab.renderPresetSelectOptions()

  const stillThere = tab.presets.some((p) => p.id === previous)
  const target = stillThere ? previous : (tab.presets[0]?.id ?? null)
  tab.els.mixPresetSelect.value = target ?? ''
  tab.selectMixPreset(target, { silent: true })
}

// The "In preset" dropdown (Group mode). Called from refreshLibrary too,
// which every refresh path runs, so a preset made, renamed or deleted
// elsewhere shows here without a tab switch (owner, 2026-11-17: a new
// preset was missing from Remix's lists until a restart).
export function renderPresetSelectOptions(tab) {
  const select = tab.els.mixPresetSelect
  if (!select) return
  const keep = select.value
  select.innerHTML = tab.presets.length
    ? tab.presets.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join('')
    : '<option value="">No presets saved yet</option>'
  if (tab.presets.some((p) => p.id === keep)) select.value = keep
}

// `presetChanged` gates whether the currently-open group survives - a
// plain data refresh (refreshMixPanel() runs on every tab onShow, same as
// the old standalone Preset Remix plugin's own refresh() did) re-selects
// the *same* preset id, and used to unconditionally reset selectedGroupId
// to null regardless - a real bug caught live via CDP while verifying
// this merge (switching to another tab and back silently kicked you out
// of whichever group you had open, and - worse - left stale membership
// checkboxes in the DOM still wired to toggle a now-null selectedGroupId,
// which strips a sound out of every group instead of the intended one).
export function selectMixPreset(tab, id, { silent = false } = {}) {
  const presetChanged = id !== tab.selectedPresetId
  if (presetChanged) tab.resetLevelHistory('preset')
  if (presetChanged && tab.selectedGroupId) tab.dispatchGroupPreview(tab.groupSaved)

  tab.selectedPresetId = id || null
  const preset = tab.presets.find((p) => p.id === id)
  tab.wholeMixSaved = cloneWholeMix(preset?.wholeMix ?? null)
  tab.wholeMixCurrent = cloneWholeMix(tab.wholeMixSaved)
  tab.writePresetMixControls(tab.wholeMixCurrent)
  tab.presetEq.load(tab.wholeMixCurrent.eq)
  tab.presetEqTarget.resetCompare()
  tab.presetEqTarget.updateFields()
  tab.updatePresetMixLabels()
  tab.els.mixPresetControls.classList.toggle('editor-mix-disabled', !preset)
  if (!silent && tab.mode === 'preset') tab.dispatchWholeMixPreview(tab.wholeMixCurrent)

  tab.groups = preset?.groups ?? []
  tab.renderGroupSelectOptions()
  tab.renderCopyGroupTargetOptions()
  if (presetChanged) {
    tab.selectedGroupId = null
    tab.els.mixGroupSelect.value = ''
    tab.els.mixGroupEditor.classList.add('hidden')
    tab.els.mixGroupEmpty.classList.remove('hidden')
  } else if (tab.selectedGroupId) {
    // Same preset, just a refresh - keep editing whichever group was
    // open, re-synced against the freshly fetched data (its membership or
    // filters may have changed elsewhere, e.g. the Mixer's own right-click
    // menu, while this tab was hidden).
    const group = tab.groups.find((g) => g.id === tab.selectedGroupId)
    if (group) {
      tab.els.mixGroupSelect.value = tab.selectedGroupId
      tab.renderGroupMembers()
    } else {
      tab.selectedGroupId = null
      tab.els.mixGroupEditor.classList.add('hidden')
      tab.els.mixGroupEmpty.classList.remove('hidden')
    }
  }
  tab.updateModeUI()
}

export function writePresetMixControls(tab, mix) {
  tab.els.mixPresetHighpass.value = String(mix.highpassHz)
  tab.els.mixPresetLowpass.value = String(mix.lowpassHz)
  tab.els.mixPresetGain.value = String(mix.gainDb)
  tab.els.mixPresetEchoDelay.value = String(mix.echoDelayMs)
  tab.els.mixPresetEchoDecay.value = String(mix.echoDecay)
  tab.els.mixPresetReverbSize.value = String(mix.reverbSizeMs ?? 0)
  tab.els.mixPresetReverbMix.value = String(mix.reverbMix ?? 0)
  tab.els.mixPresetFadeIn.value = String(mix.fadeInSeconds)
  tab.writeMixFluctuation(mix.fluctuation, tab.presetFlucEls)
}

export function readPresetMixControlsAndPreview(tab) {
  tab.wholeMixCurrent = {
    ...tab.wholeMixCurrent,
    highpassHz: Number(tab.els.mixPresetHighpass.value),
    lowpassHz: Number(tab.els.mixPresetLowpass.value),
    gainDb: Number(tab.els.mixPresetGain.value),
    echoDelayMs: Number(tab.els.mixPresetEchoDelay.value),
    echoDecay: Number(tab.els.mixPresetEchoDecay.value),
    reverbSizeMs: Number(tab.els.mixPresetReverbSize.value),
    reverbMix: Number(tab.els.mixPresetReverbMix.value),
    fadeInSeconds: Math.max(0, Number(tab.els.mixPresetFadeIn.value) || 0),
    fluctuation: tab.readMixFluctuation(tab.presetFlucEls)
  }
  tab.updatePresetMixLabels()
  tab.updateMixFlucEnabledUI(tab.presetFlucEls)
  tab.updateModeUI()
  if (tab.mode === 'preset') tab.dispatchWholeMixPreview(tab.wholeMixCurrent)
}

// --- Fluctuation shared helpers (Preset + Group mode) ---
// `els` is a bundle: { enabledEl, bar, changeMinEl, changeMaxEl, transEl,
// fullRandomEl } for the volume axis (this.presetFlucEls /
// this.groupFlucEls), plus an optional `pan` sub-bundle of the same shape
// (Group mode only, v0.1.217).
export function readMixFluctuation(tab, els) {
  return {
    volume: tab.readMixFlucAxis(els),
    ...(els.pitch ? { pitch: tab.readMixFlucAxis(els.pitch) } : {}),
    ...(els.pan ? { pan: tab.readMixFlucAxis(els.pan) } : {})
  }
}

export function readMixFlucAxis(tab, axisEls) {
  const v = axisEls.bar.getValues()
  return {
    enabled: axisEls.enabledEl.checked,
    fullyRandom: axisEls.fullRandomEl.checked,
    biasEnabled: axisEls.biasEl.checked,
    ...(axisEls.perSoundEl ? { perSound: axisEls.perSoundLocked || axisEls.perSoundEl.checked } : {}),
    min: v.min,
    max: v.max,
    bias: v.bias,
    changeMinSeconds: flucSeconds(axisEls.changeMinEl.value, 6),
    changeMaxSeconds: flucSeconds(axisEls.changeMaxEl.value, 14),
    transitionSeconds: flucSeconds(axisEls.transEl.value, 8, true)
  }
}

export function writeMixFluctuation(tab, fluctuation, els) {
  // No saved axis (a neutral preset, or Reset filters) → show the default
  // spread, not all three handles collapsed at 1.
  const d = defaultMixFluctuation()
  const volSrc = fluctuation?.volume ?? d.volume
  tab.writeMixFlucAxis({ ...d.volume, ...normalizeFluctuationAxis(volSrc, 1), perSound: Boolean(volSrc.perSound) }, els)
  if (els.pitch) tab.writeMixFlucAxis({ ...d.pitch, ...normalizeFluctuationAxis(fluctuation?.pitch ?? d.pitch, 0) }, els.pitch)
  if (els.pan) {
    const src = fluctuation?.pan ?? d.pan
    tab.writeMixFlucAxis({ ...d.pan, ...normalizeFluctuationAxis(src, 0), perSound: Boolean(src.perSound) }, els.pan)
  }
  tab.updateMixFlucEnabledUI(els)
}

export function writeMixFlucAxis(tab, axis, axisEls) {
  axisEls.enabledEl.checked = axis.enabled
  axisEls.fullRandomEl.checked = axis.fullyRandom
  axisEls.changeMinEl.value = String(axis.changeMinSeconds)
  axisEls.changeMaxEl.value = String(axis.changeMaxSeconds)
  axisEls.transEl.value = String(axis.transitionSeconds)
  axisEls.biasEl.checked = axis.biasEnabled !== false
  if (axisEls.perSoundEl && !axisEls.perSoundLocked) axisEls.perSoundEl.checked = Boolean(axis.perSound)
  axisEls.bar.setValues(axis)
}

export function updateMixFlucEnabledUI(tab, els) {
  for (const axisEls of [els, els.pitch, els.pan].filter(Boolean)) {
    const on = axisEls.enabledEl.checked
    const random = axisEls.fullRandomEl.checked
    axisEls.bar.setEnabled(on && !random)
    axisEls.bar.setBiasEnabled(axisEls.biasEl.checked)
    axisEls.changeMinEl.disabled = !on
    axisEls.changeMaxEl.disabled = !on
    axisEls.transEl.disabled = !on
    axisEls.fullRandomEl.disabled = !on
    axisEls.biasEl.disabled = !on || random
    if (axisEls.perSoundEl && !axisEls.perSoundLocked) axisEls.perSoundEl.disabled = !on
  }
}

export function setPresetEffectPreset(tab, preset) {
  tab.els.mixPresetHighpass.value = String(preset.highpassHz)
  tab.els.mixPresetLowpass.value = String(preset.lowpassHz)
  tab.els.mixPresetGain.value = String(preset.gainDb)
  tab.els.mixPresetEchoDelay.value = String(preset.echoDelayMs ?? 0)
  tab.els.mixPresetEchoDecay.value = String(preset.echoDecay ?? 0)
  tab.els.mixPresetReverbSize.value = String(preset.reverbSizeMs ?? 0)
  tab.els.mixPresetReverbMix.value = String(preset.reverbMix ?? 0)
}

export function updatePresetMixLabels(tab) {
  const hp = Number(tab.els.mixPresetHighpass.value)
  const lp = Number(tab.els.mixPresetLowpass.value)
  const gain = Number(tab.els.mixPresetGain.value)
  const echoDelay = Number(tab.els.mixPresetEchoDelay.value)
  const echoDecay = Number(tab.els.mixPresetEchoDecay.value)
  const reverbSize = Number(tab.els.mixPresetReverbSize.value)
  const reverbMix = Number(tab.els.mixPresetReverbMix.value)
  tab.els.mixPresetHighpassValue.textContent = hp > 0 ? `${hp} Hz` : 'Off'
  tab.els.mixPresetLowpassValue.textContent = lp < 20000 ? `${lp} Hz` : 'Off'
  tab.els.mixPresetGainValue.textContent = `${gain > 0 ? '+' : ''}${gain} dB`
  tab.els.mixPresetEchoDelayValue.textContent = echoDelay > 0 ? `${echoDelay} ms` : 'Off'
  tab.els.mixPresetEchoDecayValue.textContent = echoDecay > 0 ? echoDecay.toFixed(2) : 'Off'
  tab.els.mixPresetReverbSizeValue.textContent = reverbSize > 0 ? `${(reverbSize / 1000).toFixed(1)}s` : 'Off'
  tab.els.mixPresetReverbMixValue.textContent = reverbMix > 0 ? `${Math.round(reverbMix * 100)}%` : 'Off'
}

export async function saveWholeMix(tab) {
  if (!tab.selectedPresetId || tab._wholeMixSaveInProgress) return
  tab._wholeMixSaveInProgress = true
  tab.els.mixSave.disabled = true
  try {
    const updated = await tab.api.presets.updateWholeMix(tab.selectedPresetId, tab.wholeMixCurrent)
    tab.wholeMixSaved = cloneWholeMix(updated?.wholeMix ?? null)
    tab.wholeMixCurrent = cloneWholeMix(tab.wholeMixSaved)
    tab.writePresetMixControls(tab.wholeMixCurrent)
    tab.presetEq.load(tab.wholeMixCurrent.eq)
    tab.presetEqTarget.updateFields()
    tab.presetEqTarget.updateBanner()
    tab.updatePresetMixLabels()
    const local = tab.presets.find((p) => p.id === tab.selectedPresetId)
    if (local) local.wholeMix = updated?.wholeMix ?? null
    tab.dispatchWholeMixPreview(tab.wholeMixSaved)
    tab.els.mixStatus.textContent = 'Saved. Load tab preset in the Mixer to hear it.'
  } catch (err) {
    console.error('Editor: preset save failed', err)
    tab.els.mixStatus.textContent = `Save failed: ${err.message}`
  } finally {
    tab._wholeMixSaveInProgress = false
    tab.updateModeUI()
  }
}

export function dispatchWholeMixPreview(tab, wholeMix) {
  if (!tab.selectedPresetId) return
  window.dispatchEvent(
    new CustomEvent('noctivago:whole-mix-preview', {
      detail: { presetId: tab.selectedPresetId, wholeMix: cloneWholeMix(wholeMix) }
    })
  )
}

// --- Group mode (see AudioEngine.js's SoundGroupChain) ---
// A group is scoped to whichever preset is selected in the shared picker
// row above: a named subset of that preset's own sounds, routed through
// one shared highpass/lowpass/EQ/gain chain instead of straight to
// masterGain. Membership writes through immediately (like adding a sound
// to a preset); a group's own name/filters/EQ are a draft with the same
// sticky-bar Save the whole-mix panel uses, kept fully separate so editing
// a group never affects the preset's own whole-mix save state or vice
// versa.

export function renderGroupSelectOptions(tab) {
  tab.els.mixGroupSelect.innerHTML = tab.groups.length
    ? tab.groups.map((g) => `<option value="${escapeHtml(g.id)}">${escapeHtml(g.name)} (${g.soundIds.length})</option>`).join('')
    : '<option value="">No groups yet</option>'
  tab.layout?.refreshStudio?.()
}

// "Copy to preset…" (owner inbox, 2026-09-13: a "crowd speaking" ambience
// group reused across a shopping-center preset and a town-square preset) -
// every OTHER preset (the currently open one has nothing to copy into
// itself), refreshed alongside the group <select> in selectMixPreset() so
// switching presets keeps this list correct without a separate refresh
// path. A plain <select> that fires the copy on pick, rather than a
// separate button + target picker - matches this app's existing
// pick-triggers-action convention (e.g. the sort/group-by dropdowns)
// and needs no extra chrome in an already-packed sticky bar.
export function renderCopyGroupTargetOptions(tab) {
  const placeholder = '<option value="" selected disabled>Copy to preset…</option>'
  const others = tab.presets.filter((p) => p.id !== tab.selectedPresetId)
  tab.els.mixCopyGroupTo.innerHTML =
    placeholder + others.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join('')
}

// Duplicates the selected group's name/filters/EQ/members into a brand-new
// group (a fresh id, assigned by presets.js's normalizeGroup) on a
// *different* preset - once there, it's governed entirely by that other
// preset (its own Save/Delete/EQ edits), matching how a group already
// works: presets.js has no cross-preset group concept, this is purely "add
// one more group, built from a copy of this data" on the target's own
// groups[]. soundIds carry over unfiltered - group membership was already
// independent of a preset's own sounds[] list before this feature existed
// (renderGroupMembers's own union of the two proves it), so a copied
// member sound not yet in the target preset's mix just sits inert there,
// exactly like any other group member does today.
export async function copyGroupToPreset(tab, targetPresetId) {
  tab.els.mixCopyGroupTo.value = ''
  if (!targetPresetId || !tab.selectedGroupId || !tab.selectedPresetId) return
  const sourceGroup = tab.groups.find((g) => g.id === tab.selectedGroupId)
  if (!sourceGroup) return
  // Reads presets fresh right before the write rather than trusting
  // this.presets (which could be stale if the target preset's own groups
  // changed elsewhere, e.g. the Mixer's right-click menu, while this tab
  // sat open) - a whole-array replace write is exactly the case that
  // matters for, per this file's own established "read fresh before a
  // whole-array replace" precedent (see toggleGroupMember's comment).
  const freshPresets = await tab.api.presets.list()
  const targetPreset = freshPresets.find((p) => p.id === targetPresetId)
  if (!targetPreset) return
  const newGroup = { name: sourceGroup.name, soundIds: [...sourceGroup.soundIds], filters: cloneGroupFilters(sourceGroup.filters) }
  const updatedGroups = [...(targetPreset.groups ?? []), newGroup]
  const saved = await tab.api.presets.updateGroups(targetPresetId, updatedGroups)
  tab.presets = freshPresets.map((p) => (p.id === targetPresetId ? (saved ?? { ...p, groups: updatedGroups }) : p))
  if (targetPresetId === tab.selectedPresetId) {
    tab.groups = saved?.groups ?? updatedGroups
    tab.renderGroupSelectOptions()
  }
  window.dispatchEvent(new CustomEvent('noctivago:sound-groups-changed', { detail: { presetId: targetPresetId } }))
  tab.els.mixStatus.textContent = `Copied "${sourceGroup.name}" to "${targetPreset.name}".`
}

export function selectGroup(tab, id) {
  if (tab.selectedGroupId) tab.dispatchGroupPreview(tab.groupSaved)
  if (id !== tab.selectedGroupId) tab.resetLevelHistory('group')

  const group = tab.groups.find((g) => g.id === id)
  tab.selectedGroupId = group ? id : null
  tab.els.mixGroupSelect.value = tab.selectedGroupId ?? ''
  if (!group) {
    tab.els.mixGroupEditor.classList.add('hidden')
    tab.els.mixGroupEmpty.classList.remove('hidden')
    tab.updateModeUI()
    return
  }

  tab.els.mixGroupEditor.classList.remove('hidden')
  tab.els.mixGroupEmpty.classList.add('hidden')
  tab.els.mixGroupName.value = group.name
  tab.groupSaved = cloneGroupFilters(group.filters)
  tab.groupCurrent = cloneGroupFilters(tab.groupSaved)
  tab.writeGroupControls(tab.groupCurrent)
  tab.groupEq.load(tab.groupCurrent.eq)
  tab.groupEqTarget.resetCompare()
  tab.groupEqTarget.updateFields()
  tab.updateGroupLabels()
  tab.renderGroupMembers()
  if (tab.mode === 'group') tab.dispatchGroupPreview(tab.groupCurrent)
  tab.updateModeUI()
}

// The preset's own sound list, cross-referenced with the library for
// display names - membership only ever makes sense for sounds actually in
// this preset's mix. BUG FIX (reported directly, "they just don't show up
// on the interface completely"): the Mixer's own right-click "add to
// group"/"new group with this sound" menu never required the sound to
// already be saved into the preset's own `sounds` array - it operates on
// whatever's in the live mix (state.activePresetId), which routes/EQs the
// sound correctly (group.soundIds already has it) even if the owner never
// hit "Save changes to <preset>" to persist that sound into preset.sounds
// itself. This checklist used to only ever iterate preset.sounds, so a
// member added that way was invisible here even though the group's own
// count (soundIds.length, read elsewhere) already reflected it correctly.
// Now iterates the union of both lists so a real member is always shown,
// regardless of which side of that (pre-existing, deliberate) save/live
// split it came from.
export function renderGroupMembers(tab) {
  tab.els.mixGroupMembers.innerHTML = ''
  const preset = tab.presets.find((p) => p.id === tab.selectedPresetId)
  const group = tab.groups.find((g) => g.id === tab.selectedGroupId)
  if (!preset || !group) return
  const soundIds = [...new Set([...preset.sounds.map((s) => s.soundId), ...group.soundIds])]
  for (const soundId of soundIds) {
    const sound = tab.library.find((s) => s.id === soundId)
    const label = document.createElement('label')
    label.className = 'editor-mix-group-member'
    const checkbox = document.createElement('input')
    checkbox.type = 'checkbox'
    checkbox.checked = group.soundIds.includes(soundId)
    checkbox.addEventListener('change', () => tab.toggleGroupMember(soundId))
    const name = document.createElement('span')
    name.textContent = sound?.name ?? soundId
    label.appendChild(checkbox)
    label.appendChild(name)
    tab.els.mixGroupMembers.appendChild(label)
  }
}

// A sound belongs to at most one group per preset (see
// AudioEngine.destinationForSound) - checking it into this group leaves
// whatever other group it was already in. Queued onto
// this._groupMemberQueue (shared with saveGroup/deleteGroup/createGroup
// below, self-review v0.1.149 - all four mutate the same this.groups via
// the same read-then-write shape, so any pair of them firing close
// together has the identical race) rather than fired directly: two
// checkboxes clicked in quick succession (a real risk toggling several
// sounds into a group one after another) would otherwise both read
// this.groups before either write resolved, so the second call's
// update.presets.updateGroups would silently clobber the first - caught
// live via CDP while verifying this exact method (two rapid toggles left
// a group's membership back at empty even though both clicks visually
// registered). presetId/groupId are captured at click time, not read
// fresh when the queued call finally executes - otherwise switching the
// preset/group selector while this toggle is still queued would redirect
// it at whatever's selected *then*, not what was actually clicked.
export function toggleGroupMember(tab, soundId) {
  const presetId = tab.selectedPresetId
  const groupId = tab.selectedGroupId
  return tab.queueGroupMutation(() => tab._toggleGroupMemberNow(presetId, groupId, soundId))
}

// Shared serialization point for every write to a preset's groups array -
// see toggleGroupMember's own comment for why this can't just be
// toggleGroupMember's own private queue.
export function queueGroupMutation(tab, fn) {
  tab._groupMemberQueue = (tab._groupMemberQueue ?? Promise.resolve()).then(fn)
  return tab._groupMemberQueue
}

export async function _toggleGroupMemberNow(tab, presetId, groupId, soundId) {
  let wasAlreadyMember = false
  const updated = tab.groups.map((g) => {
    if (g.id === groupId) {
      wasAlreadyMember = g.soundIds.includes(soundId)
      return { ...g, soundIds: wasAlreadyMember ? g.soundIds.filter((s) => s !== soundId) : [...g.soundIds, soundId] }
    }
    return { ...g, soundIds: g.soundIds.filter((s) => s !== soundId) }
  })
  const saved = await tab.api.presets.updateGroups(presetId, updated)
  // Only touch this tab's own UI/state if the user hasn't since switched
  // to a different preset entirely - the write itself (and the broadcast
  // below, for the Mixer/other views) still always happens.
  if (presetId === tab.selectedPresetId) {
    tab.groups = saved?.groups ?? updated
    const local = tab.presets.find((p) => p.id === presetId)
    if (local) local.groups = tab.groups
    tab.renderGroupSelectOptions()
    tab.els.mixGroupSelect.value = tab.selectedGroupId ?? ''
    tab.renderGroupMembers()
  }
  // joinedSoundId: see the Mixer's identical sound-groups-changed
  // listener comment - only set on an actual add, so a removal never
  // gets misread as one.
  window.dispatchEvent(new CustomEvent('noctivago:sound-groups-changed', { detail: { presetId, joinedSoundId: wasAlreadyMember ? null : soundId } }))
}

export function writeGroupControls(tab, filters) {
  tab.els.mixGroupHighpass.value = String(filters.highpassHz)
  tab.els.mixGroupLowpass.value = String(filters.lowpassHz)
  tab.els.mixGroupGain.value = String(filters.gainDb)
  tab.els.mixGroupPan.value = String(Math.round((filters.pan ?? 0) * 100))
  tab.els.mixGroupEchoDelay.value = String(filters.echoDelayMs)
  tab.els.mixGroupEchoDecay.value = String(filters.echoDecay)
  tab.els.mixGroupReverbSize.value = String(filters.reverbSizeMs ?? 0)
  tab.els.mixGroupReverbMix.value = String(filters.reverbMix ?? 0)
  tab.els.mixGroupOcclusion.value = String(filters.occlusion ?? 0)
  tab.writeMixFluctuation(filters.fluctuation, tab.groupFlucEls)
}

export function readGroupControlsAndPreview(tab) {
  tab.groupCurrent = {
    ...tab.groupCurrent,
    highpassHz: Number(tab.els.mixGroupHighpass.value),
    lowpassHz: Number(tab.els.mixGroupLowpass.value),
    gainDb: Number(tab.els.mixGroupGain.value),
    pan: Number(tab.els.mixGroupPan.value) / 100,
    echoDelayMs: Number(tab.els.mixGroupEchoDelay.value),
    echoDecay: Number(tab.els.mixGroupEchoDecay.value),
    reverbSizeMs: Number(tab.els.mixGroupReverbSize.value),
    reverbMix: Number(tab.els.mixGroupReverbMix.value),
    occlusion: Number(tab.els.mixGroupOcclusion.value),
    fluctuation: tab.readMixFluctuation(tab.groupFlucEls)
  }
  tab.updateGroupLabels()
  tab.updateMixFlucEnabledUI(tab.groupFlucEls)
  tab.updateModeUI()
  if (tab.mode === 'group') tab.dispatchGroupPreview(tab.groupCurrent)
}

export function setGroupEffectPreset(tab, preset) {
  tab.els.mixGroupHighpass.value = String(preset.highpassHz)
  tab.els.mixGroupLowpass.value = String(preset.lowpassHz)
  tab.els.mixGroupGain.value = String(preset.gainDb)
  tab.els.mixGroupEchoDelay.value = String(preset.echoDelayMs ?? 0)
  tab.els.mixGroupEchoDecay.value = String(preset.echoDecay ?? 0)
  tab.els.mixGroupReverbSize.value = String(preset.reverbSizeMs ?? 0)
  tab.els.mixGroupReverbMix.value = String(preset.reverbMix ?? 0)
}

export function updateGroupLabels(tab) {
  const hp = Number(tab.els.mixGroupHighpass.value)
  const lp = Number(tab.els.mixGroupLowpass.value)
  const gain = Number(tab.els.mixGroupGain.value)
  const echoDelay = Number(tab.els.mixGroupEchoDelay.value)
  const echoDecay = Number(tab.els.mixGroupEchoDecay.value)
  const reverbSize = Number(tab.els.mixGroupReverbSize.value)
  const reverbMix = Number(tab.els.mixGroupReverbMix.value)
  const occlusion = Number(tab.els.mixGroupOcclusion.value)
  tab.els.mixGroupHighpassValue.textContent = hp > 0 ? `${hp} Hz` : 'Off'
  tab.els.mixGroupLowpassValue.textContent = lp < 20000 ? `${lp} Hz` : 'Off'
  tab.els.mixGroupGainValue.textContent = `${gain > 0 ? '+' : ''}${gain} dB`
  tab.els.mixGroupPanValue.textContent = formatPan(Number(tab.els.mixGroupPan.value) / 100)
  tab.els.mixGroupEchoDelayValue.textContent = echoDelay > 0 ? `${echoDelay} ms` : 'Off'
  tab.els.mixGroupEchoDecayValue.textContent = echoDecay > 0 ? echoDecay.toFixed(2) : 'Off'
  tab.els.mixGroupReverbSizeValue.textContent = reverbSize > 0 ? `${(reverbSize / 1000).toFixed(1)}s` : 'Off'
  tab.els.mixGroupReverbMixValue.textContent = reverbMix > 0 ? `${Math.round(reverbMix * 100)}%` : 'Off'
  tab.els.mixGroupOcclusionValue.textContent = occlusion > 0 ? `${Math.round(occlusion * 100)}%` : 'Off'
}

export function updateGroupDirty(tab) {
  tab.updateModeUI()
}

// saveGroup/deleteGroup/createGroup below all route their actual
// read-this.groups-then-updateGroups work through queueGroupMutation too
// (self-review v0.1.149) - each has the identical race toggleGroupMember
// was fixed for (e.g. checking a membership box, then immediately hitting
// Save on the group's filters before that toggle's own write lands would
// otherwise have the second call's stale this.groups clobber the first).
export function saveGroup(tab) {
  if (!tab.selectedGroupId || tab._groupSaveInProgress) return Promise.resolve()
  return tab.queueGroupMutation(() => tab.saveGroupNow())
}

export async function saveGroupNow(tab) {
  tab._groupSaveInProgress = true
  tab.els.mixSave.disabled = true
  try {
    const name = tab.els.mixGroupName.value.trim() || 'Group'
    const updated = tab.groups.map((g) => (g.id === tab.selectedGroupId ? { ...g, name, filters: tab.groupCurrent } : g))
    const saved = await tab.api.presets.updateGroups(tab.selectedPresetId, updated)
    tab.groups = saved?.groups ?? updated
    const local = tab.presets.find((p) => p.id === tab.selectedPresetId)
    if (local) local.groups = tab.groups
    const group = tab.groups.find((g) => g.id === tab.selectedGroupId)
    tab.groupSaved = cloneGroupFilters(group?.filters ?? null)
    tab.groupCurrent = cloneGroupFilters(tab.groupSaved)
    tab.els.mixGroupName.value = group?.name ?? name
    tab.writeGroupControls(tab.groupCurrent)
    tab.groupEq.load(tab.groupCurrent.eq)
    tab.groupEqTarget.updateFields()
    tab.groupEqTarget.updateBanner()
    tab.updateGroupLabels()
    tab.renderGroupSelectOptions()
    tab.els.mixGroupSelect.value = tab.selectedGroupId
    tab.dispatchGroupPreview(tab.groupSaved)
    window.dispatchEvent(new CustomEvent('noctivago:sound-groups-changed', { detail: { presetId: tab.selectedPresetId } }))
    tab.els.mixStatus.textContent = 'Saved.'
  } catch (err) {
    console.error('Editor: group save failed', err)
    tab.els.mixStatus.textContent = `Save failed: ${err.message}`
  } finally {
    tab._groupSaveInProgress = false
    tab.updateModeUI()
  }
}

export function deleteGroup(tab) {
  if (!tab.selectedGroupId || !tab.selectedPresetId) return Promise.resolve()
  return tab.queueGroupMutation(() => tab.deleteGroupNow())
}

export async function deleteGroupNow(tab) {
  const id = tab.selectedGroupId
  if (!id || !tab.selectedPresetId) return
  const updated = tab.groups.filter((g) => g.id !== id)
  const saved = await tab.api.presets.updateGroups(tab.selectedPresetId, updated)
  tab.groups = saved?.groups ?? updated
  const local = tab.presets.find((p) => p.id === tab.selectedPresetId)
  if (local) local.groups = tab.groups
  tab.selectedGroupId = null
  tab.els.mixGroupEditor.classList.add('hidden')
  tab.els.mixGroupEmpty.classList.remove('hidden')
  tab.renderGroupSelectOptions()
  tab.els.mixGroupSelect.value = ''
  window.dispatchEvent(new CustomEvent('noctivago:sound-groups-changed', { detail: { presetId: tab.selectedPresetId } }))
  tab.updateModeUI()
}

export function createGroup(tab) {
  if (!tab.selectedPresetId) return Promise.resolve()
  return tab.queueGroupMutation(() => tab.createGroupNow())
}

export async function createGroupNow(tab) {
  const updated = [...tab.groups, { name: `Group ${tab.groups.length + 1}`, soundIds: [], filters: cloneGroupFilters(null) }]
  const saved = await tab.api.presets.updateGroups(tab.selectedPresetId, updated)
  tab.groups = saved?.groups ?? updated
  const local = tab.presets.find((p) => p.id === tab.selectedPresetId)
  if (local) local.groups = tab.groups
  tab.renderGroupSelectOptions()
  window.dispatchEvent(new CustomEvent('noctivago:sound-groups-changed', { detail: { presetId: tab.selectedPresetId } }))
  const created = tab.groups[tab.groups.length - 1]
  if (created) tab.selectGroup(created.id)
}

export function dispatchGroupPreview(tab, filters) {
  if (!tab.selectedPresetId || !tab.selectedGroupId) return
  window.dispatchEvent(
    new CustomEvent('noctivago:sound-group-preview', {
      detail: { presetId: tab.selectedPresetId, groupId: tab.selectedGroupId, filters: cloneGroupFilters(filters) }
    })
  )
}
