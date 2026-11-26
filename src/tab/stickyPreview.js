// Sticky bar and preview mode methods of the Remix tab. Each takes the tab.
import { formatDuration } from '../domain/time.js'
import { previewModeToggleState, mustFallBackToLive } from '../domain/previewMode.js'
import { PLAY_ICON_SVG, PAUSE_ICON_SVG, VOLUME_ICON_SVG, MUTE_ICON_SVG } from '../components/icons.js'

// Wires the sticky bar's own controls: Play/Pause, loop toggle, preview
// mode toggle, progress bar, volume/mute/solo, Undo/Redo/Cancel and the
// Save buttons. The controls are rendered by RemixApp (mount()); the Mixer
// bar half is wired by the tab's mountMixBar().
export function wireStickyBar(tab) {
  const els = tab.els
  const root = tab.root
  // The controls are rendered in the studio panes by RemixApp (mount()).
  els.playPause = root.querySelector('#editor-play-pause')
  els.loopToggle = root.querySelector('#editor-loop-toggle')
  els.previewModeToggle = root.querySelector('#editor-preview-mode-toggle')
  els.previewModeToggle.addEventListener('click', () => tab.togglePreviewMode())
  els.stickyProgress = root.querySelector('#editor-sticky-progress')
  els.stickyProgressFill = root.querySelector('#editor-sticky-progress-fill')
  els.stickyProgressThumb = root.querySelector('#editor-sticky-progress-thumb')
  els.stickyTime = root.querySelector('#editor-sticky-time')
  tab.wireStickyProgressDrag()
  els.stickyVolume = root.querySelector('#editor-sticky-volume')
  els.stickyMute = root.querySelector('#editor-sticky-mute')
  els.stickySolo = root.querySelector('#editor-sticky-solo')
  els.undo = root.querySelector('#editor-undo')
  els.redo = root.querySelector('#editor-redo')
  els.cancel = root.querySelector('#editor-cancel')
  els.undo.addEventListener('click', () => tab.undo())
  els.redo.addEventListener('click', () => tab.redo())
  els.cancel.addEventListener('click', () => tab.cancelEdits())
  els.save = root.querySelector('#editor-save')
  els.saveLabel = root.querySelector('#editor-save-label')
  // Save works in place on apps with the morph states (2.0+, micro-interactions mock, row "Remix
  // save", the preset pill's states): Saving, then Changes saved with a drawn check, or the reason
  // in soft red; Cancel shows Changes canceled. Older apps keep the plain label.
  tab.saveMorph = tab.app.ui?.morphButton?.(els.save) ?? null
  tab._saveLabelText = 'Save'
  els.save.addEventListener('click', () => tab.save().catch((err) => console.error('Editor: save failed', err)))
  els.saveAsCopy = root.querySelector('#editor-save-as-copy')
  els.saveAsCopy.addEventListener('click', () => tab.saveAsCopy().catch((err) => console.error('Editor: save as copy failed', err)))
  els.saveSegment = root.querySelector('#editor-save-segment')
  els.saveSegment.addEventListener('click', () => tab.saveSegmentAsNew().catch((err) => console.error('Editor: save segment failed', err)))

  els.playPause.addEventListener('click', async () => {
    const active = tab.activePreview()
    if (!active) return
    tab.stopSeamListen({ pause: false })
    if (active.playing) {
      active.pause()
      tab.stopPreviewTicking()
      tab.setPlayPauseIcon(false)
      tab.eqEditorController.clearSpectrum()
    } else {
      try {
        await tab.engine.resume()
        await active.play()
        tab.setPlayPauseIcon(true)
        tab.tickPreviewPlayhead()
      } catch (err) {
        console.error('Failed to preview sound', err)
      }
    }
  })

  els.loopToggle.addEventListener('click', () => {
    tab.looping = !tab.looping
    tab.updateLoopToggleVisual()
    tab.previewSource?.setLooping(tab.looping)
  })

  // Persists across sounds within the tab session, same as looping above -
  // a preview-workflow preference, not per-sound saved state (unrelated to
  // the per-sound volume slider in the Mixer, which *is* saved).
  els.stickyVolume.addEventListener('input', () => {
    tab.previewVolume = Number(els.stickyVolume.value) / 100
    // Dragging the slider while muted implicitly unmutes - same
    // convention the Mixer's volume sliders use.
    if (tab.previewMuted) {
      tab.previewMuted = false
      tab.updatePreviewMuteIcon()
    }
    tab.activePreview()?.setVolume(tab.effectivePreviewVolume())
  })

  els.stickyMute.addEventListener('click', () => {
    tab.previewMuted = !tab.previewMuted
    tab.updatePreviewMuteIcon()
    tab.activePreview()?.setVolume(tab.effectivePreviewVolume())
  })

  els.stickySolo.addEventListener('click', () => tab.toggleSolo())
  tab.updatePreviewMuteIcon()

  els.stickySoundControls = root.querySelector('#editor-sticky-sound-controls')
  // The sound picker lives in the bar's left slot (layout.js moves it there),
  // so the sound can be switched from anywhere. mount() built and wired it.
  els.soundPicker = els.soundSearch?.closest('.editor-picker')
  els.soundPicker?.classList.toggle('hidden', tab.mode !== 'sound')
}

