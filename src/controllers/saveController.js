import { MAX_BUFFER_CLIP_SECONDS, DEFAULT_CROSSFADE_MS, NEUTRAL_FILTERS, defaultFluctuation, defaultScatter, defaultSchedule, defaultSpeedPitch } from '../domain/mixSettings.js'

// Rebuild step 10 (SaveController): owns Save, autosave's save, Save as copy and
// Save segment as new. The tab hands in callbacks (d); this module never reaches
// into the DOM or the tab. saveMorph / setSaveLabel stay on the tab and arrive as
// saveWorking / saveDone / saveFail / beginBake.

// Random-interval and Scheduled playback (and a Doppler pitch) replay the clip as
// one-shots, so the bake uses 0 crossfade (plain trim) for them, whatever the
// slider says. Mirrors library.js / tabs/mixer effectiveCrossfadeSeconds: keep in sync.
export function effectiveCrossfade(playMode, speedPitch, crossfadeSeconds) {
  return playMode === 'scatter' || playMode === 'scheduled' || speedPitch.dopplerEnabled ? 0 : crossfadeSeconds
}

// "<name> copy", then "<name> copy 2", "<name> copy 3"... against the names already
// in the library, so two rows never look identical right after saving.
export function nextCopyName(existingNames, baseName) {
  const existing = new Set(existingNames)
  let candidate = `${baseName} copy`
  let n = 2
  while (existing.has(candidate)) {
    candidate = `${baseName} copy ${n}`
    n += 1
  }
  return candidate
}

