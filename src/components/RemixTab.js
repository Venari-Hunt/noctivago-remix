import { AudioEngine } from '../audio/AudioEngine.js'
import { PreviewSource } from '../audio/PreviewSource.js'
import { BakedClipPreview } from '../audio/BakedClipPreview.js'
import { formatHz, GOOD_NOISE_SEC, noiseBandFromShape, normalizeRegions } from '../domain/spectralLayout.js'
import { toolHint } from '../domain/repairBrush.js'
import { loopLayout, clipToSource, sourceToClip } from '../domain/loopLayout.js'
import { mountLoopEditor, mountWaveformScrollbar } from '../mounts/loopEditorMount.js'
import { mountSpectral } from '../mounts/spectralMount.js'
import { mountSeam } from '../mounts/seamMount.js'
import { mountEqEditor, mountMixEqTargets } from '../mounts/eqMount.js'
import { mountMixFluctuation } from '../mounts/mixFlucMount.js'
import { Q_MIN, Q_MAX, SLOPE_CAPABLE_EQ_TYPES } from './EqEditor.js'
import { normalizeFluctuationAxis } from '../audio/Modulator.js'
import { formatDuration, parseDuration } from '../domain/time.js'
import { mountRemixApp } from './RemixApp.jsx'
import { mountPlaybackPanel } from './PlaybackPanel.jsx'
import { mountSoundPicker } from './SoundPicker.jsx'
import { mountLoopRow } from './LoopRow.jsx'
import { mountSpeedPitchPanel } from './SpeedPitchPanel.jsx'
import { mountDrift } from './DriftPanel.jsx'
import { mountEqView } from './EqView.jsx'
import { mountPresetPanel, mountGroupPanel } from './MixPanels.jsx'
import { mountTrimView } from './TrimView.jsx'
import { mountSeamView } from './SeamView.jsx'
import { mountSpectrumView } from './SpectrumView.jsx'
import { mountFilterControls, filterSummaries } from './FilterControls.jsx'
import { markerKeyAction } from '../domain/markerKeys.js'
import { filterPickerSounds, stepHighlight, enterPick } from '../domain/pickerList.js'
import { previewModeToggleState, mustFallBackToLive } from '../domain/previewMode.js'
import { loadedFluctuation, fluctuationFingerprint, isFluctuationDirty, groupDriftFor, groupOverrideNotes } from '../domain/driftState.js'
import { saveButtonState } from '../domain/saveState.js'
import { createAutosave } from '../domain/autosave.js'
import { createCompare } from '../domain/compareView.js'
import { createHistory } from '../domain/editorHistory.js'
import { createPreviewController } from '../controllers/previewController.js'
import { createSaveController, nextCopyName } from '../controllers/saveController.js'
import { createSoundLoader } from '../controllers/soundLoader.js'
import { wirePickerControls } from '../controls/pickerControls.js'
import { wireTrimControls } from '../controls/trimControls.js'
import { wirePlayModeControls } from '../controls/playModeControls.js'
import { wireShapeControls } from '../controls/shapeControls.js'
import { wireFilterControls } from '../controls/filterControls.js'
import { wireEqControls } from '../controls/eqControls.js'
import { wireFluctuationControls } from '../controls/fluctuationControls.js'
import { MAX_BUFFER_CLIP_SECONDS, applySoundOverride, DEFAULT_CROSSFADE_MS, SEAM_LEAD_SECONDS, SEAM_TAIL_SECONDS, HISTORY_COMMIT_DEBOUNCE_MS, HISTORY_LIMIT, AUTOSAVE_IDLE_MS, defaultEqBands, defaultVolumeEnvelope, NEUTRAL_FILTERS, FLUC_VOL_MIN, FLUC_VOL_MAX, formatPan, defaultFluctuation, defaultSpeedPitch, FILTER_PRESETS, NEUTRAL_WHOLE_MIX, NEUTRAL_GROUP_FILTERS, defaultMixFluctuation, flucSeconds, SHOT_AXES, shotBiasDefault, SHOT_AXIS_NAMES, cloneWholeMix, wholeMixEqual, cloneGroupFilters, groupFiltersEqual } from '../domain/mixSettings.js'
import { addMarker, removeMarker, renameMarker, updateMarker } from '../domain/markers.js'
import { loadMarkers, saveMarkers } from '../domain/markerStore.js'
import { mountMarkerUi, flashMarkerButton, renderMarkerChips, renderProgressTicks, openMarkerPopover, closeMarkerPopover, formatMarkerTime } from './markerUi.js'
import { icon, PLAY_ICON_SVG, PAUSE_ICON_SVG, VOLUME_ICON_SVG, MUTE_ICON_SVG } from './icons.js'
import { arrangeLayout, arrangeBar, driftSummary } from './layout.js'
import { wireNameMarquee } from './nameMarquee.js'
import { requestAnalyser, requestMixerStatus } from './mixerBridge.js'
import { pushLevel, peakFromTimeDomain } from '../domain/levels.js'
import { drawLevelHistory } from './levelHistory.js'
import { escapeHtml } from '../domain/html.js'
import { groupDetail, presetDetail, soundDetail, panOverride, withSoundVolume } from '../domain/detailPanel.js'
import { ItemPreviewPlayer } from '../audio/ItemPreview.js'
import { soundPlan, groupPlan, previewKind, effectiveSound } from '../domain/itemPreview.js'
import { findAllEls } from '../panels/index.js'

export default class EditorPlugin {
  constructor(app) {
    this.app = app
    this.api = app.noctivago
    this.engine = new AudioEngine()
    // Row previews in Group and Preset mode (one item at a time) and the
    // sounds whose Loop is on there. Preview only, never saved.
    this.itemPreview = new ItemPreviewPlayer(this.engine, { onChange: () => this.layout?.refreshStudio?.(), onShot: (id) => this.flashShot(id) })
    this.itemLoops = new Set()

    this.library = []
    this.currentEntry = null
    // Per-preset sound overrides (planned 2026-09-12, "presets as primary
    // context"): activePresetId mirrors whatever's actually loaded in the
    // Mixer right now (kept current by refreshLibrary()'s poll and the
    // noctivago:active-preset-changed push event); editingPresetId is
    // pinned once per editing session in loadSound() - the preset Save
    // actually targets, so a switch mid-edit can't silently redirect an
    // in-flight save to the wrong preset.
    this.activePresetId = null
    this.editingPresetId = null
    this.pickerQuery = ''
    this.pickerHighlightIndex = -1
    // Baseline for the Fluctuation dirty-check (see fluctuationDirty()) - the
    // last value that's actually persisted to the library. Set on every load
    // and after every fluctuation write (manual Save or the debounced
    // autosave), so the Save button and its status line can tell the user
    // their drift settings did get saved. Fluctuation deliberately stays out
    // of snapshotOf()/undo/A-B-compare (a playback-time behavior, never
    // baked) - this is its own small parallel dirty flag instead.
    this.savedFluctuationSnapshot = null
    // The "hear the real baked file" half of the preview toggle - see
    // BakedClipPreview.js's own doc comment for why this exists (live Reverse
    // is skipped for sounds over 10 minutes). 'live' (the editable Web Audio chain, previewSource)
    // or 'saved' (the actual baked clip file, bakedPreview) - always reset
    // to 'live' on a fresh load() since a new sound's own bake (if any) is
    // unrelated to whatever was being auditioned before. Otherwise sticky
    // (v0.1.142) - no longer force-reverted to 'live' just because an edit
    // made the bake stale, see savedPreviewEligible()/updatePreviewModeToggle().
    this.previewMode = 'live'
    this.previewRafId = null
    this.loopEditorController = null
    // Timing markers of the open sound (original-file seconds), see markers.js.
    this.markers = []
    this.markerUi = null
    this.waveformPeaksCache = new Map()
    this.detailPeaksDebounceTimer = null
    // Persists across sounds within one tab session (like the filter
    // sliders' values don't) since it's a preview-workflow preference, not
    // per-sound saved state - nothing about it is written to the library.
    this.looping = true
    this.previewVolume = 0.7
    // Layered on top of previewVolume, not destructive to it - unmuting
    // always restores exactly whatever the slider was already showing,
    // same convention as the Mixer's own volume mute buttons.
    this.previewMuted = false
    // Solo: mutes every other already-playing Mixer sound while this one is
    // open in Remix, so it's audible against silence instead of the full
    // mix. Scoped to "the sound currently being edited," same as the EQ
    // graph's own per-band Solo (EqEditor.js) - reset on every fresh load()
    // and on leaving the tab (onHide below), never persisted, so it can
    // never silently linger and leave other sounds muted after the fact.
    this.soloActive = false
    // A/B Compare - reworked per direct feedback from "two independent
    // editable snapshots" into "A = current session (live, editable),
    // B = last saved mix (immutable, display-only)". B is captured once in
    // loadSound() and never mutated for the rest of the session, even
    // across an in-session Save (deliberately - "last saved... before the
    // current session"). eqLiveBandsStash holds A's live bands while B is
    // being viewed, so switching back restores exactly where editing left
    // off. Per editing session only, not persisted with the sound.
    this.eqCompareViewing = 'A'
    this.savedEqSnapshot = []
    this.eqLiveBandsStash = null
    this.els = {}

    // Undo/Redo: a plain array of full-state snapshots (the exact same
    // normalized shape snapshotOf() already produces for the dirty-check,
    // just parsed back into an object) plus an index into it - Ctrl+Z/
    // Ctrl+Shift+Z move the index and reapply that entry's state to every
    // control. Pushed on a debounced "settled" checkpoint (see
    // scheduleHistoryCommit), not every drag frame - see its own comment for
    // why. Reset fresh on every loadSound(), never persisted - undo history
    // is a per-editing-session aid, same scope as A/B Compare.
    this.compare = createCompare()
    this.history = createHistory({ limit: HISTORY_LIMIT })
    this._historyCommitTimer = null
    // Set while applyEditorState() is pushing a past/future snapshot back
    // onto the live controls, so that itself doesn't get recorded as a new
    // history entry (which would corrupt the stack - undoing would then
    // just push right back onto what it undid).
    this._restoringHistory = false
    // Autosave (v0.1.142) - debounced idle timer + a re-entrancy guard so a
    // manual Save click and a timer firing at the same moment never start
    // two overlapping bakes of the same sound. See scheduleAutosave()'s own
    // comment for the debounce-vs-fixed-interval choice.
    this.autosave = createAutosave({
      idleMs: AUTOSAVE_IDLE_MS,
      canSchedule: () => !this._restoringHistory && !!this.currentEntry,
      canRun: () => !!this.currentEntry && this.eqCompareViewing !== 'B' && !this.compare.isSaved && this.hasUnsavedChanges(),
      isBusy: () => this.saveCtl.isSaving(),
      save: () => this.save({ trigger: 'auto' }),
      onError: (err) => console.error('Editor: autosave failed', err)
    })
    this.previewCtl = createPreviewController({
      engine: this.engine,
      PreviewSource,
      BakedClipPreview,
      setLiveMode: () => { this.previewMode = 'live' },
      getPreviewMode: () => this.previewMode,
      getVolume: () => this.effectivePreviewVolume(),
      stopTicking: () => this.stopPreviewTicking(),
      setPlayPauseIcon: (playing) => this.setPlayPauseIcon(playing),
      setClipRebaking: (v) => { this._clipRebaking = v },
      tickPlayhead: () => this.tickPreviewPlayhead(),
      updateSaveButtonState: () => this.updateSaveButtonState()
    })
    this.soundLoader = createSoundLoader({
      api: this.api,
      beforeLoad: () => {
        this.leaveCompareView()
        clearTimeout(this.detailPeaksDebounceTimer)
        clearTimeout(this._seamDetailPeaksTimer)
        this.seamView?.resetZoom()
      },
      findEntry: (id) => this.library.find((s) => s.id === id),
      currentId: () => this.currentEntry?.id,
      clearSolo: () => this.setSolo(false),
      setCurrentEntry: (entry) => { this.currentEntry = entry },
      // `entry` (from this.library) is already the effective view (baseline merged
      // with this preset's own override) as of refreshLibrary()'s last call.
      pinEditingPreset: () => {
        this.editingPresetId = this.activePresetId
        return this.editingPresetId
      },
      disposePreview: () => this.disposePreview(),
      showEditor: (entry) => {
        this.els.empty.classList.add('hidden')
        this.els.panel.classList.remove('hidden')
        this.setBarEnabled(true)
        this.els.soundName.textContent = entry.name
        this.els.soundName.title = entry.name
        this.layout?.refreshStudio?.()
        this.setPlayPauseIcon(false)
        this.els.saveStatus.textContent = ''
      },
      setFilterSliders: (filters) => this.setFilterSliders(filters),
      setSavedEqSnapshot: (eq) => { this.savedEqSnapshot = eq },
      resetEqCompare: () => this.resetEqCompare(),
      setCrossfade: (ms) => {
        this.els.crossfade.value = String(ms)
        this.updateCrossfadeLabel(ms)
      },
      setSpeedPitchControls: (sp) => this.setSpeedPitchControls(sp),
      updateSpeedPitchLabels: (sp) => this.updateSpeedPitchLabels(sp),
      loopEditor: () => this.loopEditorController,
      setPlayModeControls: (mode) => this.setPlayModeControls(mode),
      setScatterControls: (c) => this.setScatterControls(c),
      setScheduleControls: (c) => this.setScheduleControls(c),
      setFluctuationControls: (c) => this.setFluctuationControls(c),
      startPreview: ({ entry, presetId, crossfadeMs, speedPitch, fluctuation }) => this.previewCtl.start({
        soundId: entry.id,
        presetId,
        volume: this.effectivePreviewVolume(),
        sourceOptions: {
          loopStart: entry.loopStart,
          loopEnd: entry.loopEnd,
          looping: this.looping,
          crossfadeSeconds: crossfadeMs / 1000,
          speedPitch,
          fluctuation,
          onNoiseProfile: (curve) => this.filterControls?.setNoiseProfile(curve)
        },
        // Only fires when Loop preview is off and playback runs off the end on
        // its own - the button/playhead-tracking RAF otherwise only stop via
        // the explicit Play/Pause click handler.
        onEnded: () => {
          this.stopPreviewTicking()
          this.setPlayPauseIcon(false)
          this.eqEditorController.clearSpectrum()
        },
        onReverseStateChange: (state) => this.showReverseState(state)
      }),
      showReverseState: () => this.showReverseState(this.previewSource.reverseState),
      previewSource: () => this.previewSource,
      previewFilters: () => this.previewFilters(),
      getFluctuation: () => this.fluctuation,
      closeMarkerPopover,
      loadMarkers,
      setMarkers: (markers) => this.setMarkers(markers, { save: false }),
      setSpectralRegions: (regions) => this.spectralView.setRegions(regions),
      updateSpectralControls: () => this.updateSpectralControls(),
      syncNoiseBand: () => this.syncNoiseBand(),
      resetSpectrogramKey: () => { this._spectrogramKey = null },
      syncSpectralView: () => this.syncSpectralView(),
      updateFadeVisual: () => this.updateFadeVisual(),
      updateLoopTimeInputs: (start, end) => this.updateLoopTimeInputs(start, end),
      updateStickyProgress: (t) => this.updateStickyProgress(t),
      resetSuggestLoop: () => {
        this.els.suggestStatus.textContent = ''
        this.els.suggestLoopBtn.disabled = false
      },
      setBandEnergy: (freqs, energies) => this.eqEditorController.setBandEnergy(freqs, energies),
      snapshotOf: (...args) => this.snapshotOf(...args),
      // Undo history is per-editing-session, same scope as A/B Compare - a fresh
      // load starts a fresh stack seeded with the just-loaded state.
      resetHistory: (snapshot) => {
        this.savedSnapshot = snapshot
        clearTimeout(this._historyCommitTimer)
        this.history.reset(JSON.parse(snapshot))
      },
      updateUndoRedoButtonsUI: () => this.updateUndoRedoButtonsUI(),
      updateSaveButtonState: () => this.updateSaveButtonState(),
      hasPeaksCached: (id) => this.waveformPeaksCache.has(id),
      setWaveformStatus: (text) => { this.els.waveformStatus.textContent = text },
      getWaveformPeaks: (id) => this.getWaveformPeaks(id),
      syncSeamView: () => this.syncSeamView()
    })
    this.saveCtl = createSaveController({
      api: this.api,
      emit: (name, detail) => window.dispatchEvent(new CustomEvent(name, { detail })),
      getEntry: () => this.currentEntry,
      getEditingPresetId: () => this.editingPresetId,
      getFluctuation: () => this.fluctuation,
      getPresets: () => this.presets,
      setPresets: (presets) => { this.presets = presets },
      hasLoopEditor: () => !!this.loopEditorController,
      getLoopPoints: () => this.loopEditorController.getLoopPoints(),
      isViewingB: () => this.eqCompareViewing === 'B',
      isCompareSaved: () => this.compare.isSaved,
      hasUnsavedChanges: () => this.hasUnsavedChanges(),
      fluctuationDirty: () => this.fluctuationDirty(),
      currentFilters: () => this.currentFilters(),
      currentCrossfadeMs: () => this.currentCrossfadeMs(),
      currentSpeedPitch: () => this.currentSpeedPitch(),
      currentPlayMode: () => this.currentPlayMode(),
      currentScatterConfig: () => this.currentScatterConfig(),
      currentScheduleConfig: () => this.currentScheduleConfig(),
      nextCopyName: (baseName) => this.nextCopyName(baseName),
      refreshLibrary: () => this.refreshLibrary(),
      updateSaveButtonState: () => this.updateSaveButtonState(),
      setStatus: (text) => { this.els.saveStatus.textContent = text },
      setSaveAsCopyDisabled: (disabled) => { this.els.saveAsCopy.disabled = disabled },
      setSaveSegmentDisabled: (disabled) => { this.els.saveSegment.disabled = disabled },
      saveWorking: (word) => this.saveMorph?.working(word),
      saveDone: (word) => this.saveMorph?.done(word),
      saveFail: (word) => this.saveMorph?.fail(word),
      beginBake: (trigger) => {
        this.els.save.disabled = true
        if (!this.saveMorph) this.setSaveLabel(trigger === 'auto' ? 'Auto-saving…' : 'Saving…')
      },
      commitSavedSnapshot: (...settings) => { this.savedSnapshot = this.snapshotOf(...settings) },
      cancelPendingFluctuation: () => {
        clearTimeout(this._fluctuationSaveTimer)
        this._pendingFluctuation = null
      },
      fluctuationSnapshot: () => this.fluctuationSnapshot(),
      commitFluctuationSnapshot: () => { this.savedFluctuationSnapshot = this.fluctuationSnapshot() },
      releaseBakedPreview: () => this.releaseBakedPreviewForRebake(),
      restoreBakedPreview: (args) => this.restoreBakedPreviewAfterRebake(args)
    })
    // Cached from Settings once on load - the leave-confirmation prompt's
    // own "Don't ask again" button, not a general Settings toggle (per the
    // original request: the prompt itself carries the opt-out).
    this.skipLeaveConfirm = false

    // --- Preset mode / Group mode (v0.1.147) ---
    this.mode = 'sound'
    this.presets = []
    this.selectedPresetId = null
    this.wholeMixCurrent = cloneWholeMix(null)
    this.wholeMixSaved = cloneWholeMix(null)
    this._wholeMixSaveInProgress = false
    // Groups belonging to the selected preset, and whichever one is
    // currently open for editing.
    this.groups = []
    this.selectedGroupId = null
    this.groupCurrent = cloneGroupFilters(null)
    this.groupSaved = cloneGroupFilters(null)
    this._groupSaveInProgress = false
    // The Preset/Group spectrogram's own rAF loop (separate from
    // tickPreviewPlayhead, which only ever drives Sound mode) - see
    // tickWholeMixSpectrum()/stopWholeMixSpectrumTicking().
    this._wholeMixSpectrumRafId = null
    // Live loudness-over-time history (v0.1.148, "where's the waveform so I
    // can see where the audio is louder") - a rolling peak-level buffer per
    // mode, pushed once per tick and drawn as a scrolling strip; see
    // tickWholeMixSpectrum()/drawLevelHistory().
    this.presetLevelHistory = []
    this.groupLevelHistory = []
  }

  // The app (0.1.238+) swaps in plugin updates live, but waits while this
  // returns true, so an update never throws away edits: unsaved Sound,
  // Fluctuation, Preset or Group changes, or a save still writing.
  isBusy() {
    if (this.saveCtl.isSaving() || this._groupSaveInProgress) return true
    if (this.hasUnsavedChanges() || this.fluctuationDirty()) return true
    if (this.selectedPresetId && this.wholeMixCurrent && this.wholeMixSaved && !wholeMixEqual(this.wholeMixCurrent, this.wholeMixSaved)) return true
    return Boolean(this.selectedGroupId && this.groupCurrent && this.groupSaved && !groupFiltersEqual(this.groupCurrent, this.groupSaved))
  }

  async onload() {
    this.api.settings
      .get()
      .then((settings) => {
        this.skipLeaveConfirm = Boolean(settings.skipRemixLeaveConfirm)
      })
      .catch((err) => console.error('Editor: failed to load settings', err))

    // Ctrl+Z/Ctrl+Shift+Z - document-scoped since the tab bar has no notion
    // of "this specific tab's own keyboard shortcuts," but gated on
    // _tabActive (set by onShow/onHide below) so it's a no-op while a
    // different tab is on screen, and on the focused element not being a
    // free-text field (Start/End/Length/Times/Sync group) so native text-
    // undo inside those still works as expected.
    this._onKeyDown = (evt) => {
      if (!this._tabActive || !this.currentEntry) return
      if (this.handleMarkerKey(evt)) return
      if (!evt.ctrlKey || (evt.key !== 'z' && evt.key !== 'Z')) return
      const active = document.activeElement
      if (active && active.tagName === 'INPUT' && active.type === 'text') return
      if (active && active.tagName === 'TEXTAREA') return
      evt.preventDefault()
      if (evt.shiftKey) this.redo()
      else this.undo()
    }
    document.addEventListener('keydown', this._onKeyDown)

    // Per-preset sound overrides (planned 2026-09-12, "presets as primary
    // context"): the Mixer dispatches this whenever the active preset
    // changes (loadPreset, restoreLastActivePreset, deletePreset). If Sound
    // mode has a sound open that was pinned to a different preset
    // (editingPresetId), offer to reload it under the new context, reusing
    // the exact same leave-with-unsaved-changes confirmation already used
    // for switching sounds/tabs - declining keeps editing under the pinned
    // preset, so an in-flight Save still targets the right place.
    this._onActivePresetChanged = async () => {
      // mount() hasn't run yet (the Remix tab has never been opened this
      // session) - this.els is still empty, and refreshLibrary() touches
      // DOM elements that don't exist yet. Nothing to reconcile in that
      // case: there's no open sound, and the next real mount()/onShow will
      // do its own fresh refreshLibrary() anyway. Same guard onShow already
      // uses for its own refreshLibrary() call.
      if (!this.els.soundSearch) return
      await this.refreshLibrary().catch((err) => console.error('Editor: failed to refresh library after preset switch', err))
      if (this.mode !== 'sound' || !this.currentEntry) return
      if (this.editingPresetId === this.activePresetId) return
      // confirmLeaveIfDirty() shares one _resolveLeaveConfirm slot with
      // TabHost's own onBeforeHide call (leaving the Remix tab entirely) -
      // a second concurrent call would silently overwrite that resolver and
      // orphan whichever check got there first. Rare in practice (it needs
      // a tab switch and a preset switch in the same instant), but cheap to
      // guard: if a leave-confirm is already showing, don't start a second
      // one - just stay pinned to the current editing preset, same as the
      // user clicking "No" would.
      if (this.els.leaveConfirmDialog && !this.els.leaveConfirmDialog.classList.contains('hidden')) return
      const proceed = await this.confirmLeaveIfDirty()
      if (proceed) {
        this.loadSound(this.currentEntry.id).catch((err) => console.error('Editor: failed to reload sound after preset switch', err))
      }
    }
    window.addEventListener('noctivago:active-preset-changed', this._onActivePresetChanged)

    // The Presets window made, renamed, deleted or imported a preset. A
    // full refreshMixPanel only when the open preset is gone: it reloads the
    // preset controls from the saved copy, which would drop unsaved edits.
    this._onPresetsChanged = async () => {
      if (!this.els.soundSearch) return
      await this.refreshLibrary().catch((err) => console.error('Editor: failed to refresh presets', err))
      const open = this.selectedPresetId
      if (open ? !this.presets.some((p) => p.id === open) : this.presets.length > 0) {
        await this.refreshMixPanel().catch((err) => console.error('Editor: failed to refresh preset panel', err))
      }
    }
    window.addEventListener('noctivago:presets-changed', this._onPresetsChanged)

    // The Mixer's right-click "Edit in Remix": come to the front and open
    // that sound in Sound mode. Unsaved edits on a different sound get the
    // usual leave prompt first; declining keeps the current sound open.
    this._onEditSound = async (evt) => {
      const soundId = evt.detail?.soundId
      if (!soundId || !this.app.tabs.show) return
      await this.app.tabs.show('remix')
      if (!this._tabActive) return
      this.setMode('sound')
      if (this.currentEntry?.id === soundId) return
      if (this.currentEntry && !(await this.confirmLeaveIfDirty())) return
      await this.refreshLibrary().catch((err) => console.error('Editor: failed to refresh library', err))
      this.selectPickerSound(soundId)
    }
    window.addEventListener('noctivago:edit-sound', this._onEditSound)

    // The Mixer's preview player says which sound it is playing (the play
    // button on a group member row); redraw the rows so the button follows.
    this._onPreviewState = () => this.layout?.refreshStudio?.()
    window.addEventListener('noctivago:remix-preview-state', this._onPreviewState)

    this.unregister = this.app.tabs.register({
      id: 'remix',
      title: 'Remix',
      mount: (container) => this.mount(container),
      mountSticky: (container) => this.mountSticky(container),
      onShow: () => {
        this._tabActive = true
        // Picks up sounds added/removed elsewhere (e.g. the Mixer) since
        // this tab last mounted — mount() only runs once per tab lifetime,
        // so without this the picker would silently go stale.
        if (this.els.soundSearch) this.refreshLibrary().catch((err) => console.error('Editor: failed to refresh library', err))
        // Self-review v0.1.149, two fixes: (1) this used to unconditionally
        // fire on every tab open regardless of mode, doubling library.list()/
        // presets.list() IPC traffic for someone who only ever uses Sound
        // mode - now scoped to when Preset/Group mode is actually the one
        // showing. (2) the live-preview re-assert below used to fire
        // immediately, racing refreshMixPanel()'s own async resolution - if
        // the refresh discovered the previously-selected preset/group no
        // longer exists and fell back to a different one, the stale
        // pre-refresh dispatch below was the last word, not a corrected one.
        // Sequenced after the refresh settles instead.
        if (this.mode !== 'sound' && this.els.mixPresetSelect) {
          this.refreshMixPanel()
            .then(() => {
              if (this.mode === 'preset') this.dispatchWholeMixPreview(this.wholeMixCurrent)
              else if (this.mode === 'group' && this.selectedGroupId) this.dispatchGroupPreview(this.groupCurrent)
            })
            .catch((err) => console.error('Editor: failed to refresh preset/group panel', err))
          this.startWholeMixSpectrumTicking()
        }
        this._syncScrollTopVisibility?.()
      },
      onBeforeHide: () => this.confirmLeaveIfDirty(),
      onHide: () => {
        this._tabActive = false
        window.dispatchEvent(new CustomEvent('noctivago:remix-preview-sound', { detail: { stop: true } }))
        this.itemPreview.stop()
        this.activePreview()?.pause()
        this.stopPreviewTicking()
        this.setPlayPauseIcon(false)
        this.setSolo(false)
        // Drop any unsaved Preset/Group preview - the Mixer should reflect
        // the persisted state once this tab isn't actively being edited,
        // same convention the old separate Preset Remix plugin's own onHide
        // already established.
        this.dispatchWholeMixPreview(this.wholeMixSaved)
        if (this.selectedGroupId) this.dispatchGroupPreview(this.groupSaved)
        this.stopWholeMixSpectrumTicking()
      },
      onDestroy: () => this.disposePreview()
    })
  }