export function effectivePreviewVolume(tab) {
  return tab.previewMuted ? 0 : tab.previewVolume
}

// Whichever engine Play/Pause, volume/mute, and the sticky progress bar
// are actually driving right now - see tab.previewMode's own doc
// comment. Every sticky-bar control reads through this rather than
// hardcoding previewSource, so switching modes doesn't need special-casing
// at each call site.
export function activePreview(tab) {
  return tab.previewMode === 'saved' && tab.bakedPreview ? tab.bakedPreview : tab.previewSource
}

// Whether there's a real baked clip to switch into Saved mode for at all.
// v0.1.142: no longer requires the bake to still be *fresh* - staleness
// (edits made since that bake) doesn't disqualify it, since the toggle is
// now sticky (see previewMode's own doc comment) rather than auto-
// reverting the instant an edit makes the bake stale. This only gates
// whether Saved mode is reachable at all - a sound that's never been
// saved has nothing to compare against.
export function savedPreviewEligible(tab) {
  return Boolean(tab.currentEntry?.loopClipReady) && Boolean(tab.bakedPreview)
}

// v0.1.214: the toggle is never disabled - owner's direct requirement
// ("it always has to change between live preview and saved audio
// preview"). Switching to Saved with no usable bake (never saved, or the
// last render failed) renders one first instead of refusing.
export async function togglePreviewMode(tab) {
  if (tab._togglingPreviewMode) return
  if (tab.previewMode !== 'saved' && !tab.savedPreviewEligible()) {
    if (tab._clipRebaking || tab.saveCtl.isSaving() || tab.eqCompareViewing === 'B') return
    tab._togglingPreviewMode = true
    const entry = tab.currentEntry
    try {
      tab.els.saveStatus.textContent = 'Rendering saved audio…'
      await tab.save({ forceBake: true })
    } finally {
      tab._togglingPreviewMode = false
    }
    if (tab.currentEntry !== entry) return
    if (!tab.savedPreviewEligible()) {
      tab.els.saveStatus.textContent = "Couldn't render the saved audio - still on Live edit. Click the toggle to try again."
      return
    }
  }
  // Switching stops playback rather than trying to hand off mid-stream
  // between two structurally different engines (one crossfading pair of
  // <audio> elements through a live filter chain vs. one plain looping
  // <audio> element) - simpler and more predictable than attempting a
  // seamless handoff for what's fundamentally an A/B comparison tool, not
  // a continuous listening experience.
  tab.stopSeamListen({ pause: false })
  const wasPlaying = tab.activePreview()?.playing
  tab.activePreview()?.pause()
  tab.stopPreviewTicking()
  tab.setPlayPauseIcon(false)
  tab.eqEditorController.clearSpectrum()
  tab.previewMode = tab.previewMode === 'saved' ? 'live' : 'saved'
  tab.updatePreviewModeToggle()
  tab.updateStickyProgress(0)
  if (wasPlaying) {
    tab.engine
      .resume()
      .then(() => tab.activePreview()?.play())
      .then(() => {
        tab.setPlayPauseIcon(true)
        tab.tickPreviewPlayhead()
      })
      .catch((err) => console.error('Failed to switch preview mode', err))
  }
}