export function createSaveController(d) {
  let inProgress = false

    // trigger: 'manual' (the Save button) or 'auto' (runAutosave) - only
    // changes the status-line wording below, everything else about the save
    // is identical either way. _saveInProgress guards against a manual click
    // and a debounced autosave firing at the same moment starting two
    // overlapping bakes of the same sound.
    async function save(options = {}) {
      const { trigger = 'manual', forceBake = false } = options
      // Defense in depth - the Save button is already disabled while viewing
      // B (see updateSaveButtonState), but currentFilters() would silently
      // read B's read-only data instead of A's real live edits if this ever
      // ran anyway.
      if (!d.getEntry() || !d.hasLoopEditor() || d.isViewingB() || d.isCompareSaved()) return
      if (inProgress) return
      inProgress = true
      d.saveWorking(trigger === 'auto' ? 'Auto-saving' : 'Saving')
      try {
        await performSave(trigger, forceBake)
        d.saveDone(trigger === 'auto' ? 'Auto-saved' : 'Changes saved')
      } catch (err) {
        d.saveFail("Couldn't save. Try again")
        d.updateSaveButtonState()
        throw err
      } finally {
        inProgress = false
      }
    }

    async function performSave(trigger, forceBake = false) {
      const savedWord = trigger === 'auto' ? 'Auto-saved' : 'Saved'
      const id = d.getEntry().id
      // BUG FIX (self-review, v0.1.196): everything this async function reads
      // off `this` after an `await` - `d.getEntry()`, `d.getEditingPresetId()`,
      // `this.fluctuation` - can legitimately change mid-save, since nothing
      // stops the user from clicking a different sound in the Remix picker
      // (loadSound() reassigns these immediately, with no lock against an
      // in-flight save/autosave; `_saveInProgress` only guards two overlapping
      // save() calls, not a save racing a sound switch). Without capturing a
      // stable reference up front, a bake that resolves after the switch wrote
      // its results onto the *new* sound's currentEntry (corrupting it with
      // the old sound's bake data) and dispatched a Mixer event mislabeling
      // the old sound's id under the new sound's preset context. `entry` below
      // is the one true target for every mutation/read this save produces,
      // regardless of what `d.getEntry()` points to by the time it
      // resolves; `stillEditingThisEntry()` gates anything that should only
      // happen if the Remix UI is still actually showing this sound (status
      // text, the Save button, savedSnapshot, the baked-preview swap).
      const entry = d.getEntry()
      const savingEditingPresetId = d.getEditingPresetId()
      const savingFluctuation = d.getFluctuation()
      const stillEditingThisEntry = () => d.getEntry() === entry
      // Captured before savedSnapshot is rewritten below. The Save button can
      // now be lit by a fluctuation-only edit (see updateSaveButtonState) - in
      // that case nothing that feeds the ffmpeg render actually changed, so
      // skip the bake round-trip entirely rather than re-rendering a
      // byte-identical clip (fluctuation is never baked in).
      const bakeRelevantDirty = forceBake || d.hasUnsavedChanges()
      const flucDirty = d.fluctuationDirty()
      const { loopStart, loopEnd } = d.getLoopPoints()
      const filters = d.currentFilters()
      const crossfadeMs = d.currentCrossfadeMs()
      const crossfadeSeconds = crossfadeMs / 1000
      const speedPitch = d.currentSpeedPitch()
      const playMode = d.currentPlayMode()
      const scatter = d.currentScatterConfig()
      const schedule = d.currentScheduleConfig()
      // Random-interval and Scheduled playback both replay the clip as
      // one-shots, never back-to-back — the crossfade+rotation a looped clip
      // needs to hide its own wrap point would be wrong for either, so the
      // bake below always uses 0 (plain trim) for both regardless of the
      // crossfade slider's own saved value. Mirrors library.js/tabs/mixer's
      // own effectiveCrossfadeSeconds exactly — keep in sync if this ever
      // changes.
      const effectiveCrossfadeSeconds = effectiveCrossfade(playMode, speedPitch, crossfadeSeconds)

      // Per-preset sound overrides (planned 2026-09-12, "presets as primary
      // context"): if this sound is a member of the preset this editing
      // session is pinned to (editingPresetId, captured once in loadSound so
      // a live preset switch mid-edit can't silently redirect an in-flight
      // save), the edit only ever affects that preset's own copy. Otherwise
      // (the sound isn't in that preset's mix, or there's no preset context)
      // fall back to exactly today's global write - identical to every
      // sound's behavior before this feature existed.
      const overridePatch = { loopStart, loopEnd, filters, crossfadeSeconds, speedPitch, playMode, scatter, schedule }
      // BUG FIX (v0.1.223): membership is read from disk, not this.presets
      // (cached when the tab loaded). A sound added to or removed from the
      // preset in the Mixer since then used to send the edit to the wrong
      // place: to shared defaults, or to an override slot that no longer
      // existed, where updateSoundOverride silently did nothing.
      if (savingEditingPresetId) d.setPresets(await d.api.presets.list())
      const editingPreset = savingEditingPresetId ? d.getPresets().find((p) => p.id === savingEditingPresetId) : null
      let presetSoundItem = editingPreset?.sounds.find((s) => s.soundId === id) ?? null
      // Owner, 2026-11-21: a sound out of the mix with a parked copy
      // (removedOverrides) edits that copy only, never the shared defaults;
      // the app's updateSoundOverride writes the parked slot for it.
      const parkedSlot = !presetSoundItem && Object.hasOwn(editingPreset?.removedOverrides ?? {}, id)
      if (parkedSlot) presetSoundItem = { soundId: id, overrides: editingPreset.removedOverrides[id], parked: true }
      if (presetSoundItem) {
        const updated = await d.api.presets.updateSoundOverride(savingEditingPresetId, id, overridePatch)
        const updatedItem = parkedSlot
          ? (updated && Object.hasOwn(updated.removedOverrides ?? {}, id) ? { overrides: updated.removedOverrides[id] } : null)
          : updated?.sounds.find((s) => s.soundId === id)
        if (updatedItem) presetSoundItem.overrides = updatedItem.overrides
        else presetSoundItem = null
      }
      const overrideHint = !presetSoundItem && savingEditingPresetId
        ? " This sound isn't in the current preset, so this changed its shared defaults."
        : ''
      if (!presetSoundItem) {
        await d.api.library.updateLoopPoints(id, { loopStart, loopEnd })
        await d.api.library.updateFilters(id, filters)
        await d.api.library.updateCrossfade(id, crossfadeSeconds)
        await d.api.library.updateSpeedPitch(id, speedPitch)
        await d.api.library.updatePlayMode(id, playMode)
        await d.api.library.updateScatterConfig(id, scatter)
        await d.api.library.updateSchedule(id, schedule)
      }
      // BUG FIX (v0.1.193 dispatched this too early, v0.1.194 moves it here):
      // an already-mounted Mixer needs to hear about this edit so its live
      // source reconciles immediately, rather than staying stale until the
      // next incidental tab switch reruns refreshList(). v0.1.193 dispatched
      // this bridge event right after the metadata writes above - but the
      // ffmpeg bake (audio.renderLoopClip, below) hadn't run yet at that
      // point, so the Mixer's own bufferBakeSnapshot/loopClipEligible checks
      // (which compare the sound's *live* settings against its *baked clip's*
      // recorded settings) saw a fresh speedPitch/filters against a now-stale
      // loopClipSpeedPitch/loopClipFilters and correctly concluded the bake no
      // longer matched - permanently downgrading a Loop-mode sound from buffer
      // mode to the stream-mode fallback, which has no live pitch-shift
      // primitive at all (only Speed and filters apply live in stream mode -
      // see reconcileSource's 'loop-stream' branch in tabs/mixer/index.js).
      // Nothing ever re-notified the Mixer once the *real* bake with the new
      // pitch actually finished a moment later, so the sound was stuck
      // silently ignoring Pitch (and running a lower-quality loop seam) until
      // something else forced a full refreshList(). Reported directly:
      // "I change audio settings like pitch and speed and it has no results
      // on live playback on mixer tab" - reproduced live via CDP (a sound
      // playing in loop-buffer mode audibly should have stayed there after a
      // pitch-only Save; instead it flipped to loop-stream immediately and
      // never recovered). Fixed by moving the dispatch to notifyLiveReconcile()
      // below, called only once the bake has fully resolved (success, failure,
      // over-cap skip, or skipped entirely because nothing bake-relevant
      // changed) - so its `loopClip` payload always reflects the *current*
      // baked-clip bookkeeping, not a snapshot mid-flight.
      const notifyLiveReconcile = () => {
        const loopClip = {
          ready: entry.loopClipReady,
          start: entry.loopClipStart,
          end: entry.loopClipEnd,
          filters: entry.loopClipFilters,
          crossfadeSeconds: entry.loopClipCrossfadeSeconds,
          speedPitch: entry.loopClipSpeedPitch
        }
        if (presetSoundItem) {
          d.emit('noctivago:sound-override-changed', {
            presetId: savingEditingPresetId, soundId: id, overrides: presetSoundItem.overrides, loopClip, parked: Boolean(presetSoundItem.parked)
          })
        } else {
          d.emit('noctivago:sound-baseline-changed', { soundId: id, loopStart, loopEnd, filters, crossfadeSeconds, speedPitch, playMode, scatter, schedule, loopClip })
        }
      }
      entry.loopStart = loopStart
      entry.loopEnd = loopEnd
      entry.filters = filters
      entry.crossfadeSeconds = crossfadeSeconds
      entry.speedPitch = speedPitch
      entry.playMode = playMode
      entry.scatter = scatter
      entry.schedule = schedule
      if (stillEditingThisEntry()) {
        d.commitSavedSnapshot(loopStart, loopEnd, filters, crossfadeMs, speedPitch, playMode, scatter, schedule)
      }

      // Persist the drift settings in the same Save (their own IPC call, not
      // folded into the bake) and cancel any still-pending debounced write so
      // it doesn't fire a second, redundant one right after. Uses the
      // pre-await savingFluctuation capture, not a live fluctuation read,
      // for the same reason `entry` is captured above - the live value would
      // already belong to a different sound if the user switched mid-save.
      if (flucDirty) {
        d.cancelPendingFluctuation()
        await d.api.library.updateFluctuation(id, savingFluctuation)
        entry.fluctuation = savingFluctuation
        d.emit('noctivago:sound-fluctuation-changed', { soundId: id, fluctuation: savingFluctuation })
        if (stillEditingThisEntry()) d.commitFluctuationSnapshot()
      }

      // Only fluctuation (or nothing) changed - the existing bake, if any, is
      // still valid. Skip the ffmpeg re-render.
      if (!bakeRelevantDirty) {
        notifyLiveReconcile()
        if (stillEditingThisEntry()) {
          d.setStatus(`${savedWord} — original file untouched.${overrideHint}`)
          d.updateSaveButtonState()
        }
        return
      }

      // This never touches the original audio file: trim points and filters
      // are stored as metadata, applied live whenever the Mixer streams the
      // sound. Best-effort on top of that: bake trim+filters into a small
      // clip for native gapless looping. Only within the eligibility cap — a
      // longer trimmed region keeps the Mixer streaming (still filtered, just
      // with a small loop seam) instead of fully decoding it client-side,
      // which would risk the same memory/crash problem long files hit before
      // this app streamed instead of decoding. Speed/Pitch/Reverse follow the
      // same cap - Speed alone also applies live to a streamed (unbaked)
      // sound (see core's LocalFileSoundSource), but Pitch and Reverse need
      // the real ffmpeg render to take effect at all.
      if (loopEnd - loopStart <= MAX_BUFFER_CLIP_SECONDS) {
        d.beginBake(trigger)
        // BUG FIX (self-review, v0.1.196): an unhandled rejection here (a real
        // IPC/main-process failure, not just ffmpeg's own {ok:false} result)
        // used to skip notifyLiveReconcile() entirely and leave the Save
        // button stuck disabled on "Saving…" forever - the same class of
        // "Mixer never hears about this edit" bug v0.1.194 fixed, just via an
        // exception instead of a timing gap. Normalizing a thrown error into
        // the same {ok:false} shape the render itself already produces on
        // failure means the existing branch below (which already calls
        // notifyLiveReconcile() and resets the button either way) handles it
        // for free, no separate error path needed.
        // BUG FIX (v0.1.214): release the Saved-audio <audio> element's hold
        // on the clip file *before* re-baking it. The sound:// handler streams
        // the clip with backpressure, so a loaded element (playing or paused -
        // bakedPreview is even preloaded in Live mode) keeps the file open
        // indefinitely, and Windows refuses to rename the fresh render over
        // an open file. loopClip.js's renameWithRetry only waits ~3s, so the
        // render was reported as failed -> loopClipReady false -> the preview
        // toggle greyed out right after every save made from Saved mode.
        // Reported directly: "every time I'm on saved audio preview and save
        // it it greys out." _clipRebaking keeps updatePreviewModeToggle from
        // kicking the user out of Saved mode while the preview is torn down.
        const resume = stillEditingThisEntry() ? d.releaseBakedPreview() : null
        let result
        try {
          result = await d.api.audio.renderLoopClip(id, {
            loopStart,
            loopEnd,
            filters,
            crossfadeSeconds: effectiveCrossfadeSeconds,
            speedPitch
          })
        } catch (err) {
          console.error('Editor: renderLoopClip rejected', err)
          result = { ok: false }
        }
        if (result.ok) {
          entry.loopClipReady = true
          entry.loopClipStart = loopStart
          entry.loopClipEnd = loopEnd
          entry.loopClipFilters = filters
          entry.loopClipCrossfadeSeconds = effectiveCrossfadeSeconds
          entry.loopClipSpeedPitch = speedPitch
          if (stillEditingThisEntry()) {
            d.setStatus(
              (playMode === 'scatter'
                ? `${savedWord} — original file untouched. Rendered a clip for random-interval playback.`
                : playMode === 'scheduled'
                  ? `${savedWord} — original file untouched. Rendered a clip for scheduled playback.`
                  : `${savedWord} — original file untouched. Rendered a gapless clip for seamless looping.`) + overrideHint)
          }
        } else {
          entry.loopClipReady = false
          entry.loopClipStart = null
          entry.loopClipEnd = null
          entry.loopClipFilters = null
          entry.loopClipCrossfadeSeconds = null
          entry.loopClipSpeedPitch = null
          if (stillEditingThisEntry()) {
            d.setStatus(
              (playMode === 'scatter'
                ? `${savedWord} — original file untouched. Clip render failed, so this will stream directly for random-interval playback.`
                : playMode === 'scheduled'
                  ? `${savedWord} — original file untouched. Clip render failed, so this will stream directly for scheduled playback.`
                  : `${savedWord} — original file untouched. Gapless clip render failed, so this will loop with a small seam.`) + overrideHint)
          }
        }
        notifyLiveReconcile()
        // The bake just rewrote the file at this same sound://<id>?variant=clip
        // URL - recreate bakedPreview so its <audio> element actually re-fetches
        // instead of risking a browser-cached copy of the *previous* bake (the
        // response carries Accept-Ranges but no explicit no-cache header, and
        // this is otherwise the one place in this file the same clip URL is
        // ever asked to serve genuinely different bytes over its own lifetime).
        // v0.1.142: previewMode is now sticky rather than force-reverting to
        // 'live' on dirty (see previewMode's own doc comment), so - unlike the
        // old assumption here - autosave can now genuinely re-bake while
        // Saved mode is the one actually driving playback. Carry position/
        // play-state across the swap so a re-bake mid-audition doesn't
        // silently drop the audio out from under the listener. Gated on
        // stillEditingThisEntry() - this.bakedPreview/this.previewMode belong
        // to whatever sound is currently open in the Remix UI, which may no
        // longer be this one (see this function's own top-of-function note).
        d.restoreBakedPreview({ resume, ok: result.ok, id, presetId: savingEditingPresetId, stillEditing: stillEditingThisEntry() })
      } else {
        // A previous save may have left a valid bake (loopClipReady/bakedPreview)
        // from when the trim was still within the cap - since this save's own
        // trim no longer qualifies, that old bake no longer matches anything
        // `entry` now describes and must be invalidated the same way a failed
        // render already is above, or "Saved audio" would keep looking fully
        // valid (savedSnapshot was just updated to match, so no staleness
        // indicator would show) while actually playing the stale, unrelated clip.
        entry.loopClipReady = false
        entry.loopClipStart = null
        entry.loopClipEnd = null
        entry.loopClipFilters = null
        entry.loopClipCrossfadeSeconds = null
        entry.loopClipSpeedPitch = null
        if (stillEditingThisEntry()) {
          d.setStatus(
            (playMode === 'scatter'
              ? `${savedWord} — original file untouched. This trim is over 10 minutes, so random-interval playback will stream directly.`
              : playMode === 'scheduled'
                ? `${savedWord} — original file untouched. This trim is over 10 minutes, so scheduled playback will stream directly.`
                : `${savedWord} — original file untouched. This trim is over 10 minutes, so it will loop with a small seam instead of a gapless clip.`) + overrideHint)
        }
        notifyLiveReconcile()
        if (stillEditingThisEntry()) d.updateSaveButtonState()
      }
    }

    // "Save as copy" - trims a segment out of a longer recording (the owner's
    // own use case: several distinct bird calls in one field recording) into
    // its own independent sound, without touching the source's own saved
    // trim/filters at all. Deliberately does *not* run this.save() first or
    // touch d.getEntry()/this.savedSnapshot in any way - the workflow is
    // trim to segment 1, Save as copy, adjust the trim to segment 2 (still on
    // the *same* open sound), Save as copy again, and so on, so the sound
    // staying open in Remix must keep behaving exactly like nothing happened.
    // Mirrors save()'s own structure closely (same field reads, same bake
    // call, same MAX_BUFFER_CLIP_SECONDS cap) but targets the brand-new id
    // library.duplicateSound() hands back instead of d.getEntry().id.
    async function saveAsCopy() {
      if (!d.getEntry() || !d.hasLoopEditor() || d.isViewingB()) return
      const { loopStart, loopEnd } = d.getLoopPoints()
      const filters = d.currentFilters()
      const crossfadeMs = d.currentCrossfadeMs()
      const crossfadeSeconds = crossfadeMs / 1000
      const speedPitch = d.currentSpeedPitch()
      const playMode = d.currentPlayMode()
      const scatter = d.currentScatterConfig()
      const schedule = d.currentScheduleConfig()
      const effectiveCrossfadeSeconds = effectiveCrossfade(playMode, speedPitch, crossfadeSeconds)

      const name = d.nextCopyName(d.getEntry().name)
      d.setSaveAsCopyDisabled(true)
      d.setStatus(`Saving a copy as "${name}"…`)
      const newEntry = await d.api.library.duplicateSound(d.getEntry().id, { name })
      if (!newEntry) {
        d.setSaveAsCopyDisabled(false)
        d.setStatus('Save as copy failed — could not create the new sound.')
        return
      }

      await d.api.library.updateLoopPoints(newEntry.id, { loopStart, loopEnd })
      await d.api.library.updateFilters(newEntry.id, filters)
      await d.api.library.updateCrossfade(newEntry.id, crossfadeSeconds)
      await d.api.library.updateSpeedPitch(newEntry.id, speedPitch)
      await d.api.library.updatePlayMode(newEntry.id, playMode)
      await d.api.library.updateScatterConfig(newEntry.id, scatter)
      await d.api.library.updateSchedule(newEntry.id, schedule)

      let baked = false
      if (loopEnd - loopStart <= MAX_BUFFER_CLIP_SECONDS) {
        const result = await d.api.audio.renderLoopClip(newEntry.id, {
          loopStart,
          loopEnd,
          filters,
          crossfadeSeconds: effectiveCrossfadeSeconds,
          speedPitch
        })
        baked = result.ok
      }
      d.setSaveAsCopyDisabled(false)
      d.setStatus(baked
        ? `Saved a copy: "${name}".`
        : `Saved a copy: "${name}" (streams directly - trim over 10 minutes, or the clip render failed).`)
      await d.refreshLibrary()
    }

    // "Save segment as new" (Desktop 2.0, owner 2026-11-10): a brand-new sound
    // that is only the trimmed part. Unlike Save as copy it carries none of
    // this sound's settings: filters, EQ, speed, pitch, play mode, per-play
    // ranges and drift all start at their defaults. The open sound is untouched.
    async function saveSegmentAsNew() {
      if (!d.getEntry() || !d.hasLoopEditor() || d.isViewingB()) return
      const { loopStart, loopEnd } = d.getLoopPoints()
      const filters = structuredClone(NEUTRAL_FILTERS)
      const speedPitch = defaultSpeedPitch()
      const crossfadeSeconds = DEFAULT_CROSSFADE_MS / 1000
      const name = d.nextCopyName(d.getEntry().name)
      d.setSaveSegmentDisabled(true)
      d.setStatus(`Saving the segment as "${name}"…`)
      const newEntry = await d.api.library.duplicateSound(d.getEntry().id, { name })
      if (!newEntry) {
        d.setSaveSegmentDisabled(false)
        d.setStatus('Save segment failed — could not create the new sound.')
        return
      }

      await d.api.library.updateLoopPoints(newEntry.id, { loopStart, loopEnd })
      await d.api.library.updateFilters(newEntry.id, filters)
      await d.api.library.updateCrossfade(newEntry.id, crossfadeSeconds)
      await d.api.library.updateSpeedPitch(newEntry.id, speedPitch)
      await d.api.library.updatePlayMode(newEntry.id, 'loop')
      await d.api.library.updateScatterConfig(newEntry.id, defaultScatter())
      await d.api.library.updateSchedule(newEntry.id, defaultSchedule())
      await d.api.library.updateFluctuation(newEntry.id, defaultFluctuation())

      let baked = false
      if (loopEnd - loopStart <= MAX_BUFFER_CLIP_SECONDS) {
        const result = await d.api.audio.renderLoopClip(newEntry.id, { loopStart, loopEnd, filters, crossfadeSeconds, speedPitch })
        baked = result.ok
      }
      d.setSaveSegmentDisabled(false)
      d.setStatus(baked
        ? `Saved the segment as a new sound: "${name}".`
        : `Saved the segment as a new sound: "${name}" (streams directly - trim over 10 minutes, or the clip render failed).`)
      await d.refreshLibrary()
    }

  return {
    save,
    saveAsCopy,
    saveSegmentAsNew,
    isSaving: () => inProgress
  }
}