  async onunload() {
    if (this._onKeyDown) document.removeEventListener('keydown', this._onKeyDown)
    if (this._onActivePresetChanged) window.removeEventListener('noctivago:active-preset-changed', this._onActivePresetChanged)
    if (this._onPresetsChanged) window.removeEventListener('noctivago:presets-changed', this._onPresetsChanged)
    if (this._onEditSound) window.removeEventListener('noctivago:edit-sound', this._onEditSound)
    if (this._onPreviewState) window.removeEventListener('noctivago:remix-preview-state', this._onPreviewState)
    this.disposePreview()
    this.stopWholeMixSpectrumTicking()
    clearTimeout(this._seamDetailPeaksTimer)
    clearTimeout(this._spectrogramTimer)
    this.presetEq?.destroy()
    this.seamView?.destroy()
    this.spectralView?.destroy()
    this.filterControls?.unmount()
    this.groupEq?.destroy()
    this.flucVolBar?.destroy()
    this.flucPitchBar?.destroy()
    this.flucPanBar?.destroy()
    this.groupFlucPanBar?.destroy()
    this.groupFlucPitchBar?.destroy()
    for (const bars of Object.values(this.shotBars ?? {})) for (const bar of Object.values(bars)) bar.destroy()
    this.unregister?.()
  }

  // Not async: TabHost calls mount() without awaiting it, so an async
  // failure here wouldn't be caught by its fail-soft try/catch — kick off
  // the async part with its own local error handling instead.
  mount(container) {
    mountRemixApp(container, { previewVolume: this.previewVolume })
    mountSoundPicker(container.querySelector('#rx-picker-host'))
    mountLoopRow(container.querySelector('#rx-looprow-host'))
    mountPlaybackPanel(container.querySelector('#rx-playback-host'))
    mountSpeedPitchPanel(container.querySelector('#rx-speed-host'))
    mountPresetPanel(container.querySelector('#editor-mode-panel-preset'))
    mountGroupPanel(container.querySelector('#editor-mode-panel-group'))
    mountEqView(container.querySelector('#rx-eq-host-sound'), 'sound')
    mountEqView(container.querySelector('#rx-eq-host-group'), 'group')
    mountEqView(container.querySelector('#rx-eq-host-preset'), 'preset')
    mountTrimView(container.querySelector('#rx-trim-host'))
    mountSeamView(container.querySelector('#rx-seam-host'))
    mountSpectrumView(container.querySelector('#rx-spectrum-host'))
    mountDrift({
      sound: container.querySelector('#rx-drift-host-sound'),
      group: container.querySelector('#rx-drift-host-group'),
      preset: container.querySelector('#rx-drift-host-preset')
    })

    // Desktop 2.0 layout: wraps and moves the nodes above (layout.js).
    this.root = container
    this.layout = arrangeLayout(container, {
      onView: (view) => {
        if (view === 'seam') this.syncSeamView({ immediate: true })
      },
      onCompare: (which) => this.switchCompareView(which),
      getBands: (kind) => (kind === 'preset' ? this.presetEq : this.groupEq)?.getBands?.(),
      getStudio: () => this.studioState(),
      onPick: (kind, id) => this.pickFromLibrary(kind, id),
      detail: {
        get: (mode, sub) => this.detailView(mode, sub),
        setVolume: (_mode, _sub, id, gain, commit) => this.setDetailVolume(id, gain, commit),
        setPan: (id, pan) => this.setDetailPan(id, pan).catch((err) => console.error('Remix: pan save failed', err)),
        mute: (id) => this.mixerSoundAction('noctivago:remix-toggle-sound-mute', { soundId: id }),
        solo: (id, on) => this.soloInMixer(id, on),
        preview: (key) => this.toggleItemPreview(key).catch((err) => console.error('Remix: item preview failed', err)),
        loop: (id) => this.toggleItemLoop(id),
        rowStatus: () => ({ previewKey: this.itemPreview.key }),
        editSound: (id) => this.editFromDetail('sound', id),
        editGroup: (id) => this.editFromDetail('group', id)
      }
    })

    this.els = findAllEls(container)

    const mountCalls = this.mountCallbacks()
    this.loopEditorController = mountLoopEditor(this.els, mountCalls)
    this.spectralView = mountSpectral(this.els, this.loopEditorController, mountCalls)
    this.syncSpectralTool()
    this.seamView = mountSeam(this.els, this.loopEditorController, mountCalls)
    this.eqEditorController = mountEqEditor(this.els, mountCalls)
    this.waveformScrollbar = mountWaveformScrollbar(this.els, this.loopEditorController, mountCalls)
    wireNameMarquee(this.els.soundName)
    this.wireControls()
    this.wireScrollTop()
    this.wireLeaveConfirmDialog()
    this.refreshLibrary().catch((err) => console.error('Editor: failed to load library', err))

    // Same real EqEditor module Sound mode uses, one target per Preset / Group mode.
    Object.assign(this, mountMixEqTargets(this.root, mountCalls))
    // Fluctuation bars for Preset / Group mode and their control bundles.
    Object.assign(this, mountMixFluctuation(this.els, mountCalls))
    this.wireMixControls()
    this.refreshMixPanel().catch((err) => console.error('Editor: failed to load presets', err))
  }

  // The tab methods and state the per-panel mount functions (src/mounts/) call; all lazy.
  mountCallbacks() {
    const bind = (...names) => Object.fromEntries(names.map((n) => [n, this[n].bind(this)]))
    return {
      ...bind(
        'updateSpectralControls', 'applyFilterControls', 'syncSpectralTool', 'setMarkers', 'editMarker', 'syncSpectralView',
        'setSpectralTool', 'useShapeAsNoiseSample', 'applyCrossfadeControl', 'scheduleSeamDetailPeaks', 'liveLayout',
        'updateStickyProgress', 'commitLoopPoints', 'updateSaveButtonState', 'currentPlayMode', 'syncFadeToggle',
        'applyEqControls', 'togglePreviewMode', 'maybeFetchDetailPeaks', 'readPresetMixControlsAndPreview',
        'readGroupControlsAndPreview'
      ),
      hasSpectrogram: typeof this.api.audio.getSpectrogram === 'function',
      setFilterValues: (values) => this.filterControls.setValues(values),
      isSavedPreview: () => this.previewMode === 'saved',
      // fromSeam: the seam view also moves the sticky progress bar when playing the live source.
      scrubPreview: (source, fromSeam) => {
        if (this.previewMode === 'saved' && this.bakedPreview) {
          const clipTime = this.sourceTimeToClip(source)
          this.bakedPreview.scrubTo(clipTime)
          this.updateStickyProgress(clipTime)
        } else {
          this.previewSource?.scrubTo(source)
          if (fromSeam) this.updateStickyProgress(source)
        }
      },
      seekPreview: (sec) => {
        const active = this.activePreview()
        if (!active) return
        const t = this.previewMode === 'saved' ? this.sourceTimeToClip(sec) : sec
        active.scrubTo(t)
        this.spectralView.setPlayhead(sec)
        this.loopEditorController?.setPlayhead(sec)
        this.updateStickyProgress(t)
      },
      getPresetSavedBands: () => this.wholeMixSaved.eq,
      getGroupSavedBands: () => this.groupSaved.eq,
      onPresetApply: (bands) => {
        this.wholeMixCurrent = { ...this.wholeMixCurrent, eq: bands }
        this.updateModeUI()
        if (this.mode === 'preset') this.dispatchWholeMixPreview(this.wholeMixCurrent)
      },
      onGroupApply: (bands) => {
        this.groupCurrent = { ...this.groupCurrent, eq: bands }
        this.updateModeUI()
        if (this.mode === 'group') this.dispatchGroupPreview(this.groupCurrent)
      },
      patchPresetVolume: (vals) => {
        this.wholeMixCurrent.fluctuation = { ...this.wholeMixCurrent.fluctuation, volume: { ...this.wholeMixCurrent.fluctuation.volume, ...vals } }
      },
      patchGroupVolume: (vals) => {
        this.groupCurrent.fluctuation = { ...this.groupCurrent.fluctuation, volume: { ...this.groupCurrent.fluctuation.volume, ...vals } }
      }
    }
  }

  // Floating "scroll to top" button, requested directly since this panel has
  // grown long (waveform, times, playmode, crossfade/scatter, speed/pitch,
  // filters, 7-band EQ, presets) - a real trip back to the top otherwise
  // needs a lot of manual scrolling. #tab-content is the *shared* scroll
  // container every tab's panel lives inside (see main.css's `main {
  // overflow-y: auto }`) - only the active tab's own <section> is ever
  // visible at a time (TabHost.js toggles a hidden class on the rest), so
  // this button - appended inside Remix's own panel markup - automatically
  // hides itself whenever a different tab is active, the same way the rest
  // of this tab's content already does, with zero extra onShow/onHide
  // bookkeeping needed just for that.
  wireScrollTop() {
    const scrollContainer = document.getElementById('tab-content')
    const THRESHOLD_PX = 300
    const updateVisibility = () => {
      this.els.scrollTop.classList.toggle('hidden', scrollContainer.scrollTop < THRESHOLD_PX)
    }
    scrollContainer.addEventListener('scroll', updateVisibility)
    this.els.scrollTop.addEventListener('click', () => {
      scrollContainer.scrollTo({ top: 0, behavior: 'smooth' })
    })
    // Re-syncs on every tab switch back to Remix - the shared container's
    // scrollTop reflects whatever the previously-active tab's content left
    // it at, not necessarily anything meaningful for this tab's own layout.
    this._syncScrollTopVisibility = updateVisibility
    updateVisibility()
  }

  // The control wiring lives in src/controls/, one module per panel (rebuild
  // step 10l). Each takes the elements it listens to and the tab methods it
  // calls, bound once here.
  wireControls() {
    const bind = (...names) => Object.fromEntries(names.map((n) => [n, this[n].bind(this)]))
    const els = this.els
    wirePickerControls(els, {
      ...bind('openPicker', 'closePicker', 'filteredPickerSounds', 'renderPickerOptions', 'selectPickerSound'),
      setQuery: (text) => (this.pickerQuery = text),
      getHighlight: () => this.pickerHighlightIndex,
      setHighlight: (i) => (this.pickerHighlightIndex = i)
    })
    wireTrimControls(els, bind('applyManualLoopPoints', 'applyManualLength', 'applyManualNeedle', 'suggestLoopPoint'))
    wirePlayModeControls(
      els,
      bind('applyPlayModeControl', 'applyScatterControls', 'applyScheduleControls', 'toggleFade', 'syncFadeToggle')
    )
    wireShapeControls(
      els,
      this.loopEditorController,
      bind('applyCrossfadeControl', 'toggleSeamListen', 'applyFilterControls', 'applySpeedPitchControls')
    )
    this.filterControls = wireFilterControls(
      els,
      { layout: this.layout, loopEditor: this.loopEditorController, spectralView: this.spectralView },
      bind('applyFilterControls', 'setFilterSliders', 'setSpectralTool', 'syncNoiseBand')
    )
    wireEqControls(
      els,
      this.eqEditorController,
      bind('applyEqControls', 'applyEqFieldsToSelectedBand', 'updateEqFieldsFromSelection', 'switchEqCompareView', 'revertEqToSaved')
    )
    this.fluctuation = defaultFluctuation()
    const bars = wireFluctuationControls(els, {
      patchFluctuation: (axis, vals) => (this.fluctuation[axis] = { ...this.fluctuation[axis], ...vals }),
      ...bind('applyFluctuationControls', 'applyScatterControls', 'applyScheduleControls')
    })
    Object.assign(this, bars)
  }

  // Builds the sticky bar's own contents - Play/Pause, the loop toggle, a
  // progress bar/time readout for the trim preview, and Save (moved here
  // from the bottom of the scrollable panel per direct feedback: "It's
  // annoying just changing something on the top of the tab and then having
  // to scroll right to the end just to save") - kept separate from
  // wireControls() above because it's mounted into a different container
  // (the shared #tab-sticky-bar, see TabHost.js's mountSticky), not the
  // scrollable panel body. Only ever called once, same lazy-mount-once
  // lifecycle mount() itself already has.
  mountSticky(container) {
    // The controls are rendered in the studio panes by RemixApp (mount()).
    this.els.playPause = this.root.querySelector('#editor-play-pause')
    this.els.loopToggle = this.root.querySelector('#editor-loop-toggle')
    this.els.previewModeToggle = this.root.querySelector('#editor-preview-mode-toggle')
    this.els.previewModeToggle.addEventListener('click', () => this.togglePreviewMode())
    this.els.stickyProgress = this.root.querySelector('#editor-sticky-progress')
    this.els.stickyProgressFill = this.root.querySelector('#editor-sticky-progress-fill')
    this.els.stickyProgressThumb = this.root.querySelector('#editor-sticky-progress-thumb')
    this.els.stickyTime = this.root.querySelector('#editor-sticky-time')
    this.wireStickyProgressDrag()
    this.els.stickyVolume = this.root.querySelector('#editor-sticky-volume')
    this.els.stickyMute = this.root.querySelector('#editor-sticky-mute')
    this.els.stickySolo = this.root.querySelector('#editor-sticky-solo')
    this.els.undo = this.root.querySelector('#editor-undo')
    this.els.redo = this.root.querySelector('#editor-redo')
    this.els.cancel = this.root.querySelector('#editor-cancel')
    this.els.undo.addEventListener('click', () => this.undo())
    this.els.redo.addEventListener('click', () => this.redo())
    this.els.cancel.addEventListener('click', () => this.cancelEdits())
    this.els.save = this.root.querySelector('#editor-save')
    this.els.saveLabel = this.root.querySelector('#editor-save-label')
    // Save works in place on apps with the morph states (2.0+, micro-interactions mock, row "Remix
    // save", the preset pill's states): Saving, then Changes saved with a drawn check, or the reason
    // in soft red; Cancel shows Changes canceled. Older apps keep the plain label.
    this.saveMorph = this.app.ui?.morphButton?.(this.els.save) ?? null
    this._saveLabelText = 'Save'
    this.els.save.addEventListener('click', () => this.save().catch((err) => console.error('Editor: save failed', err)))
    this.els.saveAsCopy = this.root.querySelector('#editor-save-as-copy')
    this.els.saveAsCopy.addEventListener('click', () => this.saveAsCopy().catch((err) => console.error('Editor: save as copy failed', err)))
    this.els.saveSegment = this.root.querySelector('#editor-save-segment')
    this.els.saveSegment.addEventListener('click', () => this.saveSegmentAsNew().catch((err) => console.error('Editor: save segment failed', err)))

    this.els.playPause.addEventListener('click', async () => {
      const active = this.activePreview()
      if (!active) return
      this.stopSeamListen({ pause: false })
      if (active.playing) {
        active.pause()
        this.stopPreviewTicking()
        this.setPlayPauseIcon(false)
        this.eqEditorController.clearSpectrum()
      } else {
        try {
          await this.engine.resume()
          await active.play()
          this.setPlayPauseIcon(true)
          this.tickPreviewPlayhead()
        } catch (err) {
          console.error('Failed to preview sound', err)
        }
      }
    })

    this.els.loopToggle.addEventListener('click', () => {
      this.looping = !this.looping
      this.updateLoopToggleVisual()
      this.previewSource?.setLooping(this.looping)
    })

    // Persists across sounds within the tab session, same as looping above -
    // a preview-workflow preference, not per-sound saved state (unrelated to
    // the per-sound volume slider in the Mixer, which *is* saved).
    this.els.stickyVolume.addEventListener('input', () => {
      this.previewVolume = Number(this.els.stickyVolume.value) / 100
      // Dragging the slider while muted implicitly unmutes - same
      // convention the Mixer's volume sliders use.
      if (this.previewMuted) {
        this.previewMuted = false
        this.updatePreviewMuteIcon()
      }
      this.activePreview()?.setVolume(this.effectivePreviewVolume())
    })

    this.els.stickyMute.addEventListener('click', () => {
      this.previewMuted = !this.previewMuted
      this.updatePreviewMuteIcon()
      this.activePreview()?.setVolume(this.effectivePreviewVolume())
    })

    this.els.stickySolo.addEventListener('click', () => this.toggleSolo())
    this.updatePreviewMuteIcon()

    this.els.stickySoundControls = this.root.querySelector('#editor-sticky-sound-controls')
    // The sound picker lives in the bar's left slot (layout.js moves it there),
    // so the sound can be switched from anywhere. mount() built and wired it.
    this.els.soundPicker = this.els.soundSearch?.closest('.editor-picker')
    this.els.soundPicker?.classList.toggle('hidden', this.mode !== 'sound')
    this.els.stickyMixControls = this.root.querySelector('#editor-sticky-mix-controls')
    this.els.mixPlayPause = this.root.querySelector('#editor-mix-play-pause')
    this.els.mixSoloGroup = this.root.querySelector('#editor-mix-solo-group')
    this.els.mixStatus = this.root.querySelector('#editor-mix-status')
    this.els.mixSave = this.root.querySelector('#editor-mix-save')
    this.els.mixDeleteGroup = this.root.querySelector('#editor-mix-delete-group')
    this.els.mixCopyGroupTo = this.root.querySelector('#editor-mix-copy-group-to')
    this.els.mixMute = this.root.querySelector('#editor-mix-mute')
    this.els.mixVolume = this.root.querySelector('#editor-mix-volume')
    this.els.mixVolume.addEventListener('input', () => {
      window.dispatchEvent(new CustomEvent('noctivago:remix-set-volume', { detail: { position: Number(this.els.mixVolume.value) / 1000 } }))
    })
    this.els.mixMute.addEventListener('click', () => window.dispatchEvent(new CustomEvent('noctivago:remix-toggle-mute', {})))
    this.els.mixPlayPause.addEventListener('click', () => this.onMixPlayPauseClick())
    this.els.mixSoloGroup.addEventListener('click', () => this.onMixSoloGroupClick())
    this.els.mixSave.addEventListener('click', () => {
      if (this.mode === 'preset') this.saveWholeMix().catch((err) => console.error('Editor: preset save failed', err))
      else if (this.mode === 'group') this.saveGroup().catch((err) => console.error('Editor: group save failed', err))
    })
    this.els.mixDeleteGroup.addEventListener('click', () => this.deleteGroup().catch((err) => console.error('Editor: group delete failed', err)))
    this.els.mixCopyGroupTo.addEventListener('change', () => {
      const targetPresetId = this.els.mixCopyGroupTo.value
      this.copyGroupToPreset(targetPresetId).catch((err) => console.error('Editor: group copy failed', err))
    })
    arrangeBar(container, this.root)
    this.markerUi = mountMarkerUi(this.root, {
      onAdd: () => this.addMarkerAtPlayhead(),
      onGo: (id) => this.goToMarker(id),
      onDelete: (id) => this.deleteMarker(id)
    })
    this.refreshMarkerUi()
    this.setBarEnabled(Boolean(this.currentEntry))
  }

  // --- Timing markers ---
  // A named point on the open sound (Marker button, Ctrl+M). They show on the
  // progress bar, the Trim waveform and the Spectrum view, and a trim handle
  // or repair-box edge snaps to one. Saved per sound in this app's
  // localStorage (markerStore.js), not part of the baked audio.

  // The playhead in original-file seconds, whichever engine is audible.
  currentSourceTime() {
    const active = this.activePreview()
    const points = this.loopEditorController?.getLoopPoints()
    if (!active) return points?.loopStart ?? 0
    return this.previewMode === 'saved' ? this.clipTimeToSource(active.currentTime) : active.currentTime
  }

  setMarkers(list, { save = true } = {}) {
    this.markers = list
    if (save && this.currentEntry) saveMarkers(this.currentEntry.id, list)
    this.loopEditorController?.setMarkers(list)
    this.spectralView?.setMarkers(list)
    this.refreshMarkerUi()
  }

  refreshMarkerUi() {
    if (!this.markerUi) return
    const points = this.loopEditorController?.getLoopPoints()
    const selected = this.loopEditorController?.getSelectedMarker?.() ?? null
    renderMarkerChips(this.markerUi.list, this.markers, selected)
    renderProgressTicks(this.els.stickyProgress, this.markers, points?.loopStart ?? 0, points?.loopEnd ?? 0)
  }

  addMarkerAtPlayhead() {
    if (!this.currentEntry || this.mode !== 'sound') return
    const duration = this.currentEntry.durationSeconds ?? Infinity
    const t = this.currentSourceTime()
    const { markers, added } = addMarker(this.markers, t, duration)
    if (!added) {
      this.els.saveStatus.textContent = `A marker is already at ${formatMarkerTime(t)}`
      return
    }
    this.setMarkers(markers)
    this.loopEditorController?.selectMarker(added.id)
    this.spectralView?.selectMarker(added.id)
    flashMarkerButton(this.markerUi?.button)
    this.els.saveStatus.textContent = `Marker at ${formatMarkerTime(added.time)}`
  }

  goToMarker(id) {
    const marker = this.markers.find((m) => m.id === id)
    const active = this.activePreview()
    if (!marker || !active) return
    const t = this.previewMode === 'saved' ? this.sourceTimeToClip(marker.time) : marker.time
    active.scrubTo(t)
    this.loopEditorController?.setPlayhead(marker.time)
    this.spectralView?.setPlayhead(marker.time)
    this.updateStickyProgress(t)
  }

  deleteMarker(id) {
    closeMarkerPopover()
    this.setMarkers(removeMarker(this.markers, id))
  }