// Called after every edit (same updateSaveButtonState() hook every field
// change already funnels through) and on load/dispose - keeps the toggle
// enabled/labeled correctly. v0.1.142: no longer auto-reverts out of
// 'saved' just because an edit made the bake stale (see previewMode's own
// doc comment + the Board's own inbox note this answers) - the one
// remaining force-switch is when the bake becomes genuinely unavailable
// (savedPreviewEligible() false: never saved, or a save's render failed),
// since there's nothing left to actually play in Saved mode at that point.
export function updatePreviewModeToggle(tab) {
  if (!tab.els.previewModeToggle) return
  const eligible = tab.savedPreviewEligible()
  if (mustFallBackToLive({ mode: tab.previewMode, eligible, rebaking: tab._clipRebaking })) {
    // Pause whichever engine (bakedPreview) is actually live *before*
    // flipping the mode - activePreview() reads tab.previewMode, so
    // pausing after the flip would silently target the wrong (idle)
    // engine and leave the real one playing in the background.
    tab.activePreview()?.pause()
    tab.stopPreviewTicking()
    tab.setPlayPauseIcon(false)
    tab.previewMode = 'live'
  }
  tab.els.previewModeToggle.disabled = false
  const toggle = previewModeToggleState({ mode: tab.previewMode, eligible, stale: tab.hasUnsavedChanges() })
  tab.els.previewModeToggle.textContent = toggle.text
  tab.els.previewModeToggle.classList.toggle('editor-preview-mode-toggle-active', toggle.active)
  tab.els.previewModeToggle.classList.toggle('editor-preview-mode-toggle-stale', toggle.stale)
  tab.els.previewModeToggle.title = toggle.title
  // Keep the "drift needs Live edit preview" note in sync with the mode.
  if (tab.flucVolBar) tab.updateFluctuationEnabledUI()
}

export function updatePreviewMuteIcon(tab) {
  tab.els.stickyMute.innerHTML = tab.previewMuted ? MUTE_ICON_SVG : VOLUME_ICON_SVG
  tab.els.stickyMute.title = tab.previewMuted ? 'Unmute' : 'Mute'
  tab.els.stickyMute.classList.toggle('btn-svg-icon-active', tab.previewMuted)
}

export function updateLoopToggleVisual(tab) {
  tab.els.loopToggle.classList.toggle('editor-loop-icon-btn-active', tab.looping)
  tab.els.loopToggle.setAttribute('aria-pressed', String(tab.looping))
}

// Core's Mixer has no direct access to this plugin's state (or vice
// versa) - plugins only get the curated window.noctivago IPC surface, and
// mute is deliberately session-only/unpersisted, so there's no library
// data to round-trip through either. A plain window CustomEvent is the
// simplest bridge that doesn't require either side to import the other;
// see tabs/mixer/index.js's own 'noctivago:remix-solo' listener.
export function toggleSolo(tab) {
  if (!tab.currentEntry) return
  tab.setSolo(!tab.soloActive)
}

export function setSolo(tab, active) {
  if (tab.soloActive === active) return
  tab.soloActive = active
  tab.els.stickySolo?.classList.toggle('editor-sticky-solo-active', active)
  if (tab.currentEntry) {
    window.dispatchEvent(new CustomEvent('noctivago:solo', { detail: { soundId: tab.currentEntry.id, active } }))
  }
}

export function setPlayPauseIcon(tab, playing) {
  // The main transport and a row preview never play at once.
  if (playing) tab.itemPreview?.stop()
  if (!tab.els.playPause) return
  tab.els.playPause.innerHTML = playing ? PAUSE_ICON_SVG : PLAY_ICON_SVG
  tab.els.playPause.title = playing ? 'Pause' : 'Play'
}

export function stopPreviewTicking(tab) {
  if (tab.previewRafId) {
    cancelAnimationFrame(tab.previewRafId)
    tab.previewRafId = null
  }
}

export function tickPreviewPlayhead(tab) {
  const active = tab.activePreview()
  if (!active || !tab.loopEditorController) return
  if (tab.previewMode === 'saved') {
    // The baked clip has its own 0-based timeline (it *is* the trimmed
    // region), unlike previewSource which plays the original file - offset
    // back into the original file's absolute time for the waveform's
    // playhead, but keep the sticky progress bar in the clip's own
    // 0..duration terms (see updateStickyProgress's mode branch).
    const source = tab.clipTimeToSource(active.currentTime)
    tab.loopEditorController.setPlayhead(source)
    tab.spectralView?.setPlayhead(source)
    tab.updateSeamPlayhead(source)
    tab.updateStickyProgress(active.currentTime)
  } else {
    const currentTime = active.currentTime
    tab.loopEditorController.setPlayhead(currentTime)
    tab.spectralView?.setPlayhead(currentTime)
    tab.updateSeamPlayhead(currentTime)
    tab.updateStickyProgress(currentTime)
    // Volume envelope: only the *live* preview needs this (previewMode
    // 'live' means `active` here is always tab.previewSource) - the
    // 'saved' branch above plays the baked clip, which already has the
    // envelope rendered in.
    tab.previewSource?.tickEnvelope(currentTime)
  }
  // BakedClipPreview (the 'saved' engine) gained its own analyserNode
  // specifically so this can stay a single unconditional call rather than
  // one more mode branch - the spectrogram should track whichever engine
  // is actually audible either way.
  // Saved audio has no preAnalyserNode (the clip has the EQ baked in), so
  // the graph draws After only there.
  tab.eqEditorController.tickSpectrum(active.analyserNode, active.preAnalyserNode)
  tab.previewRafId = requestAnimationFrame(() => tab.tickPreviewPlayhead())
}

// Drag-to-seek on the sticky progress bar - inbox answer to the v0.1.115
// volume-slider follow-up ("make it so you can control the needle via the
// progress bar on the sticky topbar... put a little circle on it so you
// can drag"). Works whether the preview is playing or paused -
// PreviewSource.scrubTo() already handles both (just repositions
// currentTime, doesn't change play state). A click anywhere on the bar
// seeks too, not just a precise grab on the thumb - matches how a normal
// scrubbable progress bar works elsewhere (e.g. a video player).
export function wireStickyProgressDrag(tab) {
  let dragging = false

  const seekFromClientX = (clientX) => {
    const active = tab.activePreview()
    if (!active) return
    const rect = tab.els.stickyProgress.getBoundingClientRect()
    const fraction = Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1)
    if (tab.previewMode === 'saved') {
      const span = active.duration || 0
      const t = fraction * span
      active.scrubTo(t)
      tab.updateStickyProgress(t)
      if (tab.loopEditorController) {
        tab.loopEditorController.setPlayhead(tab.clipTimeToSource(t))
      }
    } else {
      if (!tab.loopEditorController) return
      const { loopStart, loopEnd } = tab.loopEditorController.getLoopPoints()
      const t = loopStart + fraction * Math.max(0, loopEnd - loopStart)
      active.scrubTo(t)
      tab.loopEditorController.setPlayhead(t)
      tab.updateStickyProgress(t)
    }
  }

  tab.els.stickyProgress.addEventListener('mousedown', (evt) => {
    if (!tab.activePreview()) return
    dragging = true
    seekFromClientX(evt.clientX)
  })
  window.addEventListener('mousemove', (evt) => {
    if (!dragging) return
    seekFromClientX(evt.clientX)
  })
  window.addEventListener('mouseup', () => {
    dragging = false
  })
}

// Progress is relative to the trimmed loop region (loopStart..loopEnd),
// not the whole original file - that's what's actually being previewed/
// looped, matching what the waveform's own highlighted region already
// represents visually. Guarded on stickyProgressFill existing since this
// can theoretically be called before mountSticky() has run.
export function updateStickyProgress(tab, currentTime) {
  if (!tab.els.stickyProgressFill) return
  let elapsed, span
  if (tab.previewMode === 'saved' && tab.bakedPreview) {
    // currentTime is already clip-relative here (0..clip duration) - see
    // tickPreviewPlayhead's mode branch and wireStickyProgressDrag's own
    // seek math, both of which pass clip-relative time in this mode.
    span = Math.max(0, tab.bakedPreview.duration || 0)
    elapsed = Math.min(Math.max(currentTime, 0), span)
  } else {
    if (!tab.loopEditorController) return
    const { loopStart, loopEnd } = tab.loopEditorController.getLoopPoints()
    span = Math.max(0, loopEnd - loopStart)
    elapsed = Math.min(Math.max(currentTime - loopStart, 0), span)
  }
  const pct = span > 0 ? (elapsed / span) * 100 : 0
  tab.els.stickyProgressFill.style.width = `${pct}%`
  tab.els.stickyProgressThumb.style.left = `${pct}%`
  tab.els.stickyTime.textContent = `${formatDuration(elapsed)} / ${formatDuration(span)}`
  tab.updateNeedleField(tab.previewMode === 'saved' && tab.bakedPreview ? tab.clipTimeToSource(currentTime) : currentTime)
}