  editMarker(marker, clientX, clientY) {
    this.loopEditorController?.selectMarker(marker.id)
    this.spectralView?.selectMarker(marker.id)
    openMarkerPopover(this.root.ownerDocument, marker, clientX, clientY, {
      onRename: (name) => this.setMarkers(renameMarker(this.markers, marker.id, name)),
      onColor: (color) => this.setMarkers(updateMarker(this.markers, marker.id, { color })),
      onGo: () => this.goToMarker(marker.id),
      onDelete: () => this.deleteMarker(marker.id)
    })
  }

  // Ctrl+M adds a marker; Delete removes the selected one. Returns true when
  // the key was ours.
  handleMarkerKey(evt) {
    const active = document.activeElement
    const typing = !!active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT' || active.isContentEditable)
    const selected = this.loopEditorController?.getSelectedMarker?.()
    const action = markerKeyAction(evt, {
      mode: this.mode,
      typing,
      hasSelected: selected != null,
      onSpectral: evt.target === this.els.spectralCanvas
    })
    if (action === 'add') {
      evt.preventDefault()
      this.addMarkerAtPlayhead()
      return true
    }
    if (action === 'delete') {
      evt.preventDefault()
      this.deleteMarker(selected)
      return true
    }
    return false
  }

  effectivePreviewVolume() {
    return this.previewMuted ? 0 : this.previewVolume
  }

  // Whichever engine Play/Pause, volume/mute, and the sticky progress bar
  // are actually driving right now - see this.previewMode's own doc
  // comment. Every sticky-bar control reads through this rather than
  // hardcoding previewSource, so switching modes doesn't need special-casing
  // at each call site.
  activePreview() {
    return this.previewMode === 'saved' && this.bakedPreview ? this.bakedPreview : this.previewSource
  }

  // Whether there's a real baked clip to switch into Saved mode for at all.
  // v0.1.142: no longer requires the bake to still be *fresh* - staleness
  // (edits made since that bake) doesn't disqualify it, since the toggle is
  // now sticky (see previewMode's own doc comment) rather than auto-
  // reverting the instant an edit makes the bake stale. This only gates
  // whether Saved mode is reachable at all - a sound that's never been
  // saved has nothing to compare against.
  savedPreviewEligible() {
    return Boolean(this.currentEntry?.loopClipReady) && Boolean(this.bakedPreview)
  }

  // v0.1.214: the toggle is never disabled - owner's direct requirement
  // ("it always has to change between live preview and saved audio
  // preview"). Switching to Saved with no usable bake (never saved, or the
  // last render failed) renders one first instead of refusing.
  async togglePreviewMode() {
    if (this._togglingPreviewMode) return
    if (this.previewMode !== 'saved' && !this.savedPreviewEligible()) {
      if (this._clipRebaking || this.saveCtl.isSaving() || this.eqCompareViewing === 'B') return
      this._togglingPreviewMode = true
      const entry = this.currentEntry
      try {
        this.els.saveStatus.textContent = 'Rendering saved audio…'
        await this.save({ forceBake: true })
      } finally {
        this._togglingPreviewMode = false
      }
      if (this.currentEntry !== entry) return
      if (!this.savedPreviewEligible()) {
        this.els.saveStatus.textContent = "Couldn't render the saved audio - still on Live edit. Click the toggle to try again."
        return
      }
    }
    // Switching stops playback rather than trying to hand off mid-stream
    // between two structurally different engines (one crossfading pair of
    // <audio> elements through a live filter chain vs. one plain looping
    // <audio> element) - simpler and more predictable than attempting a
    // seamless handoff for what's fundamentally an A/B comparison tool, not
    // a continuous listening experience.
    this.stopSeamListen({ pause: false })
    const wasPlaying = this.activePreview()?.playing
    this.activePreview()?.pause()
    this.stopPreviewTicking()
    this.setPlayPauseIcon(false)
    this.eqEditorController.clearSpectrum()
    this.previewMode = this.previewMode === 'saved' ? 'live' : 'saved'
    this.updatePreviewModeToggle()
    this.updateStickyProgress(0)
    if (wasPlaying) {
      this.engine
        .resume()
        .then(() => this.activePreview()?.play())
        .then(() => {
          this.setPlayPauseIcon(true)
          this.tickPreviewPlayhead()
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
  updatePreviewModeToggle() {
    if (!this.els.previewModeToggle) return
    const eligible = this.savedPreviewEligible()
    if (mustFallBackToLive({ mode: this.previewMode, eligible, rebaking: this._clipRebaking })) {
      // Pause whichever engine (bakedPreview) is actually live *before*
      // flipping the mode - activePreview() reads this.previewMode, so
      // pausing after the flip would silently target the wrong (idle)
      // engine and leave the real one playing in the background.
      this.activePreview()?.pause()
      this.stopPreviewTicking()
      this.setPlayPauseIcon(false)
      this.previewMode = 'live'
    }
    this.els.previewModeToggle.disabled = false
    const toggle = previewModeToggleState({ mode: this.previewMode, eligible, stale: this.hasUnsavedChanges() })
    this.els.previewModeToggle.textContent = toggle.text
    this.els.previewModeToggle.classList.toggle('editor-preview-mode-toggle-active', toggle.active)
    this.els.previewModeToggle.classList.toggle('editor-preview-mode-toggle-stale', toggle.stale)
    this.els.previewModeToggle.title = toggle.title
    // Keep the "drift needs Live edit preview" note in sync with the mode.
    if (this.flucVolBar) this.updateFluctuationEnabledUI()
  }

  updatePreviewMuteIcon() {
    this.els.stickyMute.innerHTML = this.previewMuted ? MUTE_ICON_SVG : VOLUME_ICON_SVG
    this.els.stickyMute.title = this.previewMuted ? 'Unmute' : 'Mute'
    this.els.stickyMute.classList.toggle('btn-svg-icon-active', this.previewMuted)
  }

  updateLoopToggleVisual() {
    this.els.loopToggle.classList.toggle('editor-loop-icon-btn-active', this.looping)
    this.els.loopToggle.setAttribute('aria-pressed', String(this.looping))
  }

  // Core's Mixer has no direct access to this plugin's state (or vice
  // versa) - plugins only get the curated window.noctivago IPC surface, and
  // mute is deliberately session-only/unpersisted, so there's no library
  // data to round-trip through either. A plain window CustomEvent is the
  // simplest bridge that doesn't require either side to import the other;
  // see tabs/mixer/index.js's own 'noctivago:remix-solo' listener.
  toggleSolo() {
    if (!this.currentEntry) return
    this.setSolo(!this.soloActive)
  }

  setSolo(active) {
    if (this.soloActive === active) return
    this.soloActive = active
    this.els.stickySolo?.classList.toggle('editor-sticky-solo-active', active)
    if (this.currentEntry) {
      window.dispatchEvent(new CustomEvent('noctivago:solo', { detail: { soundId: this.currentEntry.id, active } }))
    }
  }

  setPlayPauseIcon(playing) {
    // The main transport and a row preview never play at once.
    if (playing) this.itemPreview?.stop()
    if (!this.els.playPause) return
    this.els.playPause.innerHTML = playing ? PAUSE_ICON_SVG : PLAY_ICON_SVG
    this.els.playPause.title = playing ? 'Pause' : 'Play'
  }

  // Per-preset sound overrides (planned 2026-09-12): also fetches
  // this.presets here (not just when Preset/Group mode is opened, via
  // refreshMixPanel) so Sound mode's override merge has fresh data on its
  // very first load too - a plain, cheap, side-effect-free list fetch,
  // unlike refreshMixPanel's own heavier UI wiring. this.activePresetId is
  // re-read from the Mixer on every call via requestMixerStatus() - the
  // same synchronous bridge Preset/Group mode's Play button already uses.
  async refreshLibrary() {
    this.activePresetId = requestMixerStatus().activePresetId
    const [library, presets] = await Promise.all([this.api.library.list(), this.api.presets.list()])
    this.presets = presets
    this.renderPresetSelectOptions()
    this.baseLibrary = library
    const activePreset = this.presets.find((p) => p.id === this.activePresetId)
    this.library = library.map((entry) => {
      // A sound out of the mix shows the preset's parked copy, which is what
      // the Mixer plays (app presets.js removedOverrides, PR #170).
      const override = activePreset?.sounds.find((s) => s.soundId === entry.id)?.overrides ?? activePreset?.removedOverrides?.[entry.id]
      return applySoundOverride(entry, override)
    })
    if (this.currentEntry) {
      const updated = this.editableSounds().find((s) => s.id === this.currentEntry.id)
      // Don't stomp on text the user is actively typing to search.
      if (updated && document.activeElement !== this.els.soundSearch) this.setSearchValue(updated.name)
      else if (!updated) this.els.soundSearch.value = ''
    }
    if (!this.els.soundOptions.classList.contains('hidden')) this.renderPickerOptions()
    this.layout?.refreshStudio?.()
  }

  editableSounds() {
    return this.library.filter((s) => s.status !== 'missing')
  }

  // Step 13d: what the library pane lists and what the center head says,
  // for the mode on screen (layout.js buildStudio draws it).
  studioState() {
    const mode = this.mode ?? 'sound'
    const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`
    if (mode === 'sound') {
      const MODE = { loop: 'loop', scatter: 'random', scheduled: 'scheduled' }
      const ICON = { loop: 'audio-waveform', scatter: 'shuffle', scheduled: 'clock' }
      const length = (e) => {
        const start = Number(e.loopStart) || 0
        const end = e.loopEnd == null ? Number(e.durationSeconds) : Number(e.loopEnd)
        return Number.isFinite(end) && end > start ? end - start : null
      }
      const metaOf = (e, playMode = e.playMode) => [length(e) != null ? formatDuration(length(e)) : null, MODE[playMode] ?? 'loop', e.included ? 'in mix' : null].filter(Boolean).join(' · ')
      const items = (this.library ?? []).filter((s) => s.status !== 'missing').map((e) => ({ id: e.id, name: e.name, meta: metaOf(e), icon: ICON[e.playMode] ?? ICON.loop, dot: Boolean(e.included), dotTitle: 'in the mix' }))
      const entry = this.currentEntry
      const radio = this.root?.querySelector('.rx-tiles3 input:checked')?.value
      const head = entry ? { name: entry.name, meta: metaOf(entry, radio ?? entry.playMode) } : { name: 'No sound open', meta: 'Pick a sound from the list' }
      return { mode, items, currentId: entry?.id ?? null, head }
    }
    const presetLive = this.selectedPresetId && this.selectedPresetId === this.activePresetId
    if (mode === 'preset') {
      const items = (this.presets ?? []).map((p) => ({ id: p.id, name: p.name, meta: `whole mix · ${plural(p.sounds?.length ?? 0, 'sound')}`, icon: 'bookmark', dot: p.id === this.activePresetId, dotTitle: 'playing in the Mixer' }))
      const preset = items.find((p) => p.id === this.selectedPresetId)
      const head = preset ? { name: preset.name, meta: preset.meta + (preset.dot ? ' · in the Mixer' : '') } : { name: 'No preset open', meta: 'Save a preset in the Mixer first' }
      return { mode, items, currentId: preset?.id ?? null, head }
    }
    const presetName = this.presets?.find((p) => p.id === this.selectedPresetId)?.name
    const items = (this.groups ?? []).map((g) => ({ id: g.id, name: g.name, meta: `group · ${plural(g.soundIds?.length ?? 0, 'sound')}`, icon: 'layers', dot: Boolean(presetLive), dotTitle: 'its preset plays in the Mixer' }))
    const group = items.find((g) => g.id === this.selectedGroupId)
    const head = group
      ? { name: group.name, meta: `${group.meta}${presetName ? ` · in ${presetName}` : ''}` }
      : { name: 'No group open', meta: presetName ? `Pick or make a group in ${presetName}` : 'Pick a preset first' }
    return { mode, items, currentId: group?.id ?? null, head }
  }

  pickFromLibrary(kind, id) {
    if (kind === 'sound') {
      if (id !== this.currentEntry?.id) this.selectPickerSound(id)
      return
    }
    const select = kind === 'preset' ? this.els.mixPresetSelect : this.els.mixGroupSelect
    if (select.value === id && (kind === 'preset' ? this.selectedPresetId : this.selectedGroupId) === id) return
    select.value = id
    select.dispatchEvent(new Event('change', { bubbles: true }))
  }

  // The library's drill-in panel (layout.js buildStudio, LibraryDetail.jsx):
  // the open group's members, or the open preset's groups and loose sounds.
  // When the preset is the one loaded in the Mixer, volumes are the Mixer's
  // live ones and Mute/Solo work.
  detailView(mode, sub) {
    const status = requestMixerStatus()
    const preset = this.presets.find((p) => p.id === this.selectedPresetId)
    const live = Boolean(preset) && status.activePresetId === preset.id
    const volumes = live && status.soundVolumes ? status.soundVolumes : null
    const volumeOf = volumes ? (id) => volumes[id] : null
    const lib = this.baseLibrary ?? this.library ?? []
    // Solo (like Mute) acts on the Mixer's live mix; the member rows' play button previews from the library.
    const kinds = {}
    for (const s of preset?.sounds ?? []) kinds[s.soundId] = previewKind(effectiveSound(lib, preset, s.soundId))
    for (const g of this.groups ?? []) for (const id of g.soundIds ?? []) if (!kinds[id]) kinds[id] = previewKind(effectiveSound(lib, preset, id))
    const rowStatus = { live, soloedId: status.soloedSoundId ?? null, previewKey: this.itemPreview.key, loops: [...this.itemLoops], kinds }
    if (mode === 'group') return { top: groupDetail(this.groups.find((g) => g.id === this.selectedGroupId), preset, lib, volumeOf), status: rowStatus }
    const top = presetDetail(preset, lib, volumeOf)
    let subView = null
    if (sub?.kind === 'group') subView = groupDetail(preset?.groups?.find((g) => g.id === sub.id), preset, lib, volumeOf)
    else if (sub?.kind === 'sound') subView = soundDetail(preset, sub.id, lib, volumeOf)
    const isSound = sub?.kind === 'sound'
    return {
      top,
      sub: subView,
      status: {
        ...rowStatus,
        live,
        canMute: Array.isArray(status.mutedSoundIds),
        muted: isSound && (status.mutedSoundIds ?? []).includes(sub.id),
        soloed: isSound && status.soloedSoundId === sub.id
      }
    }
  }

  // Live preset: the Mixer applies the volume (and autosaves the preset as
  // a drag there would). Otherwise the stored preset is written once, at
  // the end of the drag.
  setDetailVolume(soundId, gain, commit) {
    const preset = this.presets.find((p) => p.id === this.selectedPresetId)
    if (!preset) return
    if (requestMixerStatus().activePresetId === preset.id) {
      const detail = { presetId: preset.id, soundId, volume: gain, applied: false }
      window.dispatchEvent(new CustomEvent('noctivago:remix-set-sound-volume', { detail }))
      if (detail.applied) {
        if (commit) this.layout?.refreshStudio?.()
        return
      }
    }
    if (!commit) return
    const sounds = withSoundVolume(preset, soundId, gain)
    if (!sounds) return
    preset.sounds = sounds
    this.api.presets
      .updateSounds(preset.id, sounds)
      .then((saved) => {
        if (saved) this.presets = this.presets.map((p) => (p.id === saved.id ? saved : p))
        this.layout?.refreshStudio?.()
      })
      .catch((err) => console.error('Remix: volume save failed', err))
  }

  // Pan in this preset is a preset override (filters.pan), the same slot a
  // Sound-mode save writes; the Mixer hears it like one.
  async setDetailPan(soundId, pan) {
    const preset = this.presets.find((p) => p.id === this.selectedPresetId)
    const overrides = panOverride(preset, soundId, this.baseLibrary ?? this.library ?? [], pan)
    if (!overrides) return
    const updated = await this.api.presets.updateSoundOverride(preset.id, soundId, overrides)
    if (updated) this.presets = this.presets.map((p) => (p.id === updated.id ? updated : p))
    const saved = updated?.sounds.find((s) => s.soundId === soundId)?.overrides ?? overrides
    window.dispatchEvent(new CustomEvent('noctivago:sound-override-changed', { detail: { presetId: preset.id, soundId, overrides: saved } }))
    await this.refreshLibrary()
  }

  // Solo needs this preset live in the Mixer: when it is not, load it first
  // (what the owner wants to hear anyway), then solo once it is there.
  async soloInMixer(id, on) {
    const preset = this.presets.find((p) => p.id === this.selectedPresetId)
    if (on && preset && requestMixerStatus().activePresetId !== preset.id) {
      window.dispatchEvent(new CustomEvent('noctivago:remix-load-preset', { detail: { presetId: preset.id } }))
      for (let i = 0; i < 40 && requestMixerStatus().activePresetId !== preset.id; i++) await new Promise((r) => setTimeout(r, 100))
      if (requestMixerStatus().activePresetId !== preset.id) return
    }
    this.mixerSoundAction('noctivago:solo', { soundId: id, active: on })
  }

  // A row's Play: the item with all its settings, from Remix's own engine
  // (never the Mixer). key is 's:<soundId>' or 'g:<groupId>'; the same key
  // again stops it.
  async toggleItemPreview(key) {
    if (this.itemPreview.isPlaying(key)) return this.itemPreview.stop()
    this.activePreview()?.pause()
    this.stopPreviewTicking()
    this.setPlayPauseIcon(false)
    window.dispatchEvent(new CustomEvent('noctivago:remix-preview-sound', { detail: { stop: true } }))
    const found = this.presets.find((p) => p.id === this.selectedPresetId) ?? null
    const lib = this.baseLibrary ?? this.library ?? []
    // What a row's Play hears depends on the mode (owner, 2026-11-14):
    // Sound = the sound's own settings; Group = + its group; Preset = + the
    // preset's volume, overrides and whole-mix settings.
    const inPreset = this.mode === 'preset'
    const preset = inPreset ? found : null
    const status = requestMixerStatus()
    const live = inPreset && Boolean(found) && status.activePresetId === found.id
    const gainOf = (id) => (live ? status.soundVolumes?.[id] : null)
    const groups = found?.groups ?? this.groups ?? []
    const groupFilters = (g) => (g && g.id === this.selectedGroupId && this.mode === 'group' ? this.groupCurrent : g?.filters)
    const wholeMix = inPreset ? (this.wholeMixCurrent ?? found?.wholeMix ?? null) : null
    const id = key.slice(2)
    if (key.startsWith('g:')) {
      const group = groups.find((g) => g.id === id)
      const plan = groupPlan(lib, preset, group && { ...group, filters: groupFilters(group) }, { gainOf })
      return this.itemPreview.playGroup(key, plan, [wholeMix])
    }
    const inGroups = groups.filter((g) => (g.soundIds ?? []).includes(id))
    const group = this.mode === 'sound' ? null : (inGroups.find((g) => g.id === this.selectedGroupId) ?? inGroups[0])
    return this.itemPreview.playSound(key, soundPlan(lib, preset, id, { repeat: this.itemLoops.has(id), gain: gainOf(id) }), [group ? groupFilters(group) : null, wholeMix])
  }

  // A shot firing: a short amber flash on that sound's name (mock .shot).
  // data-rx-shots counts them, for the e2e.
  flashShot(id) {
    if (!this.root) return
    this.root.dataset.rxShots = String(Number(this.root.dataset.rxShots ?? 0) + 1)
    for (const r of this.root.querySelectorAll(`[data-key="s:${CSS.escape(id)}"]`)) {
      r.classList.remove('rx-shot')
      void r.offsetWidth
      r.classList.add('rx-shot')
    }
  }

  toggleItemLoop(id) {
    const on = !this.itemLoops.has(id)
    if (on) this.itemLoops.add(id)
    else this.itemLoops.delete(id)
    this.itemPreview.setRepeat(id, on)
    this.layout?.refreshStudio?.()
  }

  mixerSoundAction(eventName, detail) {
    window.dispatchEvent(new CustomEvent(eventName, { detail }))
    this.layout?.refreshStudio?.()
  }

  editFromDetail(kind, id) {
    this.setMode(kind)
    this.pickFromLibrary(kind, id)
    this.layout?.refreshStudio?.()
  }

  filteredPickerSounds() {
    return filterPickerSounds(this.editableSounds(), this.pickerQuery)
  }

  openPicker() {
    this.pickerHighlightIndex = -1
    this.renderPickerOptions()
    this.els.soundOptions.classList.remove('hidden')
  }

  closePicker() {
    this.els.soundOptions.classList.add('hidden')
  }

  renderPickerOptions() {
    const options = this.filteredPickerSounds()
    this.els.soundOptions.innerHTML = ''

    // Mirrors the old native <select>'s always-present blank option - lets
    // the user explicitly go back to "nothing selected" instead of only
    // ever switching between sounds. Only shown before the user's typed a
    // search, so it doesn't get in the way of narrowing results down.
    if (this.currentEntry && !this.pickerQuery.trim()) {
      const clear = document.createElement('li')
      clear.className = 'editor-sound-option editor-sound-option-clear'
      clear.textContent = 'Select a sound to edit…'
      clear.addEventListener('mousedown', (evt) => {
        evt.preventDefault()
        this.clearPickerSelection()
      })
      this.els.soundOptions.appendChild(clear)
    }

    if (options.length === 0) {
      const empty = document.createElement('li')
      empty.className = 'editor-sound-option-empty'
      empty.textContent = 'No sounds match.'
      this.els.soundOptions.appendChild(empty)
      return
    }

    options.forEach((entry, index) => {
      const li = document.createElement('li')
      li.className = 'editor-sound-option' + (index === this.pickerHighlightIndex ? ' editor-sound-option-highlighted' : '')
      // A yellow dot marks sounds that are in the Mixer's mix right now.
      // Every row gets the slot so the names line up.
      const dot = document.createElement('span')
      dot.className = 'editor-sound-option-dot' + (entry.included ? '' : ' editor-sound-option-dot-off')
      li.appendChild(dot)
      li.title = entry.included ? `${entry.name} (in the mix)` : entry.name
      li.append(entry.name)
      // mousedown + preventDefault, not click - stops the input from
      // blurring (and therefore closePicker() from firing) before this
      // handler runs, which would otherwise remove the option out from
      // under the click.
      li.addEventListener('mousedown', (evt) => {
        evt.preventDefault()
        this.selectPickerSound(entry.id)
      })
      this.els.soundOptions.appendChild(li)
    })
  }

  // Show a picked/loaded sound's name in the search box left-aligned (so a
  // name too long for the field shows its start, not its tail) with the full
  // name on hover.
  setSearchValue(name) {
    const input = this.els.soundSearch
    input.value = name
    input.title = name
    input.setSelectionRange(0, 0)
    input.scrollLeft = 0
  }

  selectPickerSound(id) {
    const entry = this.editableSounds().find((s) => s.id === id)
    if (!entry) return
    this.setSearchValue(entry.name)
    this.pickerQuery = ''
    this.closePicker()
    this.loadSound(id).catch((err) => console.error('Editor: failed to load sound', err))
  }

  clearPickerSelection() {
    this.els.soundSearch.value = ''
    this.els.soundSearch.title = ''
    this.pickerQuery = ''
    this.closePicker()
    this.showEmpty()
  }

  showEmpty() {
    this.leaveCompareView()
    this.currentEntry = null
    this.disposePreview()
    this.els.panel.classList.add('hidden')
    this.els.empty.classList.remove('hidden')
    clearTimeout(this._historyCommitTimer)
    this.history.reset()
    this.updateUndoRedoButtonsUI()
    this.setBarEnabled(false)
    this.layout?.refreshStudio?.()
  }

  // With nothing open there is nothing to cancel or save (mock: remix-empty).
  // Safe before mountSticky() has made the buttons.
  setBarEnabled(enabled) {
    if (!this.els.cancel) return
    this.els.cancel.disabled = !enabled
    this.els.saveAsCopy.disabled = !enabled
    if (!enabled) {
      this.els.save.disabled = true
      this.setSaveLabel('Save')
    }
  }

  updateLoopTimeInputs(loopStart, loopEnd) {
    this.els.startInput.value = formatDuration(loopStart)
    this.els.endInput.value = formatDuration(loopEnd)
    this.els.lengthInput.value = formatDuration(loopEnd - loopStart)
  }

  // Single choke point for every way the loop region can actually change -
  // LoopEditor.setLoopPoints() (dragging the waveform handles, typing
  // Start/End/Length, "Suggest a loop point", undo/redo) unconditionally
  // calls this via its own onLoopChange callback (registered once, below)
  // right after clamping, so no caller needs to invoke this directly - just
  // call loopEditorController.setLoopPoints() and this runs automatically.
  // BUG FIX (self-review, not reported): before this existed, only the drag
  // path told previewSource about a new region at all - typing an exact
  // Start/End/Length or clicking Suggest updated the displayed numbers and
  // loopEditorController's own state but left the live preview engine
  // silently looping whatever region it was last told about (from load time,
  // or the last drag), so "Saved audio" (which always plays the freshly
  // baked clip) could sound completely different from "Live edit" for a
  // sound whose trim was ever set by typing/suggesting rather than dragging.
  // Separately, none of those paths refreshed the sticky bar's time readout
  // either - it only ever self-corrected once real playback's own rAF tick
  // loop happened to run, so editing loop points while paused left a stale,
  // arbitrarily-wrong span on screen until Play was pressed.
  commitLoopPoints(loopStart, loopEnd) {
    this.updateLoopTimeInputs(loopStart, loopEnd)
    this.previewSource?.setLoopPoints(loopStart, loopEnd)
    this.syncSeamView()
    this.syncSpectralView()
    this.refreshMarkerUi()
    const active = this.activePreview()
    this.updateStickyProgress(active?.currentTime ?? 0)
    this.updateSaveButtonState()
  }

  applyManualLoopPoints() {
    if (!this.loopEditorController) return
    const start = parseDuration(this.els.startInput.value)
    const end = parseDuration(this.els.endInput.value)
    if (start == null || end == null) return
    this.loopEditorController.setLoopPoints(start, end) // triggers commitLoopPoints via onLoopChange
  }

  // Needle field: typing a time (original-file seconds, like Start/End) moves
  // the needle, clamped to the trimmed region. Bad text stays and the field
  // shows aria-invalid; it clears on the next keystroke.
  applyManualNeedle() {
    const input = this.els.needleInput
    const active = this.activePreview()
    const points = this.loopEditorController?.getLoopPoints()
    const t = parseDuration(input.value)
    if (t == null) {
      input.setAttribute('aria-invalid', 'true')
      return
    }
    input.removeAttribute('aria-invalid')
    if (!active || !points) return
    const source = Math.min(Math.max(t, points.loopStart), points.loopEnd)
    if (this.previewMode === 'saved') {
      const clip = this.sourceTimeToClip(source)
      active.scrubTo(clip)
      this.updateStickyProgress(clip)
    } else {
      active.scrubTo(source)
      this.updateStickyProgress(source)
    }
    this.loopEditorController.setPlayhead(source)
    this.spectralView?.setPlayhead(source)
    this.updateSeamPlayhead(source)
    input.value = formatDuration(source)
  }

  // Resizes the region from its current Start (a fixed anchor), rather than
  // e.g. keeping it centered - matches Start/End's own "type an exact
  // value" mental model, just parameterized by length instead of an
  // endpoint. Clamped to the waveform's own duration the same way
  // LoopEditor.setLoopPoints already clamps any external call.
  applyManualLength() {
    if (!this.loopEditorController) return
    const length = parseDuration(this.els.lengthInput.value)
    if (length == null || length <= 0) return
    const { loopStart } = this.loopEditorController.getLoopPoints()
    this.loopEditorController.setLoopPoints(loopStart, loopStart + length) // triggers commitLoopPoints via onLoopChange
  }

  // "Suggest a loop point" - a real ffmpeg-backed analysis pass in the main
  // process (src/main/ffmpeg/loopSuggest.js: energy-envelope seam matching),
  // so this is an async round-trip that can take a second or two on a long
  // file. Analysis-only: it just populates Start/End (same path a manual
  // edit takes, so Save/undo pick it up), never bakes or renders anything.
  async suggestLoopPoint() {
    if (!this.currentEntry || !this.loopEditorController) return
    const id = this.currentEntry.id
    this.els.suggestLoopBtn.disabled = true
    this.els.suggestStatus.textContent = 'Analyzing…'
    let result
    try {
      result = await this.api.audio.suggestLoopPoints(id)
    } catch (err) {
      console.error('Editor: loop-point suggestion failed', err)
      result = { ok: false }
    }
    if (this.currentEntry?.id !== id) return // switched sounds mid-analysis
    this.els.suggestLoopBtn.disabled = false

    if (!result || !result.ok) {
      this.els.suggestStatus.textContent = "Couldn't analyze this file."
      return
    }
    if (result.wholeFile) {
      this.els.suggestStatus.textContent = 'This file is short enough to loop as-is.'
      return
    }

    this.loopEditorController.setLoopPoints(result.loopStart, result.loopEnd) // triggers commitLoopPoints via onLoopChange
    const { loopStart, loopEnd } = this.loopEditorController.getLoopPoints()
    this.els.suggestStatus.textContent = `Suggested ${formatDuration(loopEnd - loopStart)} loop — adjust if needed, then Save.`
  }

  // Shared by Reset filters and every preset button, both of which just set
  // all five slider values from a filters object before re-applying. Presets
  // (see FILTER_PRESETS) don't define .eq at all - the EQ graph is a
  // separate, more precise tool than a one-click coloration preset, so a
  // preset click deliberately leaves it untouched; only an explicit
  // filters.eq (Reset filters' NEUTRAL_FILTERS, or a loaded sound's own
  // saved bands) actually replaces it.
  setFilterSliders(filters) {
    this.filterControls.setValues({
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
      this.eqEditorController.load(filters.eq)
      this.updateEqFieldsFromSelection()
    }
    if (filters.volumeEnvelope) {
      this.loopEditorController.setEnvelope(filters.volumeEnvelope.enabled, filters.volumeEnvelope.points)
      this.els.envelopeEnabled.checked = Boolean(filters.volumeEnvelope.enabled)
    }
    // Effect presets don't define it, so a preset click keeps the boxes.
    if (filters.spectralRepairs) {
      this.spectralView.setRegions(filters.spectralRepairs)
      this.updateSpectralControls()
    }
    this.syncNoiseBand()
  }

  currentFilters() {
    return {
      ...this.filterControls.getValues(),
      eq: this.eqEditorController.getBands(),
      volumeEnvelope: this.loopEditorController.getEnvelope(),
      spectralRepairs: this.spectralView.getRegions()
    }
  }

  // What the *live preview* should actually hear, distinct from
  // currentFilters() (the real, saved-and-savable state) - a soloed band
  // bypasses every other band for the preview only, without touching their
  // real .muted values, since Solo is an audition aid that's never part of
  // what gets persisted or baked. The soloed band itself is force-unmuted so
  // soloing still lets you hear it even if it happens to be muted for real.
  previewFilters() {
    const filters = this.currentFilters()
    const soloIndex = this.eqEditorController.getSoloIndex()
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
  updateEqFieldsFromSelection() {
    const bands = this.eqEditorController.getSlots()
    const index = this.eqEditorController.getSelectedIndex()
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
    const readOnly = this.eqEditorController.isReadOnly()
    const hasSelection = Boolean(band)
    const disabled = readOnly || !hasSelection
    this.els.eqType.disabled = disabled
    this.els.eqFreq.disabled = disabled
    this.els.eqGain.disabled = disabled
    this.els.eqQ.disabled = disabled
    this.els.eqMute.disabled = disabled
    this.els.eqSolo.disabled = disabled
    this.els.eqRemoveBand.disabled = disabled
    this.els.eqAddBand.disabled = readOnly
    if (!hasSelection) {
      this.els.eqType.value = 'peaking'
      this.els.eqFreq.value = ''
      this.els.eqGain.value = ''
      this.els.eqQ.value = ''
      this.els.eqSlope.value = 'gentle'
      this.els.eqSlope.disabled = true
      this.els.eqSlopeLabel.classList.add('hidden')
      this.els.eqMute.classList.remove('editor-eq-mute-active')
      this.els.eqSolo.classList.remove('editor-eq-solo-active')
      return
    }
    this.els.eqType.value = band.type ?? 'peaking'
    this.els.eqFreq.value = String(Math.round(band.freqHz))
    this.els.eqGain.value = String(band.gainDb)
    this.els.eqQ.value = String(band.q)
    // Slope only means anything for the four filter-*shaped* types (a
    // rolloff steepness) - peaking/shelf bands are gain-shaped, not
    // rolloff-shaped, and 'off' does nothing at all, so the control hides
    // entirely rather than showing a value with no real effect.
    const slopeCapable = SLOPE_CAPABLE_EQ_TYPES.includes(band.type)
    this.els.eqSlope.value = band.slope ?? 'gentle'
    this.els.eqSlope.disabled = disabled || !slopeCapable
    this.els.eqSlopeLabel.classList.toggle('hidden', !slopeCapable)
    this.els.eqMute.classList.toggle('editor-eq-mute-active', Boolean(band.muted))
    this.els.eqSolo.classList.toggle('editor-eq-solo-active', this.eqEditorController.getSoloIndex() === index)
  }

  applyEqFieldsToSelectedBand() {
    const type = this.els.eqType.value
    const slope = this.els.eqSlope.value
    const freqHz = Math.min(20000, Math.max(20, Number(this.els.eqFreq.value)))
    const gainDb = Math.min(24, Math.max(-24, Number(this.els.eqGain.value)))
    const q = Math.min(Q_MAX, Math.max(Q_MIN, Number(this.els.eqQ.value)))
    this.eqEditorController.setSelectedBand({ type, slope, freqHz, gainDb, q })
    this.applyEqControls()
  }

  // Fires on every EQ graph change (drag, wheel Q) and every precision-field
  // edit - same live-preview + dirty-state pattern as applyFilterControls,
  // since EQ is just another part of the same filters bag now.
  applyEqControls() {
    this.updateEqFieldsFromSelection()
    this.previewSource?.setFilters(this.previewFilters())
    this.updateSaveButtonState()
    this.updateEqRevertBannerVisibility()
  }

  // True whenever the live EQ bands (A) differ from the immutable saved
  // snapshot (B) - a plain JSON comparison, same technique the dirty-check
  // elsewhere in this file already uses, just scoped to EQ only.
  eqDiffersFromSaved() {
    if (!this.eqEditorController) return false
    return JSON.stringify(this.eqEditorController.getBands()) !== JSON.stringify(this.savedEqSnapshot)
  }

  // The revert prompt only makes sense while actively editing (viewing A)
  // and only when there's actually something to discard - showing an
  // actionable "revert" banner when A already matches B would be confusing.
  updateEqRevertBannerVisibility() {
    const show = this.eqCompareViewing === 'A' && this.eqDiffersFromSaved()
    this.els.eqRevertBanner.classList.toggle('hidden', !show)
  }

  // Switches which side of the compare is being viewed. B is a read-only
  // reference (see EqEditorController.setReadOnly) - switching to it stashes
  // A's live bands so editing can resume exactly where it left off when
  // switching back, rather than losing in-progress work.
  switchEqCompareView(target) {
    if (target === this.eqCompareViewing || !this.eqEditorController) return
    if (target === 'B') {
      this.eqLiveBandsStash = this.eqEditorController.getBands()
      this.eqEditorController.load(this.savedEqSnapshot.map((b) => ({ ...b })))
    } else {
      this.eqEditorController.load((this.eqLiveBandsStash ?? this.eqEditorController.getBands()).map((b) => ({ ...b })))
      this.eqLiveBandsStash = null
    }
    this.eqCompareViewing = target
    this.eqEditorController.setReadOnly(target === 'B')
    this.updateEqFieldsFromSelection()
    this.applyEqControls()
    this.updateEqCompareButtonsUI()
  }

  updateEqCompareButtonsUI() {
    this.els.eqCompareA.classList.toggle('editor-eq-compare-btn-active', this.eqCompareViewing === 'A')
    this.els.eqCompareB.classList.toggle('editor-eq-compare-btn-active', this.eqCompareViewing === 'B')
  }

  // The revert banner's action: discards every unsaved EQ edit, replacing
  // the live (A) bands with an exact copy of the saved (B) snapshot -
  // switches back to viewing A first if B was on screen, since after this
  // there's nothing left to distinguish them anyway.
  revertEqToSaved() {
    if (!this.eqEditorController) return
    this.eqLiveBandsStash = null
    this.eqCompareViewing = 'A'
    this.eqEditorController.setReadOnly(false)
    this.eqEditorController.load(this.savedEqSnapshot.map((b) => ({ ...b })))
    this.updateEqFieldsFromSelection()
    this.applyEqControls()
    this.updateEqCompareButtonsUI()
  }

  // Resets compare state for a freshly loaded sound - A/B is a per-editing-
  // session workflow aid, not something that should carry over between
  // sounds. savedEqSnapshot itself is captured separately in loadSound()
  // (needs the just-loaded entry's own filters.eq, not available here).
  resetEqCompare() {
    this.eqCompareViewing = 'A'
    this.eqLiveBandsStash = null
    this.eqEditorController?.setReadOnly(false)
    this.updateEqCompareButtonsUI()
    this.updateEqRevertBannerVisibility()
  }

  applyFilterControls() {
    this.previewSource?.setFilters(this.previewFilters())
    this.updateSaveButtonState()
    this.syncNoiseBand()
  }

  currentCrossfadeMs() {
    return Number(this.els.crossfade.value)
  }

  updateCrossfadeLabel(ms) {
    this.els.crossfadeValue.textContent = ms > 0 ? `${ms} ms` : 'Off'
  }

  applyCrossfadeControl() {
    const ms = this.currentCrossfadeMs()
    this.updateCrossfadeLabel(ms)
    this.previewSource?.setCrossfadeSeconds(ms / 1000)
    this.syncSeamView()
    this.updateSaveButtonState()
  }

  // --- Loop layout (v0.1.222) ---
  // A baked loop clip is the second half of the trim, the crossfade, then
  // the first half (loopLayout.js mirrors loopClip.js). liveLayout() is what
  // the current, possibly unsaved, settings would bake - the Loop seam strip
  // draws it. savedLayout() is the clip actually on disk, from the loopClip*
  // fields recorded at bake time (the stored crossfade is already the
  // effective one, 0 under Doppler).
  liveLayout() {
    const { loopStart, loopEnd } = this.loopEditorController.getLoopPoints()
    const doppler = this.currentSpeedPitchDoppler()
    return loopLayout(loopStart, loopEnd, doppler ? 0 : this.currentCrossfadeMs() / 1000)
  }

  currentSpeedPitchDoppler() {
    return Boolean(this.els.doppler?.checked)
  }

  savedLayout() {
    const entry = this.currentEntry
    const live = this.loopEditorController.getLoopPoints()
    const start = entry?.loopClipStart ?? live.loopStart
    const end = entry?.loopClipEnd ?? live.loopEnd
    const fade = entry?.loopClipCrossfadeSeconds ?? DEFAULT_CROSSFADE_MS / 1000
    return loopLayout(start, end, fade)
  }

  clipTimeToSource(clipTime) {
    return clipToSource(this.savedLayout(), clipTime)
  }

  sourceTimeToClip(t) {
    return sourceToClip(this.savedLayout(), t)
  }

  // Pushes the current trim/crossfade/mode into the Loop seam strip.
  // --- Spectral repair ---
  // The panel shows the trim only (that's all a bake reads). The spectrogram
  // is refetched for a new trim once the drag settles.
  syncSpectralView() {
    if (!this.spectralView || !this.loopEditorController) return
    const id = this.currentEntry?.id
    if (!id || typeof this.api.audio.getSpectrogram !== 'function') return
    const { loopStart, loopEnd } = this.loopEditorController.getLoopPoints()
    if (!(loopEnd > loopStart)) return
    // Hidden tab: asking now would fetch a 16 x 16 image stretched blurry over the canvas.
    if (!this.spectralView.isShown()) return
    const want = this.spectralView.requestSize()
    const trimKey = `${id}:${loopStart}:${loopEnd}`
    // Size buckets of 100 px: a small resize keeps the image, a big one (a bigger window) refetches it sharper.
    const key = `${trimKey}:${Math.round(want.columns / 100)}x${Math.round(want.rows / 100)}`
    if (key === this._spectrogramKey) return
    const sameTrim = this._spectrogramKey?.startsWith(`${trimKey}:`)
    this._spectrogramKey = key
    this.spectralView.setView(loopStart, loopEnd)
    if (!sameTrim) this.spectralView.setSpectrogram(null, 'Reading the sound…')
    clearTimeout(this._spectrogramTimer)
    this._spectrogramTimer = setTimeout(async () => {
      let spec = null
      try {
        spec = await this.api.audio.getSpectrogram(id, { windowStart: loopStart, windowEnd: loopEnd, ...want })
      } catch (err) {
        console.error('Editor: spectrogram fetch failed', err)
      }
      if (key !== this._spectrogramKey) return
      this.spectralView.setSpectrogram(spec, spec ? '' : "Couldn't read this sound")
    }, 250)
  }

  // Picks what a drag on the spectrogram does: 'select', 'box', 'lasso',
  // 'brush' or 'noise' (the Noise sample band). The view tells back through
  // onToolChange (also for the V R L B N keys), which syncs the buttons.
  setSpectralTool(tool) {
    this.spectralView.setShape(tool)
    this.syncSpectralTool()
  }

  // Keeps the tool buttons, the hint line and "Mark noise sample" in step with the tool.
  syncSpectralTool() {
    const now = this.spectralView.getShape()
    for (const b of this.els.spectralShape.querySelectorAll('[data-shape]')) b.setAttribute('aria-pressed', String(b.dataset.shape === now))
    this.els.spectralHint.innerHTML = toolHint(now, this.spectralView.getBrushRadius())
    this.filterControls?.setMarkOn(now === 'noise')
  }

  // Draws the From/To fields as a band on the spectrogram and words the legend.
  syncNoiseBand() {
    if (!this.spectralView || !this.filterControls) return
    const v = this.filterControls.getValues()
    this.spectralView.setNoiseSample(v.denoiseSampleStartSec, v.denoiseSampleEndSec)
    const band = this.spectralView.getNoiseSample()
    // The same band on the Trim waveform (drag it there to re-sample), unless
    // the Noise reduction card's "Show on waveform" is off.
    const sample = this.filterControls.getShowSample() && v.denoiseSampleEndSec > v.denoiseSampleStartSec ? { startSec: v.denoiseSampleStartSec, endSec: v.denoiseSampleEndSec } : null
    this.loopEditorController.setNoiseSample(sample)
    this.els.spectralLegendNoise.classList.toggle('hidden', !band)
    if (band) {
      const length = band.endSec - band.startSec
      const state = !v.denoiseEnabled ? 'Noise reduction is off' : length < GOOD_NOISE_SEC ? 'short: 0.5 s or more works best' : 'learned'
      this.els.spectralLegendNoiseText.textContent = `Noise sample ${band.startSec.toFixed(1)}–${band.endSec.toFixed(1)} s (${state})`
    }
  }

  // "Use shape N as noise sample": the shape's whole time range, every
  // frequency in it (owner, 2026-11-21, option A).
  useShapeAsNoiseSample() {
    const band = noiseBandFromShape(this.spectralView.getSelected())
    if (!band) return
    this.filterControls.setValues({ denoiseSampleStartSec: band.startSec, denoiseSampleEndSec: band.endSec, denoiseEnabled: true })
    this.applyFilterControls()
  }

  updateSpectralControls() {
    const box = this.spectralView.getSelected()
    this.els.spectralDelete.disabled = !box
    this.els.spectralReduction.disabled = !box
    this.els.spectralClear.disabled = this.spectralView.getRegions().length === 0
    const index = this.spectralView.getSelectedIndex()
    const useNoise = this.els.spectralUseNoise
    useNoise.disabled = !noiseBandFromShape(box)
    useNoise.querySelector('span').textContent = box ? `Use shape ${index + 1} as noise sample` : 'Use shape as noise sample'
    if (!box) {
      const count = this.spectralView.getRegions().length
      this.els.spectralSelection.textContent = count ? `${count} box${count === 1 ? '' : 'es'}. Click one to change it.` : 'No box selected'
      return
    }
    this.els.spectralSelection.textContent = `${box.startSec.toFixed(2)}–${box.endSec.toFixed(2)} s · ${formatHz(box.lowHz)}–${formatHz(box.highHz)}`
    this.els.spectralReduction.value = String(box.reductionDb)
    this.els.spectralReductionValue.textContent = `${box.reductionDb} dB`
  }

  syncSeamView({ immediate = false } = {}) {
    if (!this.seamView || !this.loopEditorController) return
    const { loopStart, loopEnd } = this.loopEditorController.getLoopPoints()
    this.seamView.setLoop(loopStart, loopEnd)
    this.seamView.setCrossfade(this.currentCrossfadeMs() / 1000)
    this.seamView.setEnabled(!this.currentSpeedPitchDoppler())
    this.scheduleSeamPeaks({ immediate })
  }

  // The strip needs peaks for just the trim. Base (whole-file) peaks show
  // immediately; a finer fetch for the trim replaces them once settled.
  // The fetch sizes itself to the canvas, so it only runs while the Loop seam
  // view is shown: loading a sound commits loop points while the Trim view is
  // up, and a fetch then got a 0 px canvas (2 peaks for the whole trim) that
  // the key kept on screen until the trim changed (2026-11-12). Opening the
  // view fetches at once; the 300 ms wait is only for trim and fade edits.
  scheduleSeamPeaks({ immediate = false } = {}) {
    clearTimeout(this._seamPeaksTimer)
    const id = this.currentEntry?.id
    if (!id || !this.seamView) return
    const { loopStart, loopEnd } = this.loopEditorController.getLoopPoints()
    const base = this.waveformPeaksCache.get(id)
    const width = Math.round(this.els.seamCanvas.getBoundingClientRect().width)
    const key = `${id}:${loopStart}:${loopEnd}:${Boolean(base)}:${width}`
    if (key === this._seamPeaksKey) return
    const duration = this.currentEntry?.durationSeconds
    const trimKey = `${id}:${loopStart}:${loopEnd}`
    if (base && duration && this._seamFineFor !== trimKey) this.seamView.setPeaks(base, 0, duration)
    if (width < 2) {
      this._seamPeaksKey = null
      return
    }
    this._seamPeaksKey = key
    this._seamPeaksTimer = setTimeout(async () => {
      try {
        const peaks = await this.api.audio.getWaveformPeaks(id, width * 2, loopStart, loopEnd)
        const current = this.loopEditorController.getLoopPoints()
        if (!peaks || this.currentEntry?.id !== id || current.loopStart !== loopStart || current.loopEnd !== loopEnd) return
        this.seamView.setPeaks(peaks, loopStart, loopEnd)
        this._seamFineFor = trimKey
      } catch (err) {
        console.error('Editor: seam strip peaks fetch failed', err)
      }
    }, immediate ? 0 : 300)
  }

  // Finer peaks for exactly what the "Loop seam" strip's current zoom
  // shows (v0.1.231) - the same idea as maybeFetchDetailPeaks for the main
  // trim waveform, keyed off the source-time ranges SeamView's own
  // onViewportChange already resolved: two when the view straddles the
  // crossfade (the trim's end and its start), fetched separately so each is
  // really finer (see that file's computeSourceRanges).
  scheduleSeamDetailPeaks(sourceRanges) {
    clearTimeout(this._seamDetailPeaksTimer)
    const id = this.currentEntry?.id
    const ranges = (sourceRanges || []).filter(([start, end]) => end > start)
    if (!id || !this.seamView || ranges.length === 0) return
    const request = (this._seamDetailRequest = (this._seamDetailRequest || 0) + 1)
    this._seamDetailPeaksTimer = setTimeout(async () => {
      const width = Math.max(1, Math.round(this.els.seamCanvas.getBoundingClientRect().width))
      try {
        const segments = await Promise.all(ranges.map(async ([start, end]) => ({ peaks: await this.api.audio.getWaveformPeaks(id, width, start, end), start, end })))
        if (request !== this._seamDetailRequest || this.currentEntry?.id !== id) return
        this.seamView.setDetailPeaks(segments)
      } catch (err) {
        console.error('Editor: seam detail peaks fetch failed', err)
      }
    }, 250)
  }

  // The strip's playhead, in liveLayout() clip time.
  updateSeamPlayhead(sourceTime) {
    if (!this.seamView) return
    this.seamView.setPlayhead(sourceTime == null ? null : sourceToClip(this.liveLayout(), sourceTime))
  }

  // --- Listen to the seam (v0.1.221) ---
  // Plays SEAM_LEAD_SECONDS before the crossfade, through it, then
  // SEAM_TAIL_SECONDS more, and stops - in whichever preview mode is active.
  // The live preview crossfades at the trim's end, so looping is forced on
  // while it runs.
  async toggleSeamListen() {
    if (this._seamTimer) {
      this.stopSeamListen()
      return
    }
    const active = this.activePreview()
    if (!active || !this.loopEditorController) return
    let startAt
    let secondsToSeamEnd
    if (this.previewMode === 'saved' && this.bakedPreview) {
      // The baked seam is the crossfade in the middle of the clip; with no
      // crossfade (a plain trim) it's the clip's own restart.
      await this.bakedPreview.waitForMetadata()
      const layout = this.savedLayout()
      const clipDuration = this.bakedPreview.duration
      const seamEnd = layout.fade > 0 ? Math.min(layout.blendEnd, clipDuration) : clipDuration
      startAt = Math.max(0, seamEnd - layout.fade - SEAM_LEAD_SECONDS)
      secondsToSeamEnd = seamEnd - startAt
    } else {
      const { loopStart, loopEnd } = this.loopEditorController.getLoopPoints()
      const fade = this.liveLayout().fade
      startAt = Math.max(loopStart, loopEnd - fade - SEAM_LEAD_SECONDS)
      // The live preview plays the source at its Speed/Pitch rate.
      secondsToSeamEnd = (loopEnd - startAt) / (active.audioEl.playbackRate || 1)
      this._seamRestoreLooping = !this.looping
      if (!this.looping) this.previewSource.setLooping(true)
    }
    if (active.playing) active.pause()
    active.scrubTo(startAt)
    this._seamTimer = setTimeout(() => this.stopSeamListen(), (secondsToSeamEnd + SEAM_TAIL_SECONDS) * 1000)
    this.els.seamListen.querySelector('span').textContent = 'Stop'
    this.els.seamStatus.textContent = 'Playing through the loop point…'
    await this.engine.resume()
    await active.play()
    this.setPlayPauseIcon(true)
    this.tickPreviewPlayhead()
  }

  // Ends a seam preview: pauses what it started and restores the loop
  // toggle. Also called when the user takes over (Play/Pause, a mode switch,
  // loading another sound) with pause: false, so a pending timer never
  // pauses their own playback later.
  stopSeamListen({ pause = true } = {}) {
    if (!this._seamTimer) return
    clearTimeout(this._seamTimer)
    this._seamTimer = null
    if (this._seamRestoreLooping) this.previewSource?.setLooping(this.looping)
    this._seamRestoreLooping = false
    this.els.seamListen.querySelector('span').textContent = 'Listen to the seam'
    this.els.seamStatus.textContent = ''
    if (pause && this.activePreview()?.playing) {
      this.activePreview().pause()
      this.stopPreviewTicking()
      this.setPlayPauseIcon(false)
      this.eqEditorController.clearSpectrum()
    }
  }

  // --- Fluctuation (v0.1.164; flat-seconds timing + Fully-random v0.1.176) ---
  // Pushes entry.fluctuation into the two bars + the seconds fields, called
  // from loadSound. The bars own their own min/bias/max; the number fields +
  // checkboxes own enabled / fullyRandom / changeMin/MaxSeconds /
  // transitionSeconds.
  setFluctuationControls(fluctuation) {
    const f = loadedFluctuation(fluctuation)
    this.fluctuation = f
    this.writeFluctuationAxisFields('flucVol', f.volume)
    this.flucVolBar.setValues(f.volume)
    this.writeFluctuationAxisFields('flucPitch', f.pitch)
    this.flucPitchBar.setValues(f.pitch)
    this.writeFluctuationAxisFields('flucPan', f.pan)
    this.flucPanBar.setValues(f.pan)
    this.updateFluctuationEnabledUI()
    // Freshly loaded from the library == the saved baseline for the dirty-check.
    this.savedFluctuationSnapshot = this.fluctuationSnapshot()
  }

  writeFluctuationAxisFields(key, axis) {
    this.els[`${key}Enabled`].checked = axis.enabled
    this.els[`${key}FullRandom`].checked = axis.fullyRandom
    this.els[`${key}ChangeMin`].value = String(axis.changeMinSeconds)
    this.els[`${key}ChangeMax`].value = String(axis.changeMaxSeconds)
    this.els[`${key}Transition`].value = String(axis.transitionSeconds)
    this.els[`${key}Bias`].checked = axis.biasEnabled !== false
  }

  updateFluctuationEnabledUI() {
    for (const [key, bar] of [
      ['flucVol', this.flucVolBar],
      ['flucPitch', this.flucPitchBar],
      ['flucPan', this.flucPanBar]
    ]) {
      const on = this.els[`${key}Enabled`].checked
      const random = this.els[`${key}FullRandom`].checked
      bar.setEnabled(on && !random)
      bar.setBiasEnabled(this.els[`${key}Bias`].checked)
      this.els[`${key}Bias`].disabled = !on || random
      this.els[`${key}FullRandom`].disabled = !on
      this.els[`${key}ChangeMin`].disabled = !on
      this.els[`${key}ChangeMax`].disabled = !on
      this.els[`${key}Transition`].disabled = !on
    }
    // Drift is a live-preview / Mixer behavior only - warn if the user has an
    // axis on but is auditioning the baked "Saved audio" clip, which by
    // design has no fluctuation (so it'd look like the feature does nothing).
    const anyOn = this.els.flucVolEnabled.checked || this.els.flucPitchEnabled.checked || this.els.flucPanEnabled.checked
    this.els.fluctuationSavedNote?.classList.toggle('hidden', !(anyOn && this.previewMode === 'saved'))
    this.updateGroupOverrideNotes()
  }

  // v0.1.218: tells the user when this sound's Sound Group replaces some of
  // its drift / per-play settings in the Mixer and exports (the Remix preview
  // plays the sound on its own, so it still uses this sound's own settings).
  groupDriftForCurrentSound() {
    return groupDriftFor(this.currentEntry?.id, this.presets, this.editingPresetId)
  }

  updateGroupOverrideNotes() {
    const { fluc, shot } = groupOverrideNotes(this.groupDriftForCurrentSound())
    this.els.flucGroupNote.textContent = fluc
    this.els.flucGroupNote.classList.toggle('hidden', !fluc)
    for (const el of [this.els.scatterGroupNote, this.els.scheduleGroupNote]) {
      el.textContent = shot
      el.classList.toggle('hidden', !shot)
    }
  }

  readFluctuationAxisFields(key, bar) {
    const v = bar.getValues()
    return {
      enabled: this.els[`${key}Enabled`].checked,
      fullyRandom: this.els[`${key}FullRandom`].checked,
      biasEnabled: this.els[`${key}Bias`].checked,
      min: v.min,
      max: v.max,
      bias: v.bias,
      changeMinSeconds: flucSeconds(this.els[`${key}ChangeMin`].value, 6),
      changeMaxSeconds: flucSeconds(this.els[`${key}ChangeMax`].value, 14),
      transitionSeconds: flucSeconds(this.els[`${key}Transition`].value, 8, true)
    }
  }

  // Reads every fluctuation control into this.fluctuation, previews it live,
  // and (debounced) persists + tells the Mixer. No snapshot/undo hookup by
  // design - see the wireControls comment.
  applyFluctuationControls() {
    this.fluctuation = {
      volume: this.readFluctuationAxisFields('flucVol', this.flucVolBar),
      pitch: this.readFluctuationAxisFields('flucPitch', this.flucPitchBar),
      pan: this.readFluctuationAxisFields('flucPan', this.flucPanBar)
    }
    this.updateFluctuationEnabledUI()
    this.previewSource?.setFluctuation(this.fluctuation)
    this.persistFluctuation()
    // Light the Save button now (it clears again a moment later when the
    // debounced write below lands - see flushFluctuation) so a drift edit
    // never looks like it went nowhere.
    this.updateSaveButtonState()
  }

  persistFluctuation() {
    if (!this.currentEntry) return
    this._pendingFluctuation = { id: this.currentEntry.id, fluctuation: this.fluctuation }
    clearTimeout(this._fluctuationSaveTimer)
    this._fluctuationSaveTimer = setTimeout(() => this.flushFluctuation(), 400)
  }

  // Writes any pending fluctuation edit now (keyed by the captured id, so
  // it's safe regardless of what's currently open) and tells the Mixer.
  // Called on the debounce timer, and synchronously from loadSound before a
  // sound switch so a fast switch can't drop the edit.
  flushFluctuation() {
    clearTimeout(this._fluctuationSaveTimer)
    const pending = this._pendingFluctuation
    if (!pending) return
    this._pendingFluctuation = null
    const { id, fluctuation } = pending
    this.api.library
      .updateFluctuation(id, fluctuation)
      .then(() => {
        if (this.currentEntry?.id === id) this.currentEntry.fluctuation = fluctuation
        window.dispatchEvent(
          new CustomEvent('noctivago:sound-fluctuation-changed', { detail: { soundId: id, fluctuation } })
        )
        // Confirm the write so the Save button and status line stop implying
        // the drift edit is unsaved (fluctuation persists on its own, no
        // manual Save needed - but a silent write reads as "nothing happened").
        if (this.currentEntry?.id === id) {
          this.savedFluctuationSnapshot = fluctuationFingerprint(fluctuation)
          this.updateSaveButtonState()
          this.els.saveStatus.textContent = 'Fluctuation applied — saved automatically (no bake needed).'
        }
      })
      .catch((err) => {
        console.error('Editor: fluctuation save failed', err)
        if (this.currentEntry?.id === id) this.els.saveStatus.textContent = 'Fluctuation change could not be saved.'
      })
  }

  currentPlayMode() {
    if (this.els.playModeScatter.checked) return 'scatter'
    if (this.els.playModeScheduled.checked) return 'scheduled'
    return 'loop'
  }

  setPlayModeControls(playMode) {
    this.els.playModeLoop.checked = playMode !== 'scatter' && playMode !== 'scheduled'
    this.els.playModeScatter.checked = playMode === 'scatter'
    this.els.playModeScheduled.checked = playMode === 'scheduled'
    this.els.crossfadeSection.classList.toggle('hidden', playMode === 'scatter' || playMode === 'scheduled')
    this.layout?.setPlayMode(playMode)
    this.els.scatterSection.classList.toggle('hidden', playMode !== 'scatter')
    this.els.scheduleSection.classList.toggle('hidden', playMode !== 'scheduled')
    // Fade and Sync group (owner UI feedback, 2026-09-17): moved up near the
    // waveform/sound name so they sit close to what they actually affect -
    // see editor-fade-section's own comment above the markup. Visibility
    // still follows the exact same playMode rules the sections above do.
    this.els.fadeSection.classList.toggle('hidden', playMode !== 'scatter' && playMode !== 'scheduled')
    this.els.scatterFadeFields.classList.toggle('hidden', playMode !== 'scatter')
    this.els.scheduleFadeFields.classList.toggle('hidden', playMode !== 'scheduled')
    this.els.syncGroupRow.classList.toggle('hidden', playMode !== 'scatter')
    // Fluctuation is continuous drift on a held loop - it has no meaning for
    // Random Interval / Scheduled one-shots (which have their own per-shot
    // pitch/volume randomization), and the Source classes for those modes
    // don't wire it up. Hide it rather than show an inert control.
    const flucHidden = playMode === 'scatter' || playMode === 'scheduled'
    this.layout?.setDriftHidden?.(flucHidden)
    if (!flucHidden) {
      // Canvases measure 0 while their section is display:none - redraw once
      // it's back on screen so the bars aren't stuck at a stale size.
      this.flucVolBar?.redraw()
      this.flucPitchBar?.redraw()
      this.flucPanBar?.redraw()
    }
    this.redrawShotBars()
  }

  redrawShotBars() {
    for (const bars of Object.values(this.shotBars ?? {})) for (const bar of Object.values(bars)) bar.redraw()
  }

  // Reads one kind's per-play random bars into config fields.
  readShotAxes(kind) {
    const out = {}
    for (const axis of SHOT_AXIS_NAMES) {
      const { fields, round } = SHOT_AXES[axis]
      const key = `${kind}${axis[0].toUpperCase()}${axis.slice(1)}`
      const v = this.shotBars[kind][axis].getValues()
      const r = (n) => Math.round(n * round) / round
      out[fields[0]] = r(v.min)
      out[fields[1]] = r(v.max)
      out[fields[2]] = r(v.bias)
      out[fields[3]] = this.els[`${key}BiasEnabled`].checked
      out[fields[4]] = this.els[`${key}FullyRandom`].checked
    }
    return out
  }

  writeShotAxes(kind, config) {
    for (const axis of SHOT_AXIS_NAMES) {
      const { fields, defaults } = SHOT_AXES[axis]
      const key = `${kind}${axis[0].toUpperCase()}${axis.slice(1)}`
      const min = config?.[fields[0]] ?? defaults.min
      const max = config?.[fields[1]] ?? defaults.max
      this.shotBars[kind][axis].setValues({ min, max, bias: config?.[fields[2]] ?? (min + max) / 2 })
      this.els[`${key}BiasEnabled`].checked = Boolean(config?.[fields[3]])
      this.els[`${key}FullyRandom`].checked = Boolean(config?.[fields[4]])
    }
    this.updateShotAxesUI(kind)
  }

  updateShotAxesUI(kind) {
    for (const axis of SHOT_AXIS_NAMES) {
      const key = `${kind}${axis[0].toUpperCase()}${axis.slice(1)}`
      const random = this.els[`${key}FullyRandom`].checked
      this.shotBars[kind][axis].setEnabled(!random)
      this.shotBars[kind][axis].setBiasEnabled(this.els[`${key}BiasEnabled`].checked)
      this.els[`${key}BiasEnabled`].disabled = random
    }
  }

  currentScatterConfig() {
    return {
      minGapSeconds: Number(this.els.scatterGapMin.value),
      maxGapSeconds: Number(this.els.scatterGapMax.value),
      gapFullyRandom: this.els.scatterGapFullyRandom.checked,
      gapBiasEnabled: this.els.scatterGapBiasEnabled.checked,
      gapBiasSeconds: Number(this.els.scatterGapBias.value),
      ...this.readShotAxes('scatter'),
      fadeInMs: Number(this.els.scatterFadeIn.value),
      fadeOutMs: Number(this.els.scatterFadeOut.value),
      syncGroup: this.els.scatterSyncGroup.value.trim()
    }
  }

  setScatterControls(scatter) {
    const {
      minGapSeconds = 5,
      maxGapSeconds = 35,
      gapFullyRandom = false,
      gapBiasEnabled = false,
      gapBiasSeconds = 20,
      fadeInMs = 0,
      fadeOutMs = 0,
      syncGroup = ''
    } = scatter ?? {}
    this.els.scatterGapMin.value = String(minGapSeconds)
    this.els.scatterGapMax.value = String(maxGapSeconds)
    this.els.scatterGapFullyRandom.checked = Boolean(gapFullyRandom)
    this.els.scatterGapBiasEnabled.checked = Boolean(gapBiasEnabled)
    this.els.scatterGapBias.value = String(gapBiasSeconds)
    this.writeShotAxes('scatter', scatter)
    this.els.scatterFadeIn.value = String(fadeInMs)
    this.els.scatterFadeOut.value = String(fadeOutMs)
    this.syncFadeToggle(this.els.scatterFadeEnabled, this.els.scatterFadeIn, this.els.scatterFadeOut)
    this.els.scatterSyncGroup.value = syncGroup
    this.updateScatterRangeDisabled()
  }

  applyPlayModeControl() {
    const playMode = this.currentPlayMode()
    this.els.crossfadeSection.classList.toggle('hidden', playMode === 'scatter' || playMode === 'scheduled')
    this.layout?.setPlayMode(playMode)
    this.els.scatterSection.classList.toggle('hidden', playMode !== 'scatter')
    this.els.scheduleSection.classList.toggle('hidden', playMode !== 'scheduled')
    this.els.fadeSection.classList.toggle('hidden', playMode !== 'scatter' && playMode !== 'scheduled')
    this.els.scatterFadeFields.classList.toggle('hidden', playMode !== 'scatter')
    this.els.scheduleFadeFields.classList.toggle('hidden', playMode !== 'scheduled')
    this.els.syncGroupRow.classList.toggle('hidden', playMode !== 'scatter')
    // BUG FIX (found while verifying the layout changes above, not reported):
    // this function - the one that reacts to the Playback mode radios while
    // a sound is already open, as opposed to setPlayModeControls() which only
    // runs on a fresh load() - never toggled the Fluctuation section itself,
    // just the bars/canvases inside it once shown. Switching from Scatter
    // back to Loop without reloading the sound left Fluctuation permanently
    // hidden (or the reverse: stuck visible after switching away from Loop),
    // since only a fresh load ever ran the real check. Same Loop-mode-only
    // scoping setPlayModeControls already documents.
    const flucHidden = playMode === 'scatter' || playMode === 'scheduled'
    this.layout?.setDriftHidden?.(flucHidden)
    if (!flucHidden) {
      this.flucVolBar?.redraw()
      this.flucPitchBar?.redraw()
      this.flucPanBar?.redraw()
    }
    // Volume envelope is Loop-mode-only (v1) - scatter/scheduled shots have
    // their own per-shot randomization instead, same reasoning Fluctuation's
    // own Loop-mode-first scoping used. This only gates drawing/hit-testing
    // on the canvas, not the underlying data - switching back to Loop mode
    // shows whatever was already drawn.
    this.loopEditorController?.setEnvelopeUiVisible(playMode === 'loop')
    this.redrawShotBars()
    this.updateFadeVisual()
    this.updateSaveButtonState()
  }

  // Pushes the current playMode's fadeInMs/fadeOutMs into the waveform's
  // draggable fade handles (see LoopEditor.js/waveform.js) - only scatter/
  // scheduled shots have a per-shot fade to show, since the trimmed region is
  // exactly the one-shot clip that fade applies to (a continuously-looping
  // sound has no such thing). Called both ways: after a playMode switch or a
  // numeric fade-field edit (pushes field -> visual), and the reverse is
  // wired separately via loopEditorController.onFadesChange (drag -> field).
  updateFadeVisual() {
    const playMode = this.currentPlayMode()
    const enabled = playMode === 'scatter' || playMode === 'scheduled'
    this.loopEditorController?.setFadesEnabled(enabled)
    if (!enabled) return
    const { fadeInMs, fadeOutMs } = playMode === 'scatter' ? this.currentScatterConfig() : this.currentScheduleConfig()
    this.loopEditorController?.setFades(fadeInMs / 1000, fadeOutMs / 1000)
  }

  // Fade shot edges (owner UI feedback, 2026-09-17): an explicit on/off
  // switch, instead of leaving "0 = off" as the only way to turn it off. The
  // two ms fields stay the real source of truth (dragging the waveform's
  // fade pins - see onFadesChange above - writes straight into them, same as
  // before); this just keeps a friendlier checkbox in sync with them from
  // every direction a value can change (typing, the checkbox itself, or a
  // pin drag).
  syncFadeToggle(enabledEl, inInput, outInput) {
    const on = Number(inInput.value) > 0 || Number(outInput.value) > 0
    enabledEl.checked = on
    inInput.disabled = !on
    outInput.disabled = !on
  }

  toggleFade(enabledEl, inInput, outInput, apply) {
    if (enabledEl.checked) {
      if (Number(inInput.value) <= 0 && Number(outInput.value) <= 0) {
        inInput.value = '150'
        outInput.value = '150'
      }
    } else {
      inInput.value = '0'
      outInput.value = '0'
    }
    inInput.disabled = !enabledEl.checked
    outInput.disabled = !enabledEl.checked
    apply()
  }

  applyScatterControls() {
    const scatter = this.currentScatterConfig()
    this.updateScatterRangeDisabled()
    this.updateFadeVisual()
    this.updateSaveButtonState()
  }

  // When a "Fully random" toggle is on, its own min/max (and Bias) inputs no
  // longer do anything - grey them out so that's visible rather than a
  // silent no-op. The Bias number field is further gated on its own "Bias
  // toward a value" checkbox, which is itself moot (and greyed out) whenever
  // Fully random already overrides it.
  updateScatterRangeDisabled() {
    const gapRandom = this.els.scatterGapFullyRandom.checked
    this.els.scatterGapMin.disabled = gapRandom
    this.els.scatterGapMax.disabled = gapRandom
    this.els.scatterGapBiasEnabled.disabled = gapRandom
    this.els.scatterGapBias.disabled = gapRandom || !this.els.scatterGapBiasEnabled.checked
    this.updateShotAxesUI('scatter')
  }

  currentScheduleConfig() {
    const type = this.els.scheduleTypeInterval.checked ? 'interval' : 'times'
    const times = this.els.scheduleTimes.value
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
    return {
      type,
      times,
      intervalMinutes: Number(this.els.scheduleInterval.value),
      ...this.readShotAxes('schedule'),
      fadeInMs: Number(this.els.scheduleFadeIn.value),
      fadeOutMs: Number(this.els.scheduleFadeOut.value)
    }
  }

  setScheduleControls(schedule) {
    const {
      type = 'times',
      times = [],
      intervalMinutes = 60,
      fadeInMs = 0,
      fadeOutMs = 0
    } = schedule ?? {}
    this.els.scheduleTypeTimes.checked = type !== 'interval'
    this.els.scheduleTypeInterval.checked = type === 'interval'
    this.els.scheduleTimes.value = times.join(', ')
    this.els.scheduleInterval.value = String(intervalMinutes)
    this.els.scheduleTimesRow.classList.toggle('hidden', type === 'interval')
    this.els.scheduleIntervalRow.classList.toggle('hidden', type !== 'interval')
    this.writeShotAxes('schedule', schedule)
    this.els.scheduleFadeIn.value = String(fadeInMs)
    this.els.scheduleFadeOut.value = String(fadeOutMs)
    this.syncFadeToggle(this.els.scheduleFadeEnabled, this.els.scheduleFadeIn, this.els.scheduleFadeOut)
  }

  applyScheduleControls() {
    const schedule = this.currentScheduleConfig()
    this.els.scheduleTimesRow.classList.toggle('hidden', schedule.type === 'interval')
    this.els.scheduleIntervalRow.classList.toggle('hidden', schedule.type !== 'interval')
    this.updateShotAxesUI('schedule')
    this.updateFadeVisual()
    this.updateSaveButtonState()
  }

  currentSpeedPitch() {
    return {
      speed: Number(this.els.speed.value) / 100,
      pitchSemitones: Number(this.els.pitch.value),
      reversed: this.els.reverse.checked,
      dopplerEnabled: this.els.doppler.checked,
      // Lives on the LoopEditor controller, not a form control - it's a
      // canvas-drawn drag position, same reasoning as loopStart/loopEnd
      // themselves.
      dopplerClosestFraction: this.loopEditorController?.getDopplerClosestFraction() ?? 0.5,
      dopplerIntensitySemitones: Number(this.els.dopplerIntensity.value),
      dopplerReversed: this.els.dopplerReversed.checked,
      dopplerSharpness: Number(this.els.dopplerSharpness.value) / 100
    }
  }

  setSpeedPitchControls({
    speed = 1,
    pitchSemitones = 0,
    reversed = false,
    dopplerEnabled = false,
    dopplerClosestFraction = 0.5,
    dopplerIntensitySemitones = 5,
    dopplerReversed = false,
    dopplerSharpness = 0.5
  }) {
    this.els.speed.value = String(Math.round(speed * 100))
    this.els.pitch.value = String(pitchSemitones)
    this.els.reverse.checked = Boolean(reversed)
    this.els.doppler.checked = Boolean(dopplerEnabled)
    this.els.dopplerHint.classList.toggle('hidden', !dopplerEnabled)
    this.els.dopplerOptions.classList.toggle('hidden', !dopplerEnabled)
    this.els.dopplerIntensity.value = String(dopplerIntensitySemitones)
    this.els.dopplerIntensityValue.textContent = `${dopplerIntensitySemitones} st`
    this.els.dopplerSharpness.value = String(Math.round((dopplerSharpness ?? 0.5) * 100))
    this.els.dopplerSharpnessValue.textContent = `${Math.round((dopplerSharpness ?? 0.5) * 100)}%`
    this.els.dopplerReversed.checked = Boolean(dopplerReversed)
    this.loopEditorController?.setDopplerClosestFraction(dopplerClosestFraction)
  }

  updateSpeedPitchLabels({ speed = 1, pitchSemitones = 0 }) {
    this.els.speedValue.textContent = `${Math.round(speed * 100)}%`
    this.els.pitchValue.textContent = `${pitchSemitones > 0 ? '+' : ''}${pitchSemitones} st`
  }

  applySpeedPitchControls() {
    const speedPitch = this.currentSpeedPitch()
    this.updateSpeedPitchLabels(speedPitch)
    this.previewSource?.setSpeedPitch(speedPitch)
    this.els.dopplerHint.classList.toggle('hidden', !speedPitch.dopplerEnabled)
    this.els.dopplerOptions.classList.toggle('hidden', !speedPitch.dopplerEnabled)
    this.els.dopplerIntensityValue.textContent = `${speedPitch.dopplerIntensitySemitones} st`
    this.els.dopplerSharpnessValue.textContent = `${Math.round((speedPitch.dopplerSharpness ?? 0.5) * 100)}%`
    this.loopEditorController?.setDopplerEnabled(speedPitch.dopplerEnabled)
    this.syncSeamView()
    this.loopEditorController?.setDopplerReversed(speedPitch.dopplerReversed)
    this.updateSaveButtonState()
  }

  // Live Reverse status under the Reverse toggle (PreviewSource's
  // reverseState). Silent when it simply works.
  showReverseState(state) {
    const messages = {
      pending: 'Preparing the reversed preview…',
      unavailable: 'Reverse is heard live only for sounds up to 10 minutes long. If the loop is under 10 minutes, save and switch the preview to Saved audio to hear it.'
    }
    const message = messages[state] ?? ''
    this.els.reverseStatus.textContent = message
    this.els.reverseStatus.classList.toggle('hidden', !message)
  }

  // Builds a comparable snapshot of "what's currently saved" vs. "what's
  // live in the controls" - explicit key order/defaults on both sides
  // (rather than relying on entry.filters' own possibly-partial shape, e.g.
  // older entries saved before echoDelayMs/echoDecay existed) so the two
  // JSON strings only differ when something the user could actually change
  // has changed. crossfadeMs is compared as the rounded integer the slider
  // itself produces, not the seconds value it's persisted as, so float
  // round-tripping (ms -> seconds -> ms) can't cause a false "dirty" flag.
  snapshotOf(loopStart, loopEnd, filters, crossfadeMs, speedPitch, playMode, scatter, schedule) {
    return JSON.stringify({
      loopStart,
      loopEnd,
      filters: {
        highpassHz: filters.highpassHz ?? 0,
        lowpassHz: filters.lowpassHz ?? 20000,
        gainDb: filters.gainDb ?? 0,
        pan: filters.pan ?? 0,
        gateThresholdDb: filters.gateThresholdDb ?? -80,
        gateRangeDb: filters.gateRangeDb ?? 0,
        gateAttackMs: filters.gateAttackMs ?? 10,
        gateReleaseMs: filters.gateReleaseMs ?? 150,
        denoiseEnabled: filters.denoiseEnabled ?? false,
        denoiseStrengthDb: filters.denoiseStrengthDb ?? 12,
        denoiseSampleStartSec: filters.denoiseSampleStartSec ?? 0,
        denoiseSampleEndSec: filters.denoiseSampleEndSec ?? 0,
        echoDelayMs: filters.echoDelayMs ?? 0,
        echoDecay: filters.echoDecay ?? 0,
        reverbSizeMs: filters.reverbSizeMs ?? 0,
        reverbMix: filters.reverbMix ?? 0,
        eq: (filters.eq ?? defaultEqBands()).map((b) => ({
          freqHz: b.freqHz,
          gainDb: b.gainDb,
          q: b.q,
          type: b.type ?? 'peaking',
          slope: b.slope ?? 'gentle',
          muted: b.muted ?? false
        })),
        volumeEnvelope: {
          enabled: Boolean(filters.volumeEnvelope?.enabled),
          points: (filters.volumeEnvelope?.points ?? defaultVolumeEnvelope().points).map((p) => ({
            position: p.position,
            gain: p.gain
          }))
        },
        spectralRepairs: normalizeRegions(filters.spectralRepairs)
      },
      crossfadeMs,
      speedPitch: {
        speed: speedPitch.speed ?? 1,
        pitchSemitones: speedPitch.pitchSemitones ?? 0,
        reversed: speedPitch.reversed ?? false,
        dopplerEnabled: speedPitch.dopplerEnabled ?? false,
        dopplerClosestFraction: speedPitch.dopplerClosestFraction ?? 0.5,
        dopplerIntensitySemitones: speedPitch.dopplerIntensitySemitones ?? 5,
        dopplerReversed: speedPitch.dopplerReversed ?? false,
        dopplerSharpness: speedPitch.dopplerSharpness ?? 0.5
      },
      playMode,
      scatter: {
        minGapSeconds: scatter.minGapSeconds ?? 5,
        maxGapSeconds: scatter.maxGapSeconds ?? 35,
        gapFullyRandom: Boolean(scatter.gapFullyRandom),
        gapBiasEnabled: Boolean(scatter.gapBiasEnabled),
        gapBiasSeconds: scatter.gapBiasSeconds ?? 20,
        minPitchSemitones: scatter.minPitchSemitones ?? 0,
        maxPitchSemitones: scatter.maxPitchSemitones ?? 0,
        pitchFullyRandom: Boolean(scatter.pitchFullyRandom),
        pitchBiasEnabled: Boolean(scatter.pitchBiasEnabled),
        pitchBiasSemitones: shotBiasDefault(scatter.pitchBiasSemitones, scatter.minPitchSemitones ?? 0, scatter.maxPitchSemitones ?? 0, 10),
        minVolume: scatter.minVolume ?? 1,
        maxVolume: scatter.maxVolume ?? 1,
        volumeFullyRandom: Boolean(scatter.volumeFullyRandom),
        volumeBiasEnabled: Boolean(scatter.volumeBiasEnabled),
        volumeBias: shotBiasDefault(scatter.volumeBias, scatter.minVolume ?? 1, scatter.maxVolume ?? 1, 100),
        minPan: scatter.minPan ?? 0,
        maxPan: scatter.maxPan ?? 0,
        panFullyRandom: Boolean(scatter.panFullyRandom),
        panBiasEnabled: Boolean(scatter.panBiasEnabled),
        panBias: shotBiasDefault(scatter.panBias, scatter.minPan ?? 0, scatter.maxPan ?? 0, 100),
        minSpeed: scatter.minSpeed ?? 1,
        maxSpeed: scatter.maxSpeed ?? 1,
        speedFullyRandom: Boolean(scatter.speedFullyRandom),
        speedBiasEnabled: Boolean(scatter.speedBiasEnabled),
        speedBias: shotBiasDefault(scatter.speedBias, scatter.minSpeed ?? 1, scatter.maxSpeed ?? 1, 100),
        fadeInMs: scatter.fadeInMs ?? 0,
        fadeOutMs: scatter.fadeOutMs ?? 0,
        syncGroup: scatter.syncGroup ?? ''
      },
      schedule: {
        type: schedule?.type ?? 'times',
        times: [...(schedule?.times ?? [])],
        intervalMinutes: schedule?.intervalMinutes ?? 60,
        minPitchSemitones: schedule?.minPitchSemitones ?? 0,
        maxPitchSemitones: schedule?.maxPitchSemitones ?? 0,
        pitchFullyRandom: Boolean(schedule?.pitchFullyRandom),
        pitchBiasEnabled: Boolean(schedule?.pitchBiasEnabled),
        pitchBiasSemitones: shotBiasDefault(schedule?.pitchBiasSemitones, schedule?.minPitchSemitones ?? 0, schedule?.maxPitchSemitones ?? 0, 10),
        minVolume: schedule?.minVolume ?? 1,
        maxVolume: schedule?.maxVolume ?? 1,
        volumeFullyRandom: Boolean(schedule?.volumeFullyRandom),
        volumeBiasEnabled: Boolean(schedule?.volumeBiasEnabled),
        volumeBias: shotBiasDefault(schedule?.volumeBias, schedule?.minVolume ?? 1, schedule?.maxVolume ?? 1, 100),
        minPan: schedule?.minPan ?? 0,
        maxPan: schedule?.maxPan ?? 0,
        panFullyRandom: Boolean(schedule?.panFullyRandom),
        panBiasEnabled: Boolean(schedule?.panBiasEnabled),
        panBias: shotBiasDefault(schedule?.panBias, schedule?.minPan ?? 0, schedule?.maxPan ?? 0, 100),
        minSpeed: schedule?.minSpeed ?? 1,
        maxSpeed: schedule?.maxSpeed ?? 1,
        speedFullyRandom: Boolean(schedule?.speedFullyRandom),
        speedBiasEnabled: Boolean(schedule?.speedBiasEnabled),
        speedBias: shotBiasDefault(schedule?.speedBias, schedule?.minSpeed ?? 1, schedule?.maxSpeed ?? 1, 100),
        fadeInMs: schedule?.fadeInMs ?? 0,
        fadeOutMs: schedule?.fadeOutMs ?? 0
      }
    })
  }

  hasUnsavedChanges() {
    if (!this.currentEntry || !this.loopEditorController || !this.savedSnapshot) return false
    const { loopStart, loopEnd } = this.loopEditorController.getLoopPoints()
    return (
      this.snapshotOf(
        loopStart,
        loopEnd,
        this.currentFilters(),
        this.currentCrossfadeMs(),
        this.currentSpeedPitch(),
        this.currentPlayMode(),
        this.currentScatterConfig(),
        this.currentScheduleConfig()
      ) !== this.savedSnapshot
    )
  }

  // Normalized fingerprint of the current Fluctuation config, compared
  // against savedFluctuationSnapshot to know whether the drift settings have
  // unsaved edits. Kept separate from hasUnsavedChanges()/snapshotOf() on
  // purpose: fluctuation is never baked, so a fluctuation-only change must
  // NOT mark the saved loop clip stale or drive undo/A-B - it just needs the
  // Save button to light up and a "saved" confirmation once it's written.
  fluctuationSnapshot() {
    return fluctuationFingerprint(this.fluctuation)
  }

  fluctuationDirty() {
    return isFluctuationDirty(this.fluctuation, this.savedFluctuationSnapshot)
  }

  updateSaveButtonState() {
    this.refreshAccordionSummaries()
    // Last saved on screen: the controls show the saved settings, read-only.
    // Nothing to save, undo or cancel until the view is back on Now.
    const state = saveButtonState({
      compareSaved: this.compare.isSaved,
      eqViewingB: this.eqCompareViewing === 'B',
      // Fluctuation isn't part of hasUnsavedChanges() (it never re-bakes), but
      // a pending drift edit is still something the user expects Save to act on.
      isDirty: () => this.hasUnsavedChanges() || this.fluctuationDirty()
    })
    this.els.save.disabled = state.saveDisabled
    this.setSaveLabel(state.label)
    if (this.els.saveAsCopy) this.els.saveAsCopy.disabled = state.saveAsCopyDisabled
    if (state.view === 'saved') {
      if (this.els.cancel) this.els.cancel.disabled = true
      if (this.els.undo) this.els.undo.disabled = true
      if (this.els.redo) this.els.redo.disabled = true
      return
    }
    // While viewing the read-only B (last saved) reference, currentFilters()
    // reflects B's data rather than A's real live edits (A's own bands are
    // stashed in eqLiveBandsStash, not currently loaded into the graph) - the
    // normal dirty-check would misleadingly compare "B vs. what's actually
    // saved" (always equal) and hide genuinely pending changes in A. Force
    // Save disabled with an explicit label instead of trusting that check
    // while B is on screen.
    if (state.view === 'eqB') {
      this.updatePreviewModeToggle()
      return
    }
    // Drift is folded into the dirty check by the isDirty callback above only,
    // so it never leaks into the stale-clip / undo machinery.
    // Save as copy stays enabled on Now regardless of dirty (saveButtonState).
    this.updatePreviewModeToggle()
    // Every field-change handler in this file ends by calling this method
    // (see applyFilterControls/applyEqControls/applyCrossfadeControl/
    // applySpeedPitchControls/applyPlayModeControl/applyScatterControls/
    // applyScheduleControls, plus the loop-point onLoopChange listener) -
    // the single place every kind of edit already funnels through, so it's
    // also the one hook point undo/redo history and autosave both need,
    // without touching each of those call sites individually. Only reached
    // while viewing A (the early-return above skips this while viewing B,
    // since B's data isn't the user's own editable state and shouldn't be
    // recorded as one, or autosaved as one).
    this.scheduleAutosave()
    this.scheduleHistoryCommit()
  }

  // Autosave (v0.1.142) - see AUTOSAVE_IDLE_MS's own comment for why this is
  // idle-debounced rather than a fixed interval. _restoringHistory guards
  // an Undo/Redo replaying a whole past state back onto the controls (which
  // itself calls updateSaveButtonState() per field, same as a real edit) -
  // that's a jump to an already-known state, not a fresh edit worth
  // autosaving on its own; if it leaves things genuinely dirty relative to
  // what's on disk, the very next real edit reschedules this anyway.
  scheduleAutosave() {
    this.autosave.schedule()
  }

  runAutosave() {
    return this.autosave.run()
  }

  // The exact same normalized shape snapshotOf() already builds for the
  // dirty-check, just returned as a plain object instead of a JSON string so
  // it can actually be restored later, not just compared against.
  captureEditorState() {
    const { loopStart, loopEnd } = this.loopEditorController.getLoopPoints()
    return JSON.parse(
      this.snapshotOf(
        loopStart,
        loopEnd,
        this.currentFilters(),
        this.currentCrossfadeMs(),
        this.currentSpeedPitch(),
        this.currentPlayMode(),
        this.currentScatterConfig(),
        this.currentScheduleConfig()
      )
    )
  }

  scheduleHistoryCommit() {
    if (this._restoringHistory || !this.currentEntry || this.compare.isSaved) return
    clearTimeout(this._historyCommitTimer)
    this._historyCommitTimer = setTimeout(() => this.commitHistoryPoint(), HISTORY_COMMIT_DEBOUNCE_MS)
  }

  commitHistoryPoint() {
    if (!this.currentEntry || !this.loopEditorController) return
    const state = this.captureEditorState()
    // The stack ignores a point equal to the last one (a field focused and
    // blurred with no real edit) and drops the redo branch on a fresh edit.
    if (!this.history.push(state)) return
    this.updateUndoRedoButtonsUI()
  }

  // Pushes a past/future history entry back onto every live control -
  // deliberately reuses the exact same setXControls()+applyXControls() pairs
  // each field's own change handler already calls (setFilterSliders+
  // applyFilterControls, setSpeedPitchControls+applySpeedPitchControls,
  // etc.), rather than re-deriving how to push state into the UI/live
  // preview a second time. _restoringHistory suppresses the history-commit
  // this would otherwise trigger via updateSaveButtonState().
  applyEditorState(state) {
    this._restoringHistory = true
    try {
      this.loopEditorController.setLoopPoints(state.loopStart, state.loopEnd) // triggers commitLoopPoints via onLoopChange

      this.setFilterSliders(state.filters)
      this.applyFilterControls()
      this.updateEqRevertBannerVisibility()

      this.els.crossfade.value = String(state.crossfadeMs)
      this.applyCrossfadeControl()

      this.setSpeedPitchControls(state.speedPitch)
      this.applySpeedPitchControls()

      this.setPlayModeControls(state.playMode)
      this.applyPlayModeControl()

      this.setScatterControls(state.scatter)
      this.applyScatterControls()

      this.setScheduleControls(state.schedule)
      this.applyScheduleControls()
    } finally {
      this._restoringHistory = false
    }
    this.updateUndoRedoButtonsUI()
  }

  // Compare with last saved (the Now / Last saved switch above the canvas).
  // Last saved stashes every current setting, puts the saved ones on the
  // controls (so the preview plays them) and locks editing; Now puts the
  // stash back. Same idea as the EQ's own A/B, for the whole sound. Drift is
  // left alone: it saves on its own, so it is already the saved drift.
  switchCompareView(target) {
    if (!this.currentEntry || !this.loopEditorController || !this.savedSnapshot) return
    const now = this.compare.isSaved ? 'saved' : 'now'
    if (target === now) return
    if (target === 'saved') {
      if (this.eqCompareViewing === 'B') this.switchEqCompareView('A')
      clearTimeout(this._historyCommitTimer)
      this.commitHistoryPoint()
      this.autosave.cancel()
      this.compare.enterSaved(this.captureEditorState())
      this.applyEditorState(JSON.parse(this.savedSnapshot))
      this.eqEditorController?.setReadOnly(true)
    } else {
      const stash = this.compare.stash
      if (stash) this.applyEditorState(stash)
      this.compare.leave()
      this.eqEditorController?.setReadOnly(false)
      this.setBarEnabled(true)
    }
    this.layout?.setCompare(target)
    this.updateSaveButtonState()
    if (target === 'now') this.updateUndoRedoButtonsUI()
  }

  // Back to Now without fuss: before a load, a leave or Cancel, so stashed
  // edits are never lost behind the read-only view.
  leaveCompareView() {
    if (this.compare.isSaved) this.switchCompareView('now')
  }

  // Accordion head values, e.g. "100% · +1 st" or "Off" (amber when on).
  refreshAccordionSummaries() {
    if (!this.layout?.setSummaries || !this.els?.speed) return
    const speed = Number(this.els.speed.value)
    const pitch = Number(this.els.pitch.value)
    const pitchText = pitch === 0 ? '0 st' : `${pitch > 0 ? '+' : ''}${pitch} st`
    const reversed = this.els.reverse.checked
    const speedOn = speed !== 100 || pitch !== 0 || reversed
    const f = this.filterControls ? filterSummaries(this.filterControls.getValues()) : { tone: 'Off', clean: 'Off', noise: 'Off', space: 'Off' }
    const driftOf = (axis) => driftSummary(this.els[`fluc${axis}Enabled`]?.checked, this.els[`fluc${axis}Bar`]?.dataset.range)
    const bands = this.eqEditorController?.getBands?.() ?? []
    const activeBands = bands.filter((b) => (b.type ?? 'peaking') !== 'off' && !b.muted).length
    this.layout.setSummaries({
      envelope: this.els.envelopeEnabled?.checked ? ['On', true] : ['Off', false],
      speed: [`${speed}% · ${pitchText}${reversed ? ' · Reversed' : ''}`, speedOn],
      tone: [f.tone, f.tone !== 'Off'],
      clean: [f.clean, f.clean !== 'Off'],
      noise: [f.noise, f.noise !== 'Off'],
      space: [f.space, f.space !== 'Off'],
      eq: [activeBands ? `${activeBands} band${activeBands === 1 ? '' : 's'}` : 'Off', activeBands > 0],
      'drift-vol': driftOf('Vol'),
      'drift-pitch': driftOf('Pitch'),
      'drift-pan': driftOf('Pan'),
      // One-shot looks: applying one sets the knobs, nothing stays selected.
      looks: ['None', false]
    })
  }

  undo() {
    if (this.compare.isSaved) return
    // A pending debounced commit represents an edit that hasn't been
    // recorded yet - flush it first so Ctrl+Z's first press undoes the most
    // recent *real* change instead of silently discarding it unrecorded.
    clearTimeout(this._historyCommitTimer)
    this.commitHistoryPoint()
    const state = this.history.undo()
    if (state) this.applyEditorState(state)
  }

  redo() {
    if (this.compare.isSaved) return
    const state = this.history.redo()
    if (state) this.applyEditorState(state)
  }

  updateUndoRedoButtonsUI() {
    if (this.els.undo) this.els.undo.disabled = !this.history.canUndo()
    if (this.els.redo) this.els.redo.disabled = !this.history.canRedo()
  }

  // Reloading the current sound from its own saved library data already
  // resets every control back to last-saved (the same path used repeatedly
  // during this feature's own testing to discard edits) - Cancel just wires
  // that existing path to a button instead of requiring a re-pick.
  cancelEdits() {
    if (!this.currentEntry) return
    const hadEdits = this.hasUnsavedChanges() || this.fluctuationDirty()
    this.leaveCompareView()
    this.selectPickerSound(this.currentEntry.id)
    if (hadEdits) this.saveMorph?.canceled('Changes canceled')
  }

  // The Save button's resting words. With the morph states the label is the button's rest markup
  // (rebuilt only when the words change); without them it is the plain label span.
  setSaveLabel(text) {
    if (!this.saveMorph) {
      this.els.saveLabel.textContent = text
      return
    }
    if (text === this._saveLabelText) return
    this._saveLabelText = text
    this.saveMorph.setRest?.(`${icon('save')}<span id="editor-save-label">${text}</span>`)
  }

  // The leave-confirmation prompt (Yes/No/Don't ask again) - TabHost's
  // onBeforeHide hook awaits this before actually switching away from the
  // Remix tab, so returning false here keeps the user on Remix. Nothing to
  // confirm (no unsaved changes, or the user already opted out) resolves
  // true immediately with no dialog shown at all.
  confirmLeaveIfDirty() {
    this.leaveCompareView()
    if (!this.hasUnsavedChanges() || this.skipLeaveConfirm) return true
    return new Promise((resolve) => {
      this._resolveLeaveConfirm = resolve
      this.els.leaveConfirmDialog.classList.remove('hidden')
    })
  }

  resolveLeaveConfirm(allowed) {
    this.els.leaveConfirmDialog.classList.add('hidden')
    this._resolveLeaveConfirm?.(allowed)
    this._resolveLeaveConfirm = null
  }

  wireLeaveConfirmDialog() {
    this.els.leaveConfirmYes.addEventListener('click', () => this.resolveLeaveConfirm(true))
    this.els.leaveConfirmNo.addEventListener('click', () => this.resolveLeaveConfirm(false))
    this.els.leaveConfirmDontAsk.addEventListener('click', () => {
      this.skipLeaveConfirm = true
      this.api.settings.setSkipRemixLeaveConfirmEnabled(true).catch((err) => console.error('Editor: failed to persist leave-confirm setting', err))
      this.resolveLeaveConfirm(true)
    })
  }

  stopPreviewTicking() {
    if (this.previewRafId) {
      cancelAnimationFrame(this.previewRafId)
      this.previewRafId = null
    }
  }

  tickPreviewPlayhead() {
    const active = this.activePreview()
    if (!active || !this.loopEditorController) return
    if (this.previewMode === 'saved') {
      // The baked clip has its own 0-based timeline (it *is* the trimmed
      // region), unlike previewSource which plays the original file - offset
      // back into the original file's absolute time for the waveform's
      // playhead, but keep the sticky progress bar in the clip's own
      // 0..duration terms (see updateStickyProgress's mode branch).
      const source = this.clipTimeToSource(active.currentTime)
      this.loopEditorController.setPlayhead(source)
      this.spectralView?.setPlayhead(source)
      this.updateSeamPlayhead(source)
      this.updateStickyProgress(active.currentTime)
    } else {
      const currentTime = active.currentTime
      this.loopEditorController.setPlayhead(currentTime)
      this.spectralView?.setPlayhead(currentTime)
      this.updateSeamPlayhead(currentTime)
      this.updateStickyProgress(currentTime)
      // Volume envelope: only the *live* preview needs this (previewMode
      // 'live' means `active` here is always this.previewSource) - the
      // 'saved' branch above plays the baked clip, which already has the
      // envelope rendered in.
      this.previewSource?.tickEnvelope(currentTime)
    }
    // BakedClipPreview (the 'saved' engine) gained its own analyserNode
    // specifically so this can stay a single unconditional call rather than
    // one more mode branch - the spectrogram should track whichever engine
    // is actually audible either way.
    // Saved audio has no preAnalyserNode (the clip has the EQ baked in), so
    // the graph draws After only there.
    this.eqEditorController.tickSpectrum(active.analyserNode, active.preAnalyserNode)
    this.previewRafId = requestAnimationFrame(() => this.tickPreviewPlayhead())
  }

  // Drag-to-seek on the sticky progress bar - inbox answer to the v0.1.115
  // volume-slider follow-up ("make it so you can control the needle via the
  // progress bar on the sticky topbar... put a little circle on it so you
  // can drag"). Works whether the preview is playing or paused -
  // PreviewSource.scrubTo() already handles both (just repositions
  // currentTime, doesn't change play state). A click anywhere on the bar
  // seeks too, not just a precise grab on the thumb - matches how a normal
  // scrubbable progress bar works elsewhere (e.g. a video player).
  wireStickyProgressDrag() {
    let dragging = false

    const seekFromClientX = (clientX) => {
      const active = this.activePreview()
      if (!active) return
      const rect = this.els.stickyProgress.getBoundingClientRect()
      const fraction = Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1)
      if (this.previewMode === 'saved') {
        const span = active.duration || 0
        const t = fraction * span
        active.scrubTo(t)
        this.updateStickyProgress(t)
        if (this.loopEditorController) {
          this.loopEditorController.setPlayhead(this.clipTimeToSource(t))
        }
      } else {
        if (!this.loopEditorController) return
        const { loopStart, loopEnd } = this.loopEditorController.getLoopPoints()
        const t = loopStart + fraction * Math.max(0, loopEnd - loopStart)
        active.scrubTo(t)
        this.loopEditorController.setPlayhead(t)
        this.updateStickyProgress(t)
      }
    }

    this.els.stickyProgress.addEventListener('mousedown', (evt) => {
      if (!this.activePreview()) return
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
  updateStickyProgress(currentTime) {
    if (!this.els.stickyProgressFill) return
    let elapsed, span
    if (this.previewMode === 'saved' && this.bakedPreview) {
      // currentTime is already clip-relative here (0..clip duration) - see
      // tickPreviewPlayhead's mode branch and wireStickyProgressDrag's own
      // seek math, both of which pass clip-relative time in this mode.
      span = Math.max(0, this.bakedPreview.duration || 0)
      elapsed = Math.min(Math.max(currentTime, 0), span)
    } else {
      if (!this.loopEditorController) return
      const { loopStart, loopEnd } = this.loopEditorController.getLoopPoints()
      span = Math.max(0, loopEnd - loopStart)
      elapsed = Math.min(Math.max(currentTime - loopStart, 0), span)
    }
    const pct = span > 0 ? (elapsed / span) * 100 : 0
    this.els.stickyProgressFill.style.width = `${pct}%`
    this.els.stickyProgressThumb.style.left = `${pct}%`
    this.els.stickyTime.textContent = `${formatDuration(elapsed)} / ${formatDuration(span)}`
    this.updateNeedleField(this.previewMode === 'saved' && this.bakedPreview ? this.clipTimeToSource(currentTime) : currentTime)
  }

  // Needle field follows the needle (original-file seconds) on every tick. It
  // only writes when the text changes (whole seconds) and never while typed in.
  updateNeedleField(sourceTime) {
    const input = this.els.needleInput
    if (!input || input === input.ownerDocument.activeElement) return
    const text = formatDuration(sourceTime)
    if (input.value !== text) input.value = text
  }

  get previewSource() { return this.previewCtl.source }
  get bakedPreview() { return this.previewCtl.baked }

  disposePreview() {
    this.stopSeamListen({ pause: false })
    this.stopPreviewTicking()
    this.autosave.cancel()
    this.flushFluctuation()
    this.eqEditorController?.clearSpectrum()
    this.previewMode = 'live'
    this.previewCtl.disposeBaked()
    if (this.els.previewModeToggle) this.updatePreviewModeToggle()
    if (!this.previewCtl.disposeSource()) return
    this.loopEditorController?.clearPlayhead()
    this.seamView?.setPlayhead(null)
    if (this.els.stickyProgressFill) {
      this.els.stickyProgressFill.style.width = '0%'
      this.els.stickyProgressThumb.style.left = '0%'
      this.els.stickyTime.textContent = '0:00 / 0:00'
    }
    if (this.els.needleInput) this.els.needleInput.value = '0:00'
    this.setPlayPauseIcon(false)
  }

  async getWaveformPeaks(id) {
    if (this.waveformPeaksCache.has(id)) return this.waveformPeaksCache.get(id)
    // A sound opened while another view (EQ, Spectrum, Loop seam) is showing
    // has a hidden Trim canvas, which resizeCanvasForDisplay shrinks to 1 px;
    // peaks fetched at that width are cached and draw as a flat band.
    const width = this.els.canvas.width > 1 ? this.els.canvas.width : 2048
    const peaks = await this.api.audio.getWaveformPeaks(id, width)
    this.waveformPeaksCache.set(id, peaks)
    return peaks
  }

  // The base peaks fetched above always cover the whole file at a fixed
  // width - once the user zooms in past what that resolution can actually
  // show (the current view's own seconds-per-pixel drops below the base
  // array's seconds-per-bucket), a real, finer-grained ffmpeg pass over just
  // the visible window gets genuinely more detail rather than resampling the
  // same coarse data (see the rendering-only smoothing already in
  // waveform.js for that other, cheaper half of this same complaint).
  // Debounced so a zoom gesture (many wheel ticks in quick succession)
  // doesn't spawn a new ffmpeg process per tick - only the settled end state
  // gets fetched.
  maybeFetchDetailPeaks(viewStart, viewEnd, duration) {
    clearTimeout(this.detailPeaksDebounceTimer)
    const id = this.currentEntry?.id
    const basePeaks = id ? this.waveformPeaksCache.get(id) : null
    if (!id || !basePeaks || !duration) return

    const baseSecondsPerBucket = duration / basePeaks.length
    const viewSecondsPerPixel = (viewEnd - viewStart) / this.els.canvas.getBoundingClientRect().width
    if (viewSecondsPerPixel >= baseSecondsPerBucket) return

    this.detailPeaksDebounceTimer = setTimeout(async () => {
      const width = Math.max(1, Math.round(this.els.canvas.getBoundingClientRect().width))
      try {
        const detail = await this.api.audio.getWaveformPeaks(id, width, viewStart, viewEnd)
        // The user may have switched sounds, or zoomed/panned away from this
        // exact window, by the time the fetch resolves - setDetailPeaks
        // itself also re-checks the viewport is still covered before using
        // it, but there's no point handing a different sound's data over at
        // all.
        if (!detail || this.currentEntry?.id !== id) return
        this.loopEditorController.setDetailPeaks(detail, viewStart, viewEnd)
      } catch (err) {
        console.error('Editor: detail waveform peaks fetch failed', err)
      }
    }, 250)
  }

  loadSound(id) {
    return this.soundLoader.load(id)
  }

  nextCopyName(baseName) {
    return nextCopyName(this.library.map((e) => e.name), baseName)
  }

  save(options) {
    return this.saveCtl.save(options)
  }

  saveAsCopy() {
    return this.saveCtl.saveAsCopy()
  }

  saveSegmentAsNew() {
    return this.saveCtl.saveSegmentAsNew()
  }

  // Saved-audio <audio> element hand-off around a re-bake (used by SaveController).
  // The sound:// handler streams the clip with backpressure, so a loaded element keeps
  // the file open and Windows refuses to rename the fresh render over it (v0.1.214);
  // release it first. _clipRebaking keeps updatePreviewModeToggle from kicking the
  // user out of Saved mode while the preview is torn down. Returns where to resume.
  releaseBakedPreviewForRebake() {
    return this.previewCtl.releaseBakedForRebake()
  }

  // Recreate bakedPreview after the bake (see previewController). Gated on stillEditing:
  // bakedPreview and previewMode belong to whichever sound is open now.
  restoreBakedPreviewAfterRebake(args) {
    this.previewCtl.restoreBakedAfterRebake(args)
  }

  // ============================================================
  // Preset mode / Group mode (v0.1.147) - see the top-of-file comment next
  // to NEUTRAL_WHOLE_MIX for why these live in this same file/class instead
  // of a separate plugin.
  // ============================================================

  wireMixControls() {
    this.els.modeSound.addEventListener('click', () => this.setMode('sound'))
    this.els.modePreset.addEventListener('click', () => this.setMode('preset'))
    this.els.modeGroup.addEventListener('click', () => this.setMode('group'))

    this.els.mixPresetSelect.addEventListener('change', () => this.selectMixPreset(this.els.mixPresetSelect.value))
    this.els.mixGroupSelect.addEventListener('change', () => this.selectGroup(this.els.mixGroupSelect.value))
    this.els.mixGroupNew.addEventListener('click', () => this.createGroup())

    for (const el of [this.els.mixPresetHighpass, this.els.mixPresetLowpass, this.els.mixPresetGain, this.els.mixPresetEchoDelay, this.els.mixPresetEchoDecay, this.els.mixPresetReverbSize, this.els.mixPresetReverbMix]) {
      el.addEventListener('input', () => this.readPresetMixControlsAndPreview())
    }
    this.els.mixPresetFadeIn.addEventListener('input', () => this.readPresetMixControlsAndPreview())
    for (const el of [this.els.mixPresetFlucEnabled, this.els.mixPresetFlucFullRandom, this.els.mixPresetFlucChangeMin, this.els.mixPresetFlucChangeMax, this.els.mixPresetFlucTransition, this.els.mixPresetFlucBias]) {
      el.addEventListener(el.type === 'checkbox' ? 'change' : 'input', () => this.readPresetMixControlsAndPreview())
    }
    this.els.mixPresetResetFilters.addEventListener('click', () => {
      this.writePresetMixControls(NEUTRAL_WHOLE_MIX)
      this.presetEq.load(defaultEqBands())
      this.presetEqTarget.updateFields()
      this.readPresetMixControlsAndPreview()
      this.presetEqTarget.apply()
    })
    for (const button of this.els.mixPresetEffectButtons) {
      button.addEventListener('click', () => {
        const preset = FILTER_PRESETS[button.dataset.mixPresetEffect]
        if (!preset) return
        this.setPresetEffectPreset(preset)
        this.readPresetMixControlsAndPreview()
      })
    }

    this.els.mixGroupName.addEventListener('input', () => this.updateGroupDirty())
    for (const el of [this.els.mixGroupHighpass, this.els.mixGroupLowpass, this.els.mixGroupGain, this.els.mixGroupPan, this.els.mixGroupEchoDelay, this.els.mixGroupEchoDecay, this.els.mixGroupReverbSize, this.els.mixGroupReverbMix, this.els.mixGroupOcclusion]) {
      el.addEventListener('input', () => this.readGroupControlsAndPreview())
    }
    for (const el of [this.els.mixGroupFlucEnabled, this.els.mixGroupFlucFullRandom, this.els.mixGroupFlucChangeMin, this.els.mixGroupFlucChangeMax, this.els.mixGroupFlucTransition, this.els.mixGroupFlucPanEnabled, this.els.mixGroupFlucPanFullRandom, this.els.mixGroupFlucPanChangeMin, this.els.mixGroupFlucPanChangeMax, this.els.mixGroupFlucPanTransition, this.els.mixGroupFlucBias, this.els.mixGroupFlucPerSound, this.els.mixGroupFlucPanBias, this.els.mixGroupFlucPanPerSound, this.els.mixGroupFlucPitchEnabled, this.els.mixGroupFlucPitchFullRandom, this.els.mixGroupFlucPitchChangeMin, this.els.mixGroupFlucPitchChangeMax, this.els.mixGroupFlucPitchTransition, this.els.mixGroupFlucPitchBias]) {
      el.addEventListener(el.type === 'checkbox' ? 'change' : 'input', () => this.readGroupControlsAndPreview())
    }
    this.els.mixGroupResetFilters.addEventListener('click', () => {
      this.writeGroupControls(NEUTRAL_GROUP_FILTERS)
      this.groupEq.load(defaultEqBands())
      this.groupEqTarget.updateFields()
      this.readGroupControlsAndPreview()
      this.groupEqTarget.apply()
    })
    for (const button of this.els.mixGroupEffectButtons) {
      button.addEventListener('click', () => {
        const preset = FILTER_PRESETS[button.dataset.mixGroupEffect]
        if (!preset) return
        this.setGroupEffectPreset(preset)
        this.readGroupControlsAndPreview()
      })
    }
  }

  // Switches which of the three modes is showing. Leaving Sound pauses
  // whatever's previewing there (its sticky controls are about to
  // disappear, so nothing should keep playing un-controllably behind a
  // hidden panel); leaving Preset/Group reverts that mode's live preview to
  // its last-saved value, same convention the old standalone Preset Remix
  // plugin's own onHide already established, just now triggered by a mode
  // switch instead of a tab switch.
  setMode(mode) {
    if (this.mode === mode) return
    const leaving = this.mode
    this.mode = mode
    this.itemPreview.stop()

    if (leaving === 'sound') {
      this.activePreview()?.pause()
      this.stopPreviewTicking()
      this.setPlayPauseIcon(false)
      this.eqEditorController?.clearSpectrum()
    }
    if (leaving === 'preset') this.dispatchWholeMixPreview(this.wholeMixSaved)
    if (leaving === 'group' && this.selectedGroupId) this.dispatchGroupPreview(this.groupSaved)

    if (mode === 'sound') {
      this.stopWholeMixSpectrumTicking()
    } else {
      if (mode === 'preset') this.dispatchWholeMixPreview(this.wholeMixCurrent)
      else if (this.selectedGroupId) this.dispatchGroupPreview(this.groupCurrent)
      this.startWholeMixSpectrumTicking()
      // A canvas measures 0x0 while its panel is display:none, so its last
      // draw (from writeMixFluctuation during selectMixPreset/selectGroup,
      // possibly while this panel was hidden) rendered nothing - redraw now
      // that it's visible. Same fix Sound mode's own bars needed (v0.1.164).
      ;(mode === 'preset' ? this.presetFlucBar : this.groupFlucBar)?.redraw()
    }

    this.updateModeUI()
  }

  updateModeUI() {
    const mode = this.mode
    this.layout?.refreshScopes?.()
    this.els.modeSound.classList.toggle('editor-mode-pill-active', mode === 'sound')
    this.els.modePreset.classList.toggle('editor-mode-pill-active', mode === 'preset')
    this.els.modeGroup.classList.toggle('editor-mode-pill-active', mode === 'group')
    const hints = {
      sound: 'Trim, filters, EQ and live preview for one sound at a time.',
      preset: 'Highpass/lowpass/gain, fade-in and EQ for a whole loaded preset.',
      group: "A shared bus for a few of a preset's sounds - EQ them together non-destructively."
    }
    this.els.modeHint.textContent = hints[mode]
    this.els.modePanelSound.classList.toggle('hidden', mode !== 'sound')
    this.els.modePanelPreset.classList.toggle('hidden', mode !== 'preset')
    this.els.modePanelGroup.classList.toggle('hidden', mode !== 'group')
    this.els.mixPickerRow.classList.toggle('hidden', mode === 'sound')
    this.els.mixGroupSelectLabel.classList.toggle('hidden', mode !== 'group')
    this.els.mixGroupSelect.classList.toggle('hidden', mode !== 'group')
    this.els.mixGroupNew.classList.toggle('hidden', mode !== 'group')
    this.els.stickySoundControls.classList.toggle('hidden', mode !== 'sound')
    this.els.soundPicker?.classList.toggle('hidden', mode !== 'sound')
    this.els.stickyMixControls.classList.toggle('hidden', mode === 'sound')
    this.els.mixDeleteGroup.classList.toggle('hidden', mode !== 'group' || !this.selectedGroupId)
    this.els.mixCopyGroupTo.classList.toggle('hidden', mode !== 'group' || !this.selectedGroupId)
    if (mode === 'preset') {
      this.els.mixSave.disabled = !this.selectedPresetId || wholeMixEqual(this.wholeMixCurrent, this.wholeMixSaved)
      this.els.mixStatus.textContent = '' // the head's meta line says what to pick
    } else if (mode === 'group') {
      const dirty = this.selectedGroupId && (this.els.mixGroupName.value.trim() !== this.groups.find((g) => g.id === this.selectedGroupId)?.name || !groupFiltersEqual(this.groupCurrent, this.groupSaved))
      this.els.mixSave.disabled = !this.selectedGroupId || !dirty
      this.els.mixStatus.textContent = ''
    }
    this.layout?.refreshStudio?.()
  }

  // --- Live spectrogram (Preset/Group only) ---
  // A second, separate rAF loop from tickPreviewPlayhead (which only ever
  // drives Sound mode) - there's no playhead/progress to show here, this
  // loop's only job is polling whichever real engine node is relevant right
  // now and feeding it to that mode's own EqEditor controller (presetEq/
  // groupEq).
  startWholeMixSpectrumTicking() {
    if (this._wholeMixSpectrumRafId) return
    const tick = () => {
      this.tickWholeMixSpectrum()
      this._wholeMixSpectrumRafId = requestAnimationFrame(tick)
    }
    this._wholeMixSpectrumRafId = requestAnimationFrame(tick)
  }

  stopWholeMixSpectrumTicking() {
    if (this._wholeMixSpectrumRafId) cancelAnimationFrame(this._wholeMixSpectrumRafId)
    this._wholeMixSpectrumRafId = null
    this.presetEq?.clearSpectrum()
    this.groupEq?.clearSpectrum()
  }

  // Cleared whenever the thing being looked at changes (a different preset
  // or group selected) so the scrolling loudness strip doesn't show a few
  // stale seconds from whatever was open before.
  resetLevelHistory(which) {
    if (which === 'preset') this.presetLevelHistory.length = 0
    else if (which === 'group') this.groupLevelHistory.length = 0
  }

  tickWholeMixSpectrum() {
    this.updateMixPlayPauseUI(requestMixerStatus())

    if (this.mode === 'preset' && this.selectedPresetId) {
      const node = requestAnalyser('whole-mix', this.selectedPresetId, null)
      if (node) {
        this.presetEq.tickSpectrum(node)
        if (!this._presetTimeBuf || this._presetTimeBuf.length !== node.fftSize) this._presetTimeBuf = new Uint8Array(node.fftSize)
        node.getByteTimeDomainData(this._presetTimeBuf)
        pushLevel(this.presetLevelHistory, peakFromTimeDomain(this._presetTimeBuf))
      } else {
        this.presetEq.clearSpectrum()
        pushLevel(this.presetLevelHistory, 0)
      }
      drawLevelHistory(this.els.mixPresetWaveform, this.presetLevelHistory)
    } else if (this.mode === 'group' && this.selectedPresetId && this.selectedGroupId) {
      const node = requestAnalyser('group', this.selectedPresetId, this.selectedGroupId)
      if (node) {
        this.groupEq.tickSpectrum(node)
        if (!this._groupTimeBuf || this._groupTimeBuf.length !== node.fftSize) this._groupTimeBuf = new Uint8Array(node.fftSize)
        node.getByteTimeDomainData(this._groupTimeBuf)
        pushLevel(this.groupLevelHistory, peakFromTimeDomain(this._groupTimeBuf))
      } else {
        this.groupEq.clearSpectrum()
        pushLevel(this.groupLevelHistory, 0)
      }
      drawLevelHistory(this.els.mixGroupWaveform, this.groupLevelHistory)
    }
  }

  // Reflects real Mixer state on the shared Play/Pause icon + Group mode's
  // Solo button - polled once per tick (see tickWholeMixSpectrum) rather
  // than pushed, since this plugin has no direct reference into the
  // Mixer's own state to subscribe to.
  updateMixPlayPauseUI(status) {
    const isActivePreset = Boolean(this.selectedPresetId) && status.activePresetId === this.selectedPresetId
    const soloed = this.mode === 'group' && isActivePreset && status.soloedGroupId === this.selectedGroupId
    // Group mode's Play plays only the picked group (owner, 2026-11-11), so
    // the whole preset playing there shows Play: pressing it solos the group.
    const playing = isActivePreset && status.isPlaying && (this.mode !== 'group' || !this.selectedGroupId || soloed)
    this.updateMixVolumeUI(status)
    // Skip the DOM writes entirely when nothing actually changed since the
    // last tick (self-review v0.1.149) - this runs every rAF frame for as
    // long as Preset/Group mode is open, and .innerHTML in particular tears
    // down and rebuilds the icon's SVG node every single call regardless of
    // whether play/pause/solo state flipped.
    const signature = JSON.stringify([this.mode, this.selectedPresetId, this.selectedGroupId, playing, isActivePreset, soloed])
    if (signature === this._mixPlayPauseSignature) return
    this._mixPlayPauseSignature = signature

    this.els.mixPlayPause.innerHTML = playing ? PAUSE_ICON_SVG : PLAY_ICON_SVG
    this.els.mixPlayPause.title = playing ? 'Pause' : isActivePreset ? 'Play' : 'Load this preset and play it in the Mixer'
    this.els.mixPlayPause.disabled = !this.selectedPresetId

    if (this.mode === 'group' && this.selectedGroupId) this.els.mixPlayPause.title = playing ? 'Pause' : 'Play this group only'
    // Play is the solo now, so the separate Solo button stays hidden.
    this.els.mixSoloGroup.classList.add('hidden')
    // The preview module is built after els are looked up (arrangeBar), so
    // the note is found here.
    const note = this.root?.querySelector('#rx-pnote')
    if (note) note.hidden = !(this.mode === 'group' && playing && soloed)
  }

  // The Group/Preset player's volume row is the app's master volume (those
  // modes play through the Mixer). Polled with the status like Play/Pause; an
  // app without the remix-set-volume bridge reports no volumePosition, and
  // the row stays hidden.
  updateMixVolumeUI(status) {
    const supported = Number.isFinite(status.volumePosition)
    this.root?.classList.toggle('rx-mixvol-on', supported)
    if (!supported) return
    const doc = this.els.mixVolume.ownerDocument
    if (doc.activeElement !== this.els.mixVolume || !this.els.mixVolume.matches(':active')) {
      const value = String(Math.round(status.volumePosition * 1000))
      if (this.els.mixVolume.value !== value) this.els.mixVolume.value = value
    }
    this.els.mixVolume.style.setProperty('--p', `${(Number(this.els.mixVolume.value) / 10).toFixed(1)}%`)
    const muted = Boolean(status.muted)
    if (this._mixMuted !== muted) {
      this._mixMuted = muted
      this.els.mixMute.innerHTML = muted ? MUTE_ICON_SVG : VOLUME_ICON_SVG
      this.els.mixMute.title = muted ? 'Unmute' : 'Mute'
      this.els.mixMute.setAttribute('aria-label', this.els.mixMute.title)
    }
  }

  // Play button (v0.1.148) - reported directly ("where's the play button
  // for the preset and group?"): Preset/Group mode previously only ever
  // previewed live if that preset already happened to be playing in the
  // Mixer, with no way to actually start it from Remix itself. Loading a
  // preset (tabs/mixer/index.js's loadPreset) already unconditionally plays
  // every sound in it, so "not yet the active preset" and "toggle the
  // shared mix's play/pause" are the only two cases this needs.
  onMixPlayPauseClick() {
    if (!this.selectedPresetId) return
    const status = requestMixerStatus()
    if (this.mode === 'group' && this.selectedGroupId) {
      this.playGroupOnly(status)
      return
    }
    // Preset mode plays the whole preset: a group soloed from Group mode is
    // released first.
    if (status.activePresetId === this.selectedPresetId && status.soloedGroupId) {
      window.dispatchEvent(new CustomEvent('noctivago:remix-unsolo-group', {}))
      if (!status.isPlaying) window.dispatchEvent(new CustomEvent('noctivago:remix-toggle-playback', {}))
      return
    }
    if (status.activePresetId !== this.selectedPresetId) {
      window.dispatchEvent(new CustomEvent('noctivago:remix-load-preset', { detail: { presetId: this.selectedPresetId } }))
    } else {
      window.dispatchEvent(new CustomEvent('noctivago:remix-toggle-playback', {}))
    }
  }

  // Group mode's Play (owner, 2026-11-11): plays only the picked group, with
  // "Playing this group only" on the player. Loads the preset if needed (with
  // the solo applied once it lands), solos the group if another is heard,
  // and otherwise toggles play/pause.
  playGroupOnly(status) {
    const presetId = this.selectedPresetId
    const groupId = this.selectedGroupId
    if (status.activePresetId !== presetId) {
      window.dispatchEvent(new CustomEvent('noctivago:remix-load-preset', { detail: { presetId, soloGroupId: groupId } }))
      return
    }
    if (status.soloedGroupId !== groupId) {
      window.dispatchEvent(new CustomEvent('noctivago:remix-solo-group', { detail: { presetId, groupId } }))
      if (!status.isPlaying) window.dispatchEvent(new CustomEvent('noctivago:remix-toggle-playback', {}))
      return
    }
    window.dispatchEvent(new CustomEvent('noctivago:remix-toggle-playback', {}))
  }

  // Group mode's own "hear just this group" button - mutes every other
  // currently-playing sound in the Mixer, same idea as Sound mode's Solo
  // button (src/renderer/tabs/mixer/index.js's applyGroupSolo). Loads the
  // preset first if it isn't already playing, same as plain Play, since
  // soloing implies wanting to actually hear it.
  onMixSoloGroupClick() {
    if (!this.selectedPresetId || !this.selectedGroupId) return
    const status = requestMixerStatus()
    const alreadySoloed = status.activePresetId === this.selectedPresetId && status.soloedGroupId === this.selectedGroupId
    if (alreadySoloed) {
      window.dispatchEvent(new CustomEvent('noctivago:remix-unsolo-group', {}))
      return
    }
    if (status.activePresetId !== this.selectedPresetId) {
      window.dispatchEvent(new CustomEvent('noctivago:remix-load-preset', { detail: { presetId: this.selectedPresetId, soloGroupId: this.selectedGroupId } }))
    } else {
      window.dispatchEvent(new CustomEvent('noctivago:remix-solo-group', { detail: { presetId: this.selectedPresetId, groupId: this.selectedGroupId } }))
    }
  }

  // --- Preset mode ---

  async refreshMixPanel() {
    // BUG FIX (v0.1.227): this used to set this.library to the raw shared
    // defaults, so a sound opened in Sound mode after visiting Preset/Group
    // mode showed (and then saved over its preset settings with) the shared
    // defaults. refreshLibrary() keeps the per-preset effective view and
    // refreshes this.presets too.
    await this.refreshLibrary()
    const previous = this.selectedPresetId
    this.renderPresetSelectOptions()

    const stillThere = this.presets.some((p) => p.id === previous)
    const target = stillThere ? previous : (this.presets[0]?.id ?? null)
    this.els.mixPresetSelect.value = target ?? ''
    this.selectMixPreset(target, { silent: true })
  }

  // The "In preset" dropdown (Group mode). Called from refreshLibrary too,
  // which every refresh path runs, so a preset made, renamed or deleted
  // elsewhere shows here without a tab switch (owner, 2026-11-17: a new
  // preset was missing from Remix's lists until a restart).
  renderPresetSelectOptions() {
    const select = this.els.mixPresetSelect
    if (!select) return
    const keep = select.value
    select.innerHTML = this.presets.length
      ? this.presets.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join('')
      : '<option value="">No presets saved yet</option>'
    if (this.presets.some((p) => p.id === keep)) select.value = keep
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
  selectMixPreset(id, { silent = false } = {}) {
    const presetChanged = id !== this.selectedPresetId
    if (presetChanged) this.resetLevelHistory('preset')
    if (presetChanged && this.selectedGroupId) this.dispatchGroupPreview(this.groupSaved)

    this.selectedPresetId = id || null
    const preset = this.presets.find((p) => p.id === id)
    this.wholeMixSaved = cloneWholeMix(preset?.wholeMix ?? null)
    this.wholeMixCurrent = cloneWholeMix(this.wholeMixSaved)
    this.writePresetMixControls(this.wholeMixCurrent)
    this.presetEq.load(this.wholeMixCurrent.eq)
    this.presetEqTarget.resetCompare()
    this.presetEqTarget.updateFields()
    this.updatePresetMixLabels()
    this.els.mixPresetControls.classList.toggle('editor-mix-disabled', !preset)
    if (!silent && this.mode === 'preset') this.dispatchWholeMixPreview(this.wholeMixCurrent)

    this.groups = preset?.groups ?? []
    this.renderGroupSelectOptions()
    this.renderCopyGroupTargetOptions()
    if (presetChanged) {
      this.selectedGroupId = null
      this.els.mixGroupSelect.value = ''
      this.els.mixGroupEditor.classList.add('hidden')
      this.els.mixGroupEmpty.classList.remove('hidden')
    } else if (this.selectedGroupId) {
      // Same preset, just a refresh - keep editing whichever group was
      // open, re-synced against the freshly fetched data (its membership or
      // filters may have changed elsewhere, e.g. the Mixer's own right-click
      // menu, while this tab was hidden).
      const group = this.groups.find((g) => g.id === this.selectedGroupId)
      if (group) {
        this.els.mixGroupSelect.value = this.selectedGroupId
        this.renderGroupMembers()
      } else {
        this.selectedGroupId = null
        this.els.mixGroupEditor.classList.add('hidden')
        this.els.mixGroupEmpty.classList.remove('hidden')
      }
    }
    this.updateModeUI()
  }

  writePresetMixControls(mix) {
    this.els.mixPresetHighpass.value = String(mix.highpassHz)
    this.els.mixPresetLowpass.value = String(mix.lowpassHz)
    this.els.mixPresetGain.value = String(mix.gainDb)
    this.els.mixPresetEchoDelay.value = String(mix.echoDelayMs)
    this.els.mixPresetEchoDecay.value = String(mix.echoDecay)
    this.els.mixPresetReverbSize.value = String(mix.reverbSizeMs ?? 0)
    this.els.mixPresetReverbMix.value = String(mix.reverbMix ?? 0)
    this.els.mixPresetFadeIn.value = String(mix.fadeInSeconds)
    this.writeMixFluctuation(mix.fluctuation, this.presetFlucEls)
  }

  readPresetMixControlsAndPreview() {
    this.wholeMixCurrent = {
      ...this.wholeMixCurrent,
      highpassHz: Number(this.els.mixPresetHighpass.value),
      lowpassHz: Number(this.els.mixPresetLowpass.value),
      gainDb: Number(this.els.mixPresetGain.value),
      echoDelayMs: Number(this.els.mixPresetEchoDelay.value),
      echoDecay: Number(this.els.mixPresetEchoDecay.value),
      reverbSizeMs: Number(this.els.mixPresetReverbSize.value),
      reverbMix: Number(this.els.mixPresetReverbMix.value),
      fadeInSeconds: Math.max(0, Number(this.els.mixPresetFadeIn.value) || 0),
      fluctuation: this.readMixFluctuation(this.presetFlucEls)
    }
    this.updatePresetMixLabels()
    this.updateMixFlucEnabledUI(this.presetFlucEls)
    this.updateModeUI()
    if (this.mode === 'preset') this.dispatchWholeMixPreview(this.wholeMixCurrent)
  }

  // --- Fluctuation shared helpers (Preset + Group mode) ---
  // `els` is a bundle: { enabledEl, bar, changeMinEl, changeMaxEl, transEl,
  // fullRandomEl } for the volume axis (this.presetFlucEls /
  // this.groupFlucEls), plus an optional `pan` sub-bundle of the same shape
  // (Group mode only, v0.1.217).
  readMixFluctuation(els) {
    return {
      volume: this.readMixFlucAxis(els),
      ...(els.pitch ? { pitch: this.readMixFlucAxis(els.pitch) } : {}),
      ...(els.pan ? { pan: this.readMixFlucAxis(els.pan) } : {})
    }
  }

  readMixFlucAxis(axisEls) {
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

  writeMixFluctuation(fluctuation, els) {
    // No saved axis (a neutral preset, or Reset filters) → show the default
    // spread, not all three handles collapsed at 1.
    const d = defaultMixFluctuation()
    const volSrc = fluctuation?.volume ?? d.volume
    this.writeMixFlucAxis({ ...d.volume, ...normalizeFluctuationAxis(volSrc, 1), perSound: Boolean(volSrc.perSound) }, els)
    if (els.pitch) this.writeMixFlucAxis({ ...d.pitch, ...normalizeFluctuationAxis(fluctuation?.pitch ?? d.pitch, 0) }, els.pitch)
    if (els.pan) {
      const src = fluctuation?.pan ?? d.pan
      this.writeMixFlucAxis({ ...d.pan, ...normalizeFluctuationAxis(src, 0), perSound: Boolean(src.perSound) }, els.pan)
    }
    this.updateMixFlucEnabledUI(els)
  }

  writeMixFlucAxis(axis, axisEls) {
    axisEls.enabledEl.checked = axis.enabled
    axisEls.fullRandomEl.checked = axis.fullyRandom
    axisEls.changeMinEl.value = String(axis.changeMinSeconds)
    axisEls.changeMaxEl.value = String(axis.changeMaxSeconds)
    axisEls.transEl.value = String(axis.transitionSeconds)
    axisEls.biasEl.checked = axis.biasEnabled !== false
    if (axisEls.perSoundEl && !axisEls.perSoundLocked) axisEls.perSoundEl.checked = Boolean(axis.perSound)
    axisEls.bar.setValues(axis)
  }

  updateMixFlucEnabledUI(els) {
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

  setPresetEffectPreset(preset) {
    this.els.mixPresetHighpass.value = String(preset.highpassHz)
    this.els.mixPresetLowpass.value = String(preset.lowpassHz)
    this.els.mixPresetGain.value = String(preset.gainDb)
    this.els.mixPresetEchoDelay.value = String(preset.echoDelayMs ?? 0)
    this.els.mixPresetEchoDecay.value = String(preset.echoDecay ?? 0)
    this.els.mixPresetReverbSize.value = String(preset.reverbSizeMs ?? 0)
    this.els.mixPresetReverbMix.value = String(preset.reverbMix ?? 0)
  }

  updatePresetMixLabels() {
    const hp = Number(this.els.mixPresetHighpass.value)
    const lp = Number(this.els.mixPresetLowpass.value)
    const gain = Number(this.els.mixPresetGain.value)
    const echoDelay = Number(this.els.mixPresetEchoDelay.value)
    const echoDecay = Number(this.els.mixPresetEchoDecay.value)
    const reverbSize = Number(this.els.mixPresetReverbSize.value)
    const reverbMix = Number(this.els.mixPresetReverbMix.value)
    this.els.mixPresetHighpassValue.textContent = hp > 0 ? `${hp} Hz` : 'Off'
    this.els.mixPresetLowpassValue.textContent = lp < 20000 ? `${lp} Hz` : 'Off'
    this.els.mixPresetGainValue.textContent = `${gain > 0 ? '+' : ''}${gain} dB`
    this.els.mixPresetEchoDelayValue.textContent = echoDelay > 0 ? `${echoDelay} ms` : 'Off'
    this.els.mixPresetEchoDecayValue.textContent = echoDecay > 0 ? echoDecay.toFixed(2) : 'Off'
    this.els.mixPresetReverbSizeValue.textContent = reverbSize > 0 ? `${(reverbSize / 1000).toFixed(1)}s` : 'Off'
    this.els.mixPresetReverbMixValue.textContent = reverbMix > 0 ? `${Math.round(reverbMix * 100)}%` : 'Off'
  }

  async saveWholeMix() {
    if (!this.selectedPresetId || this._wholeMixSaveInProgress) return
    this._wholeMixSaveInProgress = true
    this.els.mixSave.disabled = true
    try {
      const updated = await this.api.presets.updateWholeMix(this.selectedPresetId, this.wholeMixCurrent)
      this.wholeMixSaved = cloneWholeMix(updated?.wholeMix ?? null)
      this.wholeMixCurrent = cloneWholeMix(this.wholeMixSaved)
      this.writePresetMixControls(this.wholeMixCurrent)
      this.presetEq.load(this.wholeMixCurrent.eq)
      this.presetEqTarget.updateFields()
      this.presetEqTarget.updateBanner()
      this.updatePresetMixLabels()
      const local = this.presets.find((p) => p.id === this.selectedPresetId)
      if (local) local.wholeMix = updated?.wholeMix ?? null
      this.dispatchWholeMixPreview(this.wholeMixSaved)
      this.els.mixStatus.textContent = 'Saved. Load this preset in the Mixer to hear it.'
    } catch (err) {
      console.error('Editor: preset save failed', err)
      this.els.mixStatus.textContent = `Save failed: ${err.message}`
    } finally {
      this._wholeMixSaveInProgress = false
      this.updateModeUI()
    }
  }

  dispatchWholeMixPreview(wholeMix) {
    if (!this.selectedPresetId) return
    window.dispatchEvent(
      new CustomEvent('noctivago:whole-mix-preview', {
        detail: { presetId: this.selectedPresetId, wholeMix: cloneWholeMix(wholeMix) }
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

  renderGroupSelectOptions() {
    this.els.mixGroupSelect.innerHTML = this.groups.length
      ? this.groups.map((g) => `<option value="${escapeHtml(g.id)}">${escapeHtml(g.name)} (${g.soundIds.length})</option>`).join('')
      : '<option value="">No groups yet</option>'
    this.layout?.refreshStudio?.()
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
  renderCopyGroupTargetOptions() {
    const placeholder = '<option value="" selected disabled>Copy to preset…</option>'
    const others = this.presets.filter((p) => p.id !== this.selectedPresetId)
    this.els.mixCopyGroupTo.innerHTML =
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
  async copyGroupToPreset(targetPresetId) {
    this.els.mixCopyGroupTo.value = ''
    if (!targetPresetId || !this.selectedGroupId || !this.selectedPresetId) return
    const sourceGroup = this.groups.find((g) => g.id === this.selectedGroupId)
    if (!sourceGroup) return
    // Reads presets fresh right before the write rather than trusting
    // this.presets (which could be stale if the target preset's own groups
    // changed elsewhere, e.g. the Mixer's right-click menu, while this tab
    // sat open) - a whole-array replace write is exactly the case that
    // matters for, per this file's own established "read fresh before a
    // whole-array replace" precedent (see toggleGroupMember's comment).
    const freshPresets = await this.api.presets.list()
    const targetPreset = freshPresets.find((p) => p.id === targetPresetId)
    if (!targetPreset) return
    const newGroup = { name: sourceGroup.name, soundIds: [...sourceGroup.soundIds], filters: cloneGroupFilters(sourceGroup.filters) }
    const updatedGroups = [...(targetPreset.groups ?? []), newGroup]
    const saved = await this.api.presets.updateGroups(targetPresetId, updatedGroups)
    this.presets = freshPresets.map((p) => (p.id === targetPresetId ? (saved ?? { ...p, groups: updatedGroups }) : p))
    if (targetPresetId === this.selectedPresetId) {
      this.groups = saved?.groups ?? updatedGroups
      this.renderGroupSelectOptions()
    }
    window.dispatchEvent(new CustomEvent('noctivago:sound-groups-changed', { detail: { presetId: targetPresetId } }))
    this.els.mixStatus.textContent = `Copied "${sourceGroup.name}" to "${targetPreset.name}".`
  }

  selectGroup(id) {
    if (this.selectedGroupId) this.dispatchGroupPreview(this.groupSaved)
    if (id !== this.selectedGroupId) this.resetLevelHistory('group')

    const group = this.groups.find((g) => g.id === id)
    this.selectedGroupId = group ? id : null
    this.els.mixGroupSelect.value = this.selectedGroupId ?? ''
    if (!group) {
      this.els.mixGroupEditor.classList.add('hidden')
      this.els.mixGroupEmpty.classList.remove('hidden')
      this.updateModeUI()
      return
    }

    this.els.mixGroupEditor.classList.remove('hidden')
    this.els.mixGroupEmpty.classList.add('hidden')
    this.els.mixGroupName.value = group.name
    this.groupSaved = cloneGroupFilters(group.filters)
    this.groupCurrent = cloneGroupFilters(this.groupSaved)
    this.writeGroupControls(this.groupCurrent)
    this.groupEq.load(this.groupCurrent.eq)
    this.groupEqTarget.resetCompare()
    this.groupEqTarget.updateFields()
    this.updateGroupLabels()
    this.renderGroupMembers()
    if (this.mode === 'group') this.dispatchGroupPreview(this.groupCurrent)
    this.updateModeUI()
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
  renderGroupMembers() {
    this.els.mixGroupMembers.innerHTML = ''
    const preset = this.presets.find((p) => p.id === this.selectedPresetId)
    const group = this.groups.find((g) => g.id === this.selectedGroupId)
    if (!preset || !group) return
    const soundIds = [...new Set([...preset.sounds.map((s) => s.soundId), ...group.soundIds])]
    for (const soundId of soundIds) {
      const sound = this.library.find((s) => s.id === soundId)
      const label = document.createElement('label')
      label.className = 'editor-mix-group-member'
      const checkbox = document.createElement('input')
      checkbox.type = 'checkbox'
      checkbox.checked = group.soundIds.includes(soundId)
      checkbox.addEventListener('change', () => this.toggleGroupMember(soundId))
      const name = document.createElement('span')
      name.textContent = sound?.name ?? soundId
      label.appendChild(checkbox)
      label.appendChild(name)
      this.els.mixGroupMembers.appendChild(label)
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
  toggleGroupMember(soundId) {
    const presetId = this.selectedPresetId
    const groupId = this.selectedGroupId
    return this.queueGroupMutation(() => this._toggleGroupMemberNow(presetId, groupId, soundId))
  }

  // Shared serialization point for every write to a preset's groups array -
  // see toggleGroupMember's own comment for why this can't just be
  // toggleGroupMember's own private queue.
  queueGroupMutation(fn) {
    this._groupMemberQueue = (this._groupMemberQueue ?? Promise.resolve()).then(fn)
    return this._groupMemberQueue
  }

  async _toggleGroupMemberNow(presetId, groupId, soundId) {
    let wasAlreadyMember = false
    const updated = this.groups.map((g) => {
      if (g.id === groupId) {
        wasAlreadyMember = g.soundIds.includes(soundId)
        return { ...g, soundIds: wasAlreadyMember ? g.soundIds.filter((s) => s !== soundId) : [...g.soundIds, soundId] }
      }
      return { ...g, soundIds: g.soundIds.filter((s) => s !== soundId) }
    })
    const saved = await this.api.presets.updateGroups(presetId, updated)
    // Only touch this tab's own UI/state if the user hasn't since switched
    // to a different preset entirely - the write itself (and the broadcast
    // below, for the Mixer/other views) still always happens.
    if (presetId === this.selectedPresetId) {
      this.groups = saved?.groups ?? updated
      const local = this.presets.find((p) => p.id === presetId)
      if (local) local.groups = this.groups
      this.renderGroupSelectOptions()
      this.els.mixGroupSelect.value = this.selectedGroupId ?? ''
      this.renderGroupMembers()
    }
    // joinedSoundId: see the Mixer's identical sound-groups-changed
    // listener comment - only set on an actual add, so a removal never
    // gets misread as one.
    window.dispatchEvent(new CustomEvent('noctivago:sound-groups-changed', { detail: { presetId, joinedSoundId: wasAlreadyMember ? null : soundId } }))
  }

  writeGroupControls(filters) {
    this.els.mixGroupHighpass.value = String(filters.highpassHz)
    this.els.mixGroupLowpass.value = String(filters.lowpassHz)
    this.els.mixGroupGain.value = String(filters.gainDb)
    this.els.mixGroupPan.value = String(Math.round((filters.pan ?? 0) * 100))
    this.els.mixGroupEchoDelay.value = String(filters.echoDelayMs)
    this.els.mixGroupEchoDecay.value = String(filters.echoDecay)
    this.els.mixGroupReverbSize.value = String(filters.reverbSizeMs ?? 0)
    this.els.mixGroupReverbMix.value = String(filters.reverbMix ?? 0)
    this.els.mixGroupOcclusion.value = String(filters.occlusion ?? 0)
    this.writeMixFluctuation(filters.fluctuation, this.groupFlucEls)
  }

  readGroupControlsAndPreview() {
    this.groupCurrent = {
      ...this.groupCurrent,
      highpassHz: Number(this.els.mixGroupHighpass.value),
      lowpassHz: Number(this.els.mixGroupLowpass.value),
      gainDb: Number(this.els.mixGroupGain.value),
      pan: Number(this.els.mixGroupPan.value) / 100,
      echoDelayMs: Number(this.els.mixGroupEchoDelay.value),
      echoDecay: Number(this.els.mixGroupEchoDecay.value),
      reverbSizeMs: Number(this.els.mixGroupReverbSize.value),
      reverbMix: Number(this.els.mixGroupReverbMix.value),
      occlusion: Number(this.els.mixGroupOcclusion.value),
      fluctuation: this.readMixFluctuation(this.groupFlucEls)
    }
    this.updateGroupLabels()
    this.updateMixFlucEnabledUI(this.groupFlucEls)
    this.updateModeUI()
    if (this.mode === 'group') this.dispatchGroupPreview(this.groupCurrent)
  }

  setGroupEffectPreset(preset) {
    this.els.mixGroupHighpass.value = String(preset.highpassHz)
    this.els.mixGroupLowpass.value = String(preset.lowpassHz)
    this.els.mixGroupGain.value = String(preset.gainDb)
    this.els.mixGroupEchoDelay.value = String(preset.echoDelayMs ?? 0)
    this.els.mixGroupEchoDecay.value = String(preset.echoDecay ?? 0)
    this.els.mixGroupReverbSize.value = String(preset.reverbSizeMs ?? 0)
    this.els.mixGroupReverbMix.value = String(preset.reverbMix ?? 0)
  }

  updateGroupLabels() {
    const hp = Number(this.els.mixGroupHighpass.value)
    const lp = Number(this.els.mixGroupLowpass.value)
    const gain = Number(this.els.mixGroupGain.value)
    const echoDelay = Number(this.els.mixGroupEchoDelay.value)
    const echoDecay = Number(this.els.mixGroupEchoDecay.value)
    const reverbSize = Number(this.els.mixGroupReverbSize.value)
    const reverbMix = Number(this.els.mixGroupReverbMix.value)
    const occlusion = Number(this.els.mixGroupOcclusion.value)
    this.els.mixGroupHighpassValue.textContent = hp > 0 ? `${hp} Hz` : 'Off'
    this.els.mixGroupLowpassValue.textContent = lp < 20000 ? `${lp} Hz` : 'Off'
    this.els.mixGroupGainValue.textContent = `${gain > 0 ? '+' : ''}${gain} dB`
    this.els.mixGroupPanValue.textContent = formatPan(Number(this.els.mixGroupPan.value) / 100)
    this.els.mixGroupEchoDelayValue.textContent = echoDelay > 0 ? `${echoDelay} ms` : 'Off'
    this.els.mixGroupEchoDecayValue.textContent = echoDecay > 0 ? echoDecay.toFixed(2) : 'Off'
    this.els.mixGroupReverbSizeValue.textContent = reverbSize > 0 ? `${(reverbSize / 1000).toFixed(1)}s` : 'Off'
    this.els.mixGroupReverbMixValue.textContent = reverbMix > 0 ? `${Math.round(reverbMix * 100)}%` : 'Off'
    this.els.mixGroupOcclusionValue.textContent = occlusion > 0 ? `${Math.round(occlusion * 100)}%` : 'Off'
  }

  updateGroupDirty() {
    this.updateModeUI()
  }

  // saveGroup/deleteGroup/createGroup below all route their actual
  // read-this.groups-then-updateGroups work through queueGroupMutation too
  // (self-review v0.1.149) - each has the identical race toggleGroupMember
  // was fixed for (e.g. checking a membership box, then immediately hitting
  // Save on the group's filters before that toggle's own write lands would
  // otherwise have the second call's stale this.groups clobber the first).
  saveGroup() {
    if (!this.selectedGroupId || this._groupSaveInProgress) return Promise.resolve()
    return this.queueGroupMutation(() => this.saveGroupNow())
  }

  async saveGroupNow() {
    this._groupSaveInProgress = true
    this.els.mixSave.disabled = true
    try {
      const name = this.els.mixGroupName.value.trim() || 'Group'
      const updated = this.groups.map((g) => (g.id === this.selectedGroupId ? { ...g, name, filters: this.groupCurrent } : g))
      const saved = await this.api.presets.updateGroups(this.selectedPresetId, updated)
      this.groups = saved?.groups ?? updated
      const local = this.presets.find((p) => p.id === this.selectedPresetId)
      if (local) local.groups = this.groups
      const group = this.groups.find((g) => g.id === this.selectedGroupId)
      this.groupSaved = cloneGroupFilters(group?.filters ?? null)
      this.groupCurrent = cloneGroupFilters(this.groupSaved)
      this.els.mixGroupName.value = group?.name ?? name
      this.writeGroupControls(this.groupCurrent)
      this.groupEq.load(this.groupCurrent.eq)
      this.groupEqTarget.updateFields()
      this.groupEqTarget.updateBanner()
      this.updateGroupLabels()
      this.renderGroupSelectOptions()
      this.els.mixGroupSelect.value = this.selectedGroupId
      this.dispatchGroupPreview(this.groupSaved)
      window.dispatchEvent(new CustomEvent('noctivago:sound-groups-changed', { detail: { presetId: this.selectedPresetId } }))
      this.els.mixStatus.textContent = 'Saved.'
    } catch (err) {
      console.error('Editor: group save failed', err)
      this.els.mixStatus.textContent = `Save failed: ${err.message}`
    } finally {
      this._groupSaveInProgress = false
      this.updateModeUI()
    }
  }

  deleteGroup() {
    if (!this.selectedGroupId || !this.selectedPresetId) return Promise.resolve()
    return this.queueGroupMutation(() => this.deleteGroupNow())
  }

  async deleteGroupNow() {
    const id = this.selectedGroupId
    if (!id || !this.selectedPresetId) return
    const updated = this.groups.filter((g) => g.id !== id)
    const saved = await this.api.presets.updateGroups(this.selectedPresetId, updated)
    this.groups = saved?.groups ?? updated
    const local = this.presets.find((p) => p.id === this.selectedPresetId)
    if (local) local.groups = this.groups
    this.selectedGroupId = null
    this.els.mixGroupEditor.classList.add('hidden')
    this.els.mixGroupEmpty.classList.remove('hidden')
    this.renderGroupSelectOptions()
    this.els.mixGroupSelect.value = ''
    window.dispatchEvent(new CustomEvent('noctivago:sound-groups-changed', { detail: { presetId: this.selectedPresetId } }))
    this.updateModeUI()
  }

  createGroup() {
    if (!this.selectedPresetId) return Promise.resolve()
    return this.queueGroupMutation(() => this.createGroupNow())
  }

  async createGroupNow() {
    const updated = [...this.groups, { name: `Group ${this.groups.length + 1}`, soundIds: [], filters: cloneGroupFilters(null) }]
    const saved = await this.api.presets.updateGroups(this.selectedPresetId, updated)
    this.groups = saved?.groups ?? updated
    const local = this.presets.find((p) => p.id === this.selectedPresetId)
    if (local) local.groups = this.groups
    this.renderGroupSelectOptions()
    window.dispatchEvent(new CustomEvent('noctivago:sound-groups-changed', { detail: { presetId: this.selectedPresetId } }))
    const created = this.groups[this.groups.length - 1]
    if (created) this.selectGroup(created.id)
  }

  dispatchGroupPreview(filters) {
    if (!this.selectedPresetId || !this.selectedGroupId) return
    window.dispatchEvent(
      new CustomEvent('noctivago:sound-group-preview', {
        detail: { presetId: this.selectedPresetId, groupId: this.selectedGroupId, filters: cloneGroupFilters(filters) }
      })
    )
  }
}
