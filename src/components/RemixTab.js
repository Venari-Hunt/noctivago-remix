import { AudioEngine } from '../audio/AudioEngine.js'
import { PreviewSource } from '../audio/PreviewSource.js'
import { BakedClipPreview } from '../audio/BakedClipPreview.js'
import { createLoopEditorController } from './LoopEditor.js'
import { createSeamViewController } from './SeamView.js'
import { createSpectralRepairController } from './SpectralRepairView.js'
import { formatHz, GOOD_NOISE_SEC, noiseBandFromShape, normalizeRegions } from '../domain/spectralLayout.js'
import { toolHint } from '../domain/repairBrush.js'
import { loopLayout, clipToSource, sourceToClip } from '../domain/loopLayout.js'
import { createEqTarget, eqElements } from './useEqTarget.js'
import { createEqEditorController, Q_MIN, Q_MAX, SLOPE_CAPABLE_EQ_TYPES } from './EqEditor.js'
import { createWaveformScrollbar } from './WaveformScrollbar.js'
import { createFluctuationBar } from './FluctuationBar.js'
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
import { filterPickerSounds, stepHighlight, enterPick } from '../domain/pickerList.js'
import { previewModeToggleState, mustFallBackToLive } from '../domain/previewMode.js'
import { loadedFluctuation, fluctuationFingerprint, isFluctuationDirty, groupDriftFor, groupOverrideNotes } from '../domain/driftState.js'
import { saveButtonState } from '../domain/saveState.js'
import { createAutosave } from '../domain/autosave.js'
import { createCompare } from '../domain/compareView.js'
import { createHistory } from '../domain/editorHistory.js'
import { MAX_BUFFER_CLIP_SECONDS, applySoundOverride, DEFAULT_CROSSFADE_MS, SEAM_LEAD_SECONDS, SEAM_TAIL_SECONDS, HISTORY_COMMIT_DEBOUNCE_MS, HISTORY_LIMIT, AUTOSAVE_IDLE_MS, defaultEqBands, defaultVolumeEnvelope, NEUTRAL_FILTERS, FLUC_VOL_MIN, FLUC_VOL_MAX, FLUC_PITCH_MIN, FLUC_PITCH_MAX, FLUC_PAN_MIN, FLUC_PAN_MAX, PAN_DRIFT_DEFAULTS, formatPan, defaultFluctuation, defaultScatter, defaultSchedule, defaultSpeedPitch, FILTER_PRESETS, NEUTRAL_WHOLE_MIX, NEUTRAL_GROUP_FILTERS, defaultMixFluctuation, flucSeconds, SHOT_AXES, shotBiasDefault, SHOT_AXIS_NAMES, cloneWholeMix, wholeMixEqual, cloneGroupFilters, groupFiltersEqual } from '../domain/mixSettings.js'
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
    this.previewSource = null
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
    this.bakedPreview = null
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
      isBusy: () => !!this._saveInProgress,
      save: () => this.save({ trigger: 'auto' }),
      onError: (err) => console.error('Editor: autosave failed', err)
    })
    this._saveInProgress = false
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
    if (this._saveInProgress || this._groupSaveInProgress) return true
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

    this.els = {
      soundSearch: container.querySelector('#editor-sound-search'),
      soundOptions: container.querySelector('#editor-sound-options'),
      panel: container.querySelector('#editor-panel'),
      empty: container.querySelector('#editor-empty'),
      soundName: container.querySelector('#editor-sound-name'),
      syncGroupRow: container.querySelector('#editor-sync-group-row'),
      canvas: container.querySelector('#editor-canvas'),
      scrollbarTrack: container.querySelector('#editor-scrollbar'),
      scrollbarThumb: container.querySelector('#editor-scrollbar-thumb'),
      waveformStatus: container.querySelector('#editor-waveform-status'),
      needleInput: container.querySelector('#editor-needle-input'),
      startInput: container.querySelector('#editor-start-input'),
      endInput: container.querySelector('#editor-end-input'),
      lengthInput: container.querySelector('#editor-length-input'),
      suggestLoopBtn: container.querySelector('#editor-suggest-loop'),
      suggestStatus: container.querySelector('#editor-suggest-status'),
      playModeLoop: container.querySelector('#editor-playmode-loop'),
      playModeScatter: container.querySelector('#editor-playmode-scatter'),
      playModeScheduled: container.querySelector('#editor-playmode-scheduled'),
      fadeSection: container.querySelector('#editor-fade-section'),
      scatterFadeFields: container.querySelector('#editor-scatter-fade-fields'),
      scatterFadeEnabled: container.querySelector('#editor-scatter-fade-enabled'),
      scheduleFadeFields: container.querySelector('#editor-schedule-fade-fields'),
      scheduleFadeEnabled: container.querySelector('#editor-schedule-fade-enabled'),
      crossfadeSection: container.querySelector('#editor-crossfade-section'),
      crossfade: container.querySelector('#editor-crossfade'),
      crossfadeValue: container.querySelector('#editor-crossfade-value'),
      seamListen: container.querySelector('#editor-seam-listen'),
      seamCanvas: container.querySelector('#editor-seam-canvas'),
      seamStatus: container.querySelector('#editor-seam-status'),
      envelopeEnabled: container.querySelector('#editor-envelope-enabled'),
      envelopeReset: container.querySelector('#editor-envelope-reset'),
      spectralSection: container.querySelector('#editor-spectral-section'),
      spectralCanvas: container.querySelector('#editor-spectral-canvas'),
      spectralShape: container.querySelector('#editor-spectral-shape'),
      spectralDelete: container.querySelector('#editor-spectral-delete'),
      spectralClear: container.querySelector('#editor-spectral-clear'),
      spectralUseNoise: container.querySelector('#editor-spectral-use-noise'),
      spectralHint: container.querySelector('#editor-spectral-hint'),
      spectralLegendNoise: container.querySelector('#editor-spectral-legend-noise'),
      spectralLegendNoiseText: container.querySelector('#editor-spectral-legend-noise-text'),
      spectralSelection: container.querySelector('#editor-spectral-selection'),
      spectralReduction: container.querySelector('#editor-spectral-reduction'),
      spectralReductionValue: container.querySelector('#editor-spectral-reduction-value'),
      scatterSection: container.querySelector('#editor-scatter-section'),
      scatterGapMin: container.querySelector('#editor-scatter-gap-min'),
      scatterGapMax: container.querySelector('#editor-scatter-gap-max'),
      scatterGapFullyRandom: container.querySelector('#editor-scatter-gap-fully-random'),
      scatterGapBiasEnabled: container.querySelector('#editor-scatter-gap-bias-enabled'),
      scatterGapBias: container.querySelector('#editor-scatter-gap-bias'),
      scatterPitchBar: container.querySelector('#editor-scatter-pitch-bar'),
      scatterPitchFullyRandom: container.querySelector('#editor-scatter-pitch-fully-random'),
      scatterPitchBiasEnabled: container.querySelector('#editor-scatter-pitch-bias-enabled'),
      scatterVolumeBar: container.querySelector('#editor-scatter-volume-bar'),
      scatterVolumeFullyRandom: container.querySelector('#editor-scatter-volume-fully-random'),
      scatterVolumeBiasEnabled: container.querySelector('#editor-scatter-volume-bias-enabled'),
      scatterPanBar: container.querySelector('#editor-scatter-pan-bar'),
      scatterPanFullyRandom: container.querySelector('#editor-scatter-pan-fully-random'),
      scatterPanBiasEnabled: container.querySelector('#editor-scatter-pan-bias-enabled'),
      scatterGroupNote: container.querySelector('#editor-scatter-group-note'),
      scatterSpeedBar: container.querySelector('#editor-scatter-speed-bar'),
      scatterSpeedFullyRandom: container.querySelector('#editor-scatter-speed-fully-random'),
      scatterSpeedBiasEnabled: container.querySelector('#editor-scatter-speed-bias-enabled'),
      scatterFadeIn: container.querySelector('#editor-scatter-fade-in'),
      scatterFadeOut: container.querySelector('#editor-scatter-fade-out'),
      scatterSyncGroup: container.querySelector('#editor-scatter-sync-group'),
      scheduleSection: container.querySelector('#editor-schedule-section'),
      scheduleTypeTimes: container.querySelector('#editor-schedule-type-times'),
      scheduleTypeInterval: container.querySelector('#editor-schedule-type-interval'),
      scheduleTimesRow: container.querySelector('#editor-schedule-times-row'),
      scheduleTimes: container.querySelector('#editor-schedule-times'),
      scheduleIntervalRow: container.querySelector('#editor-schedule-interval-row'),
      scheduleInterval: container.querySelector('#editor-schedule-interval'),
      schedulePitchBar: container.querySelector('#editor-schedule-pitch-bar'),
      schedulePitchFullyRandom: container.querySelector('#editor-schedule-pitch-fully-random'),
      schedulePitchBiasEnabled: container.querySelector('#editor-schedule-pitch-bias-enabled'),
      scheduleVolumeBar: container.querySelector('#editor-schedule-volume-bar'),
      scheduleVolumeFullyRandom: container.querySelector('#editor-schedule-volume-fully-random'),
      scheduleVolumeBiasEnabled: container.querySelector('#editor-schedule-volume-bias-enabled'),
      schedulePanBar: container.querySelector('#editor-schedule-pan-bar'),
      schedulePanFullyRandom: container.querySelector('#editor-schedule-pan-fully-random'),
      schedulePanBiasEnabled: container.querySelector('#editor-schedule-pan-bias-enabled'),
      scheduleGroupNote: container.querySelector('#editor-schedule-group-note'),
      scheduleSpeedBar: container.querySelector('#editor-schedule-speed-bar'),
      scheduleSpeedFullyRandom: container.querySelector('#editor-schedule-speed-fully-random'),
      scheduleSpeedBiasEnabled: container.querySelector('#editor-schedule-speed-bias-enabled'),
      scheduleFadeIn: container.querySelector('#editor-schedule-fade-in'),
      scheduleFadeOut: container.querySelector('#editor-schedule-fade-out'),
      speed: container.querySelector('#editor-speed'),
      speedValue: container.querySelector('#editor-speed-value'),
      pitch: container.querySelector('#editor-pitch'),
      pitchValue: container.querySelector('#editor-pitch-value'),
      reverse: container.querySelector('#editor-reverse'),
      reverseStatus: container.querySelector('#editor-reverse-status'),
      doppler: container.querySelector('#editor-doppler'),
      dopplerHint: container.querySelector('#editor-doppler-hint'),
      dopplerOptions: container.querySelector('#editor-doppler-options'),
      dopplerIntensity: container.querySelector('#editor-doppler-intensity'),
      dopplerIntensityValue: container.querySelector('#editor-doppler-intensity-value'),
      dopplerSharpness: container.querySelector('#editor-doppler-sharpness'),
      dopplerSharpnessValue: container.querySelector('#editor-doppler-sharpness-value'),
      dopplerReversed: container.querySelector('#editor-doppler-reversed'),
      filters: container.querySelector('#editor-filters'),
      eqCanvas: container.querySelector('#editor-eq-canvas'),
      eqReset: container.querySelector('#editor-eq-reset'),
      eqAddBand: container.querySelector('#editor-eq-add-band'),
      eqRemoveBand: container.querySelector('#editor-eq-remove-band'),
      eqZoomIn: container.querySelector('#editor-eq-zoom-in'),
      eqZoomOut: container.querySelector('#editor-eq-zoom-out'),
      eqInvert: container.querySelector('#editor-eq-invert'),
      eqCompareA: container.querySelector('#editor-eq-compare-a'),
      eqCompareB: container.querySelector('#editor-eq-compare-b'),
      eqRevertBanner: container.querySelector('#editor-eq-revert-banner'),
      eqType: container.querySelector('#editor-eq-type'),
      eqSlope: container.querySelector('#editor-eq-slope'),
      eqSlopeLabel: container.querySelector('#editor-eq-slope-label'),
      eqFreq: container.querySelector('#editor-eq-freq'),
      eqGain: container.querySelector('#editor-eq-gain'),
      eqQ: container.querySelector('#editor-eq-q'),
      eqMute: container.querySelector('#editor-eq-mute'),
      eqSolo: container.querySelector('#editor-eq-solo'),
      resetFilters: container.querySelector('#editor-reset-filters'),
      presetButtons: container.querySelectorAll('[data-preset]'),
      fluctuationSavedNote: container.querySelector('#editor-fluctuation-saved-note'),
      flucVolEnabled: container.querySelector('#editor-fluc-vol-enabled'),
      flucVolBar: container.querySelector('#editor-fluc-vol-bar'),
      flucVolChangeMin: container.querySelector('#editor-fluc-vol-changemin'),
      flucVolChangeMax: container.querySelector('#editor-fluc-vol-changemax'),
      flucVolTransition: container.querySelector('#editor-fluc-vol-transition'),
      flucVolFullRandom: container.querySelector('#editor-fluc-vol-fullrandom'),
      flucPitchEnabled: container.querySelector('#editor-fluc-pitch-enabled'),
      flucPitchBar: container.querySelector('#editor-fluc-pitch-bar'),
      flucPitchChangeMin: container.querySelector('#editor-fluc-pitch-changemin'),
      flucPitchChangeMax: container.querySelector('#editor-fluc-pitch-changemax'),
      flucPitchTransition: container.querySelector('#editor-fluc-pitch-transition'),
      flucPitchFullRandom: container.querySelector('#editor-fluc-pitch-fullrandom'),
      flucPanEnabled: container.querySelector('#editor-fluc-pan-enabled'),
      flucGroupNote: container.querySelector('#editor-fluc-group-note'),
      flucVolBias: container.querySelector('#editor-fluc-vol-bias'),
      flucPitchBias: container.querySelector('#editor-fluc-pitch-bias'),
      flucPanBias: container.querySelector('#editor-fluc-pan-bias'),
      flucPanBar: container.querySelector('#editor-fluc-pan-bar'),
      flucPanChangeMin: container.querySelector('#editor-fluc-pan-changemin'),
      flucPanChangeMax: container.querySelector('#editor-fluc-pan-changemax'),
      flucPanTransition: container.querySelector('#editor-fluc-pan-transition'),
      flucPanFullRandom: container.querySelector('#editor-fluc-pan-fullrandom'),
      saveStatus: container.querySelector('#editor-save-status'),
      scrollTop: container.querySelector('#editor-scroll-top'),
      leaveConfirmDialog: container.querySelector('#editor-leave-confirm'),
      leaveConfirmYes: container.querySelector('#editor-leave-confirm-yes'),
      leaveConfirmNo: container.querySelector('#editor-leave-confirm-no'),
      leaveConfirmDontAsk: container.querySelector('#editor-leave-confirm-dont-ask'),

      // --- Preset mode / Group mode (v0.1.147) ---
      modeSound: container.querySelector('#editor-mode-sound'),
      modePreset: container.querySelector('#editor-mode-preset'),
      modeGroup: container.querySelector('#editor-mode-group'),
      modeHint: container.querySelector('#editor-mode-hint'),
      modePanelSound: container.querySelector('#editor-mode-panel-sound'),
      modePanelPreset: container.querySelector('#editor-mode-panel-preset'),
      modePanelGroup: container.querySelector('#editor-mode-panel-group'),
      mixPickerRow: container.querySelector('#editor-mix-picker-row'),
      mixPresetSelect: container.querySelector('#editor-mix-preset-select'),
      mixGroupSelectLabel: container.querySelector('#editor-mix-group-select-label'),
      mixGroupSelect: container.querySelector('#editor-mix-group-select'),
      mixGroupNew: container.querySelector('#editor-mix-group-new'),

      mixPresetControls: container.querySelector('#editor-mix-preset-controls'),
      mixPresetHighpass: container.querySelector('#editor-mix-preset-highpass'),
      mixPresetHighpassValue: container.querySelector('#editor-mix-preset-highpass-value'),
      mixPresetLowpass: container.querySelector('#editor-mix-preset-lowpass'),
      mixPresetLowpassValue: container.querySelector('#editor-mix-preset-lowpass-value'),
      mixPresetGain: container.querySelector('#editor-mix-preset-gain'),
      mixPresetGainValue: container.querySelector('#editor-mix-preset-gain-value'),
      mixPresetEchoDelay: container.querySelector('#editor-mix-preset-echo-delay'),
      mixPresetEchoDelayValue: container.querySelector('#editor-mix-preset-echo-delay-value'),
      mixPresetEchoDecay: container.querySelector('#editor-mix-preset-echo-decay'),
      mixPresetEchoDecayValue: container.querySelector('#editor-mix-preset-echo-decay-value'),
      mixPresetReverbSize: container.querySelector('#editor-mix-preset-reverb-size'),
      mixPresetReverbSizeValue: container.querySelector('#editor-mix-preset-reverb-size-value'),
      mixPresetReverbMix: container.querySelector('#editor-mix-preset-reverb-mix'),
      mixPresetReverbMixValue: container.querySelector('#editor-mix-preset-reverb-mix-value'),
      mixPresetFadeIn: container.querySelector('#editor-mix-preset-fadein'),
      mixPresetWaveform: container.querySelector('#editor-mix-preset-waveform'),
      mixPresetResetFilters: container.querySelector('#editor-mix-preset-reset-filters'),
      mixPresetEffectButtons: container.querySelectorAll('[data-mix-preset-effect]'),
      mixPresetHint: container.querySelector('#editor-mix-preset-hint'),
      mixPresetFlucEnabled: container.querySelector('#editor-mix-preset-fluc-enabled'),
      mixPresetFlucBias: container.querySelector('#editor-mix-preset-fluc-bias'),
      mixPresetFlucBar: container.querySelector('#editor-mix-preset-fluc-bar'),
      mixPresetFlucChangeMin: container.querySelector('#editor-mix-preset-fluc-changemin'),
      mixPresetFlucChangeMax: container.querySelector('#editor-mix-preset-fluc-changemax'),
      mixPresetFlucTransition: container.querySelector('#editor-mix-preset-fluc-transition'),
      mixPresetFlucFullRandom: container.querySelector('#editor-mix-preset-fluc-fullrandom'),

      mixGroupEditor: container.querySelector('#editor-mix-group-editor'),
      mixGroupEmpty: container.querySelector('#editor-mix-group-empty'),
      mixGroupName: container.querySelector('#editor-mix-group-name'),
      mixGroupMembers: container.querySelector('#editor-mix-group-members'),
      mixGroupWaveform: container.querySelector('#editor-mix-group-waveform'),
      mixGroupHighpass: container.querySelector('#editor-mix-group-highpass'),
      mixGroupHighpassValue: container.querySelector('#editor-mix-group-highpass-value'),
      mixGroupLowpass: container.querySelector('#editor-mix-group-lowpass'),
      mixGroupLowpassValue: container.querySelector('#editor-mix-group-lowpass-value'),
      mixGroupGain: container.querySelector('#editor-mix-group-gain'),
      mixGroupGainValue: container.querySelector('#editor-mix-group-gain-value'),
      mixGroupPan: container.querySelector('#editor-mix-group-pan'),
      mixGroupPanValue: container.querySelector('#editor-mix-group-pan-value'),
      mixGroupEchoDelay: container.querySelector('#editor-mix-group-echo-delay'),
      mixGroupEchoDelayValue: container.querySelector('#editor-mix-group-echo-delay-value'),
      mixGroupEchoDecay: container.querySelector('#editor-mix-group-echo-decay'),
      mixGroupEchoDecayValue: container.querySelector('#editor-mix-group-echo-decay-value'),
      mixGroupReverbSize: container.querySelector('#editor-mix-group-reverb-size'),
      mixGroupReverbSizeValue: container.querySelector('#editor-mix-group-reverb-size-value'),
      mixGroupReverbMix: container.querySelector('#editor-mix-group-reverb-mix'),
      mixGroupReverbMixValue: container.querySelector('#editor-mix-group-reverb-mix-value'),
      mixGroupOcclusion: container.querySelector('#editor-mix-group-occlusion'),
      mixGroupOcclusionValue: container.querySelector('#editor-mix-group-occlusion-value'),
      mixGroupResetFilters: container.querySelector('#editor-mix-group-reset-filters'),
      mixGroupEffectButtons: container.querySelectorAll('[data-mix-group-effect]'),
      mixGroupFlucEnabled: container.querySelector('#editor-mix-group-fluc-enabled'),
      mixGroupFlucBar: container.querySelector('#editor-mix-group-fluc-bar'),
      mixGroupFlucChangeMin: container.querySelector('#editor-mix-group-fluc-changemin'),
      mixGroupFlucChangeMax: container.querySelector('#editor-mix-group-fluc-changemax'),
      mixGroupFlucTransition: container.querySelector('#editor-mix-group-fluc-transition'),
      mixGroupFlucFullRandom: container.querySelector('#editor-mix-group-fluc-fullrandom'),
      mixGroupFlucBias: container.querySelector('#editor-mix-group-fluc-bias'),
      mixGroupFlucPerSound: container.querySelector('#editor-mix-group-fluc-persound'),
      mixGroupFlucPitchEnabled: container.querySelector('#editor-mix-group-flucpitch-enabled'),
      mixGroupFlucPitchBar: container.querySelector('#editor-mix-group-flucpitch-bar'),
      mixGroupFlucPitchChangeMin: container.querySelector('#editor-mix-group-flucpitch-changemin'),
      mixGroupFlucPitchChangeMax: container.querySelector('#editor-mix-group-flucpitch-changemax'),
      mixGroupFlucPitchTransition: container.querySelector('#editor-mix-group-flucpitch-transition'),
      mixGroupFlucPitchFullRandom: container.querySelector('#editor-mix-group-flucpitch-fullrandom'),
      mixGroupFlucPitchBias: container.querySelector('#editor-mix-group-flucpitch-bias'),
      mixGroupFlucPitchPerSound: container.querySelector('#editor-mix-group-flucpitch-persound'),
      mixGroupFlucPanBias: container.querySelector('#editor-mix-group-flucpan-bias'),
      mixGroupFlucPanPerSound: container.querySelector('#editor-mix-group-flucpan-persound'),
      mixGroupFlucPanEnabled: container.querySelector('#editor-mix-group-flucpan-enabled'),
      mixGroupFlucPanBar: container.querySelector('#editor-mix-group-flucpan-bar'),
      mixGroupFlucPanChangeMin: container.querySelector('#editor-mix-group-flucpan-changemin'),
      mixGroupFlucPanChangeMax: container.querySelector('#editor-mix-group-flucpan-changemax'),
      mixGroupFlucPanTransition: container.querySelector('#editor-mix-group-flucpan-transition'),
      mixGroupFlucPanFullRandom: container.querySelector('#editor-mix-group-flucpan-fullrandom')
    }

    this.loopEditorController = createLoopEditorController(this.els.canvas)
    this.loopEditorController.onLoopChange(({ loopStart, loopEnd }) => {
      this.commitLoopPoints(loopStart, loopEnd)
    })
    this.spectralView = createSpectralRepairController(this.els.spectralCanvas)
    this.spectralView.onChange(() => {
      this.updateSpectralControls()
      this.applyFilterControls()
    })
    this.spectralView.onSelect(() => this.updateSpectralControls())
    this.spectralView.onToolChange(() => this.syncSpectralTool())
    this.syncSpectralTool()
    for (const view of [this.loopEditorController, this.spectralView]) {
      view.onMarkersChange((list) => this.setMarkers(list))
      view.onMarkerEdit((marker, x, y) => this.editMarker(marker, x, y))
    }
    // The Spectrum tab is hidden until opened, so the first fetch has to wait for a real size.
    this.spectralView.onResize(() => this.syncSpectralView())
    // Dragging the needle seeks the preview (playing or paused).
    this.spectralView.onSeek((sec) => {
      const active = this.activePreview()
      if (!active) return
      const t = this.previewMode === 'saved' ? this.sourceTimeToClip(sec) : sec
      active.scrubTo(t)
      this.spectralView.setPlayhead(sec)
      this.loopEditorController?.setPlayhead(sec)
      this.updateStickyProgress(t)
    })
    // A number field now: half-typed values wait, change clamps to 6-80 dB.
    const reductionDb = () => {
      const v = Number(this.els.spectralReduction.value)
      return Number.isFinite(v) ? Math.min(80, Math.max(6, Math.round(v))) : null
    }
    this.els.spectralReduction.addEventListener('input', () => {
      const v = Number(this.els.spectralReduction.value)
      if (Number.isFinite(v) && v >= 6 && v <= 80) this.spectralView.setSelectedReduction(Math.round(v))
    })
    this.els.spectralReduction.addEventListener('change', () => {
      const db = reductionDb() ?? 40
      this.els.spectralReduction.value = String(db)
      this.spectralView.setSelectedReduction(db)
    })
    this.els.spectralShape.addEventListener('click', (evt) => {
      const btn = evt.target.closest('[data-shape]')
      if (!btn) return
      this.setSpectralTool(btn.dataset.shape)
    })
    // The Noise sample band: dragging it moves the From/To fields live and
    // applies once the drag ends, the same as typing them.
    this.spectralView.onNoiseChange(({ startSec, endSec, final }) => {
      this.filterControls.setValues({ denoiseSampleStartSec: startSec, denoiseSampleEndSec: endSec, ...(final ? { denoiseEnabled: true } : {}) })
      if (final) this.applyFilterControls()
    })
    // The same band drawn on the Trim waveform: dragging it there works like the spectrogram band.
    this.loopEditorController.onNoiseSampleChange(({ startSec, endSec, final }) => {
      this.filterControls.setValues({ denoiseSampleStartSec: startSec, denoiseSampleEndSec: endSec, ...(final ? { denoiseEnabled: true } : {}) })
      if (final) this.applyFilterControls()
    })
    this.els.spectralUseNoise.addEventListener('click', () => this.useShapeAsNoiseSample())
    this.els.spectralDelete.addEventListener('click', () => this.spectralView.removeSelected())
    this.els.spectralClear.addEventListener('click', () => this.spectralView.clear())
    // Needs app 0.1.237's getSpectrogram; hide the panel on an older app
    // rather than show a box that can never fill in.
    this.els.spectralSection.classList.toggle('hidden', typeof this.api.audio.getSpectrogram !== 'function')
    this.seamView = createSeamViewController(this.els.seamCanvas)
    this.seamView.setLimits({
      maxSeconds: Number(this.els.crossfade.max) / 1000,
      stepSeconds: Number(this.els.crossfade.step) / 1000,
      defaultSeconds: DEFAULT_CROSSFADE_MS / 1000
    })
    this.seamView.onCrossfadeChange((seconds) => {
      this.els.crossfade.value = String(Math.round(seconds * 1000))
      this.applyCrossfadeControl()
    })
    this.seamView.onViewportChange((sourceRanges) => {
      this.scheduleSeamDetailPeaks(sourceRanges)
    })
    this.seamView.onScrub((liveClipTime) => {
      const source = clipToSource(this.liveLayout(), liveClipTime)
      if (this.previewMode === 'saved' && this.bakedPreview) {
        const clipTime = this.sourceTimeToClip(source)
        this.bakedPreview.scrubTo(clipTime)
        this.updateStickyProgress(clipTime)
      } else {
        this.previewSource?.scrubTo(source)
        this.updateStickyProgress(source)
      }
      this.loopEditorController.setPlayhead(source)
    })
    this.loopEditorController.onScrub((t) => {
      if (this.previewMode === 'saved' && this.bakedPreview) {
        const clipTime = this.sourceTimeToClip(t)
        this.bakedPreview.scrubTo(clipTime)
        this.updateStickyProgress(clipTime)
      } else {
        this.previewSource?.scrubTo(t)
      }
    })
    // Dragging (or double-click-resetting) the Doppler "closest point"
    // marker - the preview already follows the Doppler curve (see
    // PreviewSource._updatePitch), just the dirty-check/history hook every
    // other field-change handler already ends with.
    this.loopEditorController.onDopplerChange(() => this.updateSaveButtonState())
    // Dragging a fade handle (see waveform.js's corner pins) writes straight
    // back into whichever numeric field is currently showing (scatter vs.
    // scheduled - the two can't both be active) so the precision text
    // inputs and the visual drag stay the same single source of truth in
    // both directions, same pattern onLoopChange already sets for Start/End.
    this.loopEditorController.onFadesChange(({ fadeInSec, fadeOutSec }) => {
      const fadeInMs = Math.round(fadeInSec * 1000)
      const fadeOutMs = Math.round(fadeOutSec * 1000)
      const playMode = this.currentPlayMode()
      if (playMode === 'scatter') {
        this.els.scatterFadeIn.value = String(fadeInMs)
        this.els.scatterFadeOut.value = String(fadeOutMs)
        this.syncFadeToggle(this.els.scatterFadeEnabled, this.els.scatterFadeIn, this.els.scatterFadeOut)
      } else if (playMode === 'scheduled') {
        this.els.scheduleFadeIn.value = String(fadeInMs)
        this.els.scheduleFadeOut.value = String(fadeOutMs)
        this.syncFadeToggle(this.els.scheduleFadeEnabled, this.els.scheduleFadeIn, this.els.scheduleFadeOut)
      }
      this.updateSaveButtonState()
    })
    // Dragging/adding/removing/resetting an envelope point - volumeEnvelope
    // lives inside `filters` (see currentFilters()), so this goes through
    // the exact same live-preview + dirty-check path every other filter
    // control already uses, not a bespoke one like fades above.
    this.loopEditorController.onEnvelopeChange(() => this.applyFilterControls())

    this.eqEditorController = createEqEditorController(this.els.eqCanvas)
    this.eqEditorController.onChange(() => this.applyEqControls())
    this.eqEditorController.onNeedLive(() => {
      if (this.previewMode === 'saved') this.togglePreviewMode()
    })
    // Double-click and Alt+click used to fire the identical full reset -
    // split apart after direct feedback ("double clicking shouldn't reset
    // the node completely just position. Alt clicking should be the full
    // reset"). There's no longer a canonical "default" per node to reset
    // *back to* (bands are user-added now, not a fixed preset set - see
    // library.js's defaultEqBands()), so both are redefined as "what does
    // resetting a node mean when there's nothing to reset it back to":
    // double-click resets just gainDb to 0 (the node's vertical "position"
    // on the graph, the literal reading of "just position"); Alt+click is
    // the fuller reset - gainDb:0, q:1, type back to 'peaking' - while still
    // preserving the node's own frequency, its horizontal identity, not
    // something a reset should relocate.
    this.eqEditorController.onDoubleClick((index) => {
      this.eqEditorController.setSelectedIndex(index)
      this.eqEditorController.setSelectedBand({ gainDb: 0 })
      this.applyEqControls()
    })
    this.eqEditorController.onAltClick((index) => {
      this.eqEditorController.setSelectedIndex(index)
      this.eqEditorController.setSelectedBand({ gainDb: 0, q: 1, type: 'peaking', slope: 'gentle' })
      this.applyEqControls()
    })

    this.waveformScrollbar = createWaveformScrollbar(this.els.scrollbarTrack, this.els.scrollbarThumb)
    this.waveformScrollbar.onNavigate((start, end) => this.loopEditorController.setViewport(start, end))
    this.loopEditorController.onViewportChange(({ viewStart, viewEnd, duration }) => {
      this.waveformScrollbar.update(duration, viewStart, viewEnd)
      this.maybeFetchDetailPeaks(viewStart, viewEnd, duration)
    })

    wireNameMarquee(this.els.soundName)
    this.wireControls()
    this.wireScrollTop()
    this.wireLeaveConfirmDialog()
    this.refreshLibrary().catch((err) => console.error('Editor: failed to load library', err))

    // Same real EqEditor.js module Sound mode uses (2026-09-06: the owner's
    // own direction - "the same module... everything else should be kept" -
    // rather than the old scoped-down WholeMixEqEditor.js, which is now
    // deleted). It's a plain canvas-scoped controller with no dependency on
    // a single preview source, so instantiating a second/third one for
    // Preset/Group mode is exactly as simple as Sound mode's own setup.
    this.presetEqTarget = createEqTarget({
      els: eqElements(this.root, 'editor-mix-preset-eq'),
      getSavedBands: () => this.wholeMixSaved.eq,
      onApply: (bands) => {
        this.wholeMixCurrent = { ...this.wholeMixCurrent, eq: bands }
        this.updateModeUI()
        if (this.mode === 'preset') this.dispatchWholeMixPreview(this.wholeMixCurrent)
      }
    })
    this.presetEq = this.presetEqTarget.eq
    this.groupEqTarget = createEqTarget({
      els: eqElements(this.root, 'editor-mix-group-eq'),
      getSavedBands: () => this.groupSaved.eq,
      onApply: (bands) => {
        this.groupCurrent = { ...this.groupCurrent, eq: bands }
        this.updateModeUI()
        if (this.mode === 'group') this.dispatchGroupPreview(this.groupCurrent)
      }
    })
    this.groupEq = this.groupEqTarget.eq

    // Fluctuation bars for Preset / Group mode (volume; Group also pan). onChange
    // writes the three handle values into this.wholeMixCurrent/groupCurrent
    // and re-runs the same read+preview path the sliders use.
    this.presetFlucBar = createFluctuationBar(this.els.mixPresetFlucBar, {
      valueMin: 0,
      valueMax: 1,
      defaults: { min: 0.5, bias: 0.8, max: 1 },
      format: (v) => `${Math.round(v * 100)}%`,
      onChange: (vals) => {
        this.wholeMixCurrent.fluctuation = { ...this.wholeMixCurrent.fluctuation, volume: { ...this.wholeMixCurrent.fluctuation.volume, ...vals } }
        this.readPresetMixControlsAndPreview()
      }
    })
    this.groupFlucBar = createFluctuationBar(this.els.mixGroupFlucBar, {
      valueMin: 0,
      valueMax: 1,
      defaults: { min: 0.5, bias: 0.8, max: 1 },
      format: (v) => `${Math.round(v * 100)}%`,
      onChange: (vals) => {
        this.groupCurrent.fluctuation = { ...this.groupCurrent.fluctuation, volume: { ...this.groupCurrent.fluctuation.volume, ...vals } }
        this.readGroupControlsAndPreview()
      }
    })
    this.groupFlucPitchBar = createFluctuationBar(this.els.mixGroupFlucPitchBar, {
      valueMin: FLUC_PITCH_MIN,
      valueMax: FLUC_PITCH_MAX,
      defaults: { min: -1, bias: 0, max: 1 },
      format: (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} st`,
      onChange: () => this.readGroupControlsAndPreview()
    })
    this.groupFlucPanBar = createFluctuationBar(this.els.mixGroupFlucPanBar, {
      valueMin: FLUC_PAN_MIN,
      valueMax: FLUC_PAN_MAX,
      defaults: PAN_DRIFT_DEFAULTS,
      format: formatPan,
      onChange: () => this.readGroupControlsAndPreview()
    })

    // Control bundles for the shared read/write/enabled-UI fluctuation
    // helpers (Preset + Group mode). Positional args got unwieldy once each
    // axis grew a min/max change-gap + a Fully-random toggle (v0.1.176).
    this.presetFlucEls = {
      enabledEl: this.els.mixPresetFlucEnabled,
      bar: this.presetFlucBar,
      changeMinEl: this.els.mixPresetFlucChangeMin,
      changeMaxEl: this.els.mixPresetFlucChangeMax,
      transEl: this.els.mixPresetFlucTransition,
      fullRandomEl: this.els.mixPresetFlucFullRandom,
      biasEl: this.els.mixPresetFlucBias
    }
    this.groupFlucEls = {
      enabledEl: this.els.mixGroupFlucEnabled,
      bar: this.groupFlucBar,
      changeMinEl: this.els.mixGroupFlucChangeMin,
      changeMaxEl: this.els.mixGroupFlucChangeMax,
      transEl: this.els.mixGroupFlucTransition,
      fullRandomEl: this.els.mixGroupFlucFullRandom,
      biasEl: this.els.mixGroupFlucBias,
      perSoundEl: this.els.mixGroupFlucPerSound,
      pitch: {
        enabledEl: this.els.mixGroupFlucPitchEnabled,
        bar: this.groupFlucPitchBar,
        changeMinEl: this.els.mixGroupFlucPitchChangeMin,
        changeMaxEl: this.els.mixGroupFlucPitchChangeMax,
        transEl: this.els.mixGroupFlucPitchTransition,
        fullRandomEl: this.els.mixGroupFlucPitchFullRandom,
        biasEl: this.els.mixGroupFlucPitchBias,
        perSoundEl: this.els.mixGroupFlucPitchPerSound,
        perSoundLocked: true
      },
      pan: {
        enabledEl: this.els.mixGroupFlucPanEnabled,
        bar: this.groupFlucPanBar,
        changeMinEl: this.els.mixGroupFlucPanChangeMin,
        changeMaxEl: this.els.mixGroupFlucPanChangeMax,
        transEl: this.els.mixGroupFlucPanTransition,
        fullRandomEl: this.els.mixGroupFlucPanFullRandom,
        biasEl: this.els.mixGroupFlucPanBias,
        perSoundEl: this.els.mixGroupFlucPanPerSound
      }
    }

    this.wireMixControls()
    this.refreshMixPanel().catch((err) => console.error('Editor: failed to load presets', err))
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

  wireControls() {
    this.els.soundSearch.addEventListener('focus', () => this.openPicker())

    this.els.soundSearch.addEventListener('input', () => {
      this.pickerQuery = this.els.soundSearch.value
      this.pickerHighlightIndex = -1
      this.openPicker()
    })

    this.els.soundSearch.addEventListener('keydown', (evt) => {
      const options = this.filteredPickerSounds()
      if (evt.key === 'ArrowDown') {
        evt.preventDefault()
        if (options.length === 0) return
        this.pickerHighlightIndex = stepHighlight(this.pickerHighlightIndex, options.length, 1)
        this.renderPickerOptions()
      } else if (evt.key === 'ArrowUp') {
        evt.preventDefault()
        if (options.length === 0) return
        this.pickerHighlightIndex = stepHighlight(this.pickerHighlightIndex, options.length, -1)
        this.renderPickerOptions()
      } else if (evt.key === 'Enter') {
        evt.preventDefault()
        // Defaults to the first result when nothing's been arrow-navigated
        // yet - requested directly: typing a precise search and hitting
        // Enter shouldn't need an extra arrow-down first, since a precise
        // query usually narrows straight down to the one sound you meant.
        const picked = enterPick(options, this.pickerHighlightIndex)
        if (picked) this.selectPickerSound(picked.id)
      } else if (evt.key === 'Escape') {
        this.closePicker()
        this.els.soundSearch.blur()
      }
    })

    // The option list's own mousedown handlers call preventDefault() (see
    // renderPickerOptions), which stops the input from ever losing focus on
    // an option click - so a plain blur here always means the user actually
    // clicked/tabbed away, never a false positive from picking an option.
    this.els.soundSearch.addEventListener('blur', () => this.closePicker())

    this.els.startInput.addEventListener('change', () => this.applyManualLoopPoints())
    this.els.endInput.addEventListener('change', () => this.applyManualLoopPoints())
    this.els.lengthInput.addEventListener('change', () => this.applyManualLength())
    this.els.needleInput.addEventListener('change', () => this.applyManualNeedle())
    this.els.needleInput.addEventListener('input', () => this.els.needleInput.removeAttribute('aria-invalid'))
    this.els.suggestLoopBtn.addEventListener('click', () => this.suggestLoopPoint())

    this.els.playModeLoop.addEventListener('change', () => this.applyPlayModeControl())
    this.els.playModeScatter.addEventListener('change', () => this.applyPlayModeControl())
    this.els.playModeScheduled.addEventListener('change', () => this.applyPlayModeControl())
    this.els.scatterGapMin.addEventListener('input', () => this.applyScatterControls())
    this.els.scatterGapMax.addEventListener('input', () => this.applyScatterControls())
    this.els.scatterGapFullyRandom.addEventListener('change', () => this.applyScatterControls())
    this.els.scatterGapBiasEnabled.addEventListener('change', () => this.applyScatterControls())
    this.els.scatterGapBias.addEventListener('input', () => this.applyScatterControls())
    this.els.scatterFadeEnabled.addEventListener('change', () =>
      this.toggleFade(this.els.scatterFadeEnabled, this.els.scatterFadeIn, this.els.scatterFadeOut, () => this.applyScatterControls())
    )
    this.els.scatterFadeIn.addEventListener('input', () => {
      this.syncFadeToggle(this.els.scatterFadeEnabled, this.els.scatterFadeIn, this.els.scatterFadeOut)
      this.applyScatterControls()
    })
    this.els.scatterFadeOut.addEventListener('input', () => {
      this.syncFadeToggle(this.els.scatterFadeEnabled, this.els.scatterFadeIn, this.els.scatterFadeOut)
      this.applyScatterControls()
    })
    this.els.scatterSyncGroup.addEventListener('input', () => this.applyScatterControls())

    this.els.scheduleTypeTimes.addEventListener('change', () => this.applyScheduleControls())
    this.els.scheduleTypeInterval.addEventListener('change', () => this.applyScheduleControls())
    this.els.scheduleTimes.addEventListener('input', () => this.applyScheduleControls())
    this.els.scheduleInterval.addEventListener('input', () => this.applyScheduleControls())
    this.els.scheduleFadeEnabled.addEventListener('change', () =>
      this.toggleFade(this.els.scheduleFadeEnabled, this.els.scheduleFadeIn, this.els.scheduleFadeOut, () => this.applyScheduleControls())
    )
    this.els.scheduleFadeIn.addEventListener('input', () => {
      this.syncFadeToggle(this.els.scheduleFadeEnabled, this.els.scheduleFadeIn, this.els.scheduleFadeOut)
      this.applyScheduleControls()
    })
    this.els.scheduleFadeOut.addEventListener('input', () => {
      this.syncFadeToggle(this.els.scheduleFadeEnabled, this.els.scheduleFadeIn, this.els.scheduleFadeOut)
      this.applyScheduleControls()
    })

    this.els.crossfade.addEventListener('input', () => this.applyCrossfadeControl())
    this.els.seamListen.addEventListener('click', () =>
      this.toggleSeamListen().catch((err) => console.error('Editor: seam preview failed', err))
    )

    this.els.envelopeEnabled.addEventListener('change', () => {
      this.loopEditorController.setEnvelope(this.els.envelopeEnabled.checked, this.loopEditorController.getEnvelope().points)
      this.applyFilterControls()
    })
    this.els.envelopeReset.addEventListener('click', () => {
      this.loopEditorController.setEnvelope(this.els.envelopeEnabled.checked, defaultVolumeEnvelope().points)
      this.applyFilterControls()
    })

    this.els.speed.addEventListener('input', () => this.applySpeedPitchControls())
    this.els.pitch.addEventListener('input', () => this.applySpeedPitchControls())
    this.els.reverse.addEventListener('change', () => this.applySpeedPitchControls())
    this.els.doppler.addEventListener('change', () => this.applySpeedPitchControls())
    this.els.dopplerIntensity.addEventListener('input', () => this.applySpeedPitchControls())
    this.els.dopplerSharpness.addEventListener('input', () => this.applySpeedPitchControls())
    this.els.dopplerReversed.addEventListener('change', () => this.applySpeedPitchControls())

    // The filter sliders are a React island (src/islands/FilterControls.jsx,
    // the pilot for moving Remix's UI to React) - it owns their markup,
    // labels and values; this class reads/writes them through
    // filterControls.getValues()/setValues() only.
    this.filterControls = mountFilterControls(this.els.filters, {
      targets: this.layout.filterTargets,
      onChange: () => this.applyFilterControls(),
      onShowSampleChange: () => this.syncNoiseBand(),
      // "Mark noise sample": open the Repair view with the Noise sample tool; pressed again, back to the Brush.
      onMarkNoiseSample: () => {
        const on = this.spectralView.getShape() !== 'noise'
        this.setSpectralTool(on ? 'noise' : 'brush')
        if (on) this.layout.setView('spec')
      },
      onNoiseSampleFromLoop: () => {
        const { loopStart, loopEnd } = this.loopEditorController.getLoopPoints()
        const end = Math.min(loopEnd, loopStart + Math.min(1.5, (loopEnd - loopStart) / 3))
        this.filterControls.setValues({
          denoiseSampleStartSec: Number(loopStart.toFixed(2)),
          denoiseSampleEndSec: Number(end.toFixed(2)),
          denoiseEnabled: true
        })
        this.applyFilterControls()
      }
    })

    // 'input' (fires live, on every change) not 'change' (fires only on
    // blur/Enter) - matches every other numeric field in this app (Scatter
    // gap min/max, the core filter sliders). BUG FIX: these three were the
    // one place still using 'change', which meant the app-wide number-box
    // stepper (hover+scroll/arrow keys, see numberBoxStepper.js - it
    // dispatches 'input') silently never reached these fields at all -
    // adjusting Freq/Gain/Q via scroll or arrow keys updated the input's
    // raw displayed value but never touched the actual band, the node's
    // position on the graph, or the live audio, exactly matching a direct
    // bug report ("raising the frequency by the number doesn't change the
    // node's position and doesn't affect the audio").
    this.els.eqType.addEventListener('change', () => this.applyEqFieldsToSelectedBand())
    this.els.eqSlope.addEventListener('change', () => this.applyEqFieldsToSelectedBand())
    this.els.eqFreq.addEventListener('input', () => this.applyEqFieldsToSelectedBand())
    this.els.eqGain.addEventListener('input', () => this.applyEqFieldsToSelectedBand())
    this.els.eqQ.addEventListener('input', () => this.applyEqFieldsToSelectedBand())
    this.els.eqReset.addEventListener('click', () => {
      this.eqEditorController.load(defaultEqBands())
      this.updateEqFieldsFromSelection()
      this.applyEqControls()
    })

    this.els.eqAddBand.addEventListener('click', () => {
      this.eqEditorController.addBand()
      this.updateEqFieldsFromSelection()
      this.applyEqControls()
    })
    this.els.eqRemoveBand.addEventListener('click', () => {
      this.eqEditorController.removeSelectedBand()
      this.updateEqFieldsFromSelection()
      this.applyEqControls()
    })
    // Registers the trash button as a drag-and-drop target too - dragging a
    // node onto it deletes it, same as clicking it with a band selected
    // (see EqEditor.js's pointerUp).
    this.eqEditorController.setTrashDropTarget(this.els.eqRemoveBand)

    // Zoom in/out (also reachable via mouse wheel over empty graph space)
    // and Invert - both ported from Audacity's Filter Curve EQ. Invert
    // mutates every band's gain, so it needs the same field-refresh +
    // applyEqControls() pair every other band-mutating button already uses;
    // zoom is purely a view change, no band data touched, no refresh needed.
    this.els.eqZoomIn.addEventListener('click', () => this.eqEditorController.zoomIn())
    this.els.eqZoomOut.addEventListener('click', () => this.eqEditorController.zoomOut())
    this.els.eqInvert.addEventListener('click', () => {
      this.eqEditorController.invertBands()
      this.updateEqFieldsFromSelection()
      this.applyEqControls()
    })

    this.els.eqCompareA.addEventListener('click', () => this.switchEqCompareView('A'))
    this.els.eqCompareB.addEventListener('click', () => this.switchEqCompareView('B'))
    this.els.eqRevertBanner.addEventListener('click', () => this.revertEqToSaved())

    this.els.eqMute.addEventListener('click', () => {
      const idx = this.eqEditorController.getSelectedIndex()
      const band = this.eqEditorController.getSlots()[idx]
      if (!band) return
      this.eqEditorController.setSelectedBand({ muted: !band.muted })
      this.applyEqControls()
    })

    // Toggle: clicking Solo on the already-soloed band un-solos it (back to
    // "every band plays normally"), clicking it on a different band moves
    // solo there instead - only one band can be soloed at a time.
    this.els.eqSolo.addEventListener('click', () => {
      const idx = this.eqEditorController.getSelectedIndex()
      if (idx === -1) return
      const current = this.eqEditorController.getSoloIndex()
      this.eqEditorController.setSoloIndex(current === idx ? -1 : idx)
      this.applyEqControls()
    })

    this.els.resetFilters.addEventListener('click', () => {
      this.setFilterSliders(NEUTRAL_FILTERS)
      this.applyFilterControls()
    })

    for (const button of this.els.presetButtons) {
      button.addEventListener('click', () => {
        const preset = FILTER_PRESETS[button.dataset.preset]
        if (!preset) return
        this.setFilterSliders(preset)
        this.applyFilterControls()
      })
    }

    // --- Fluctuation (v0.1.164) ---
    // The two 3-circle bars. Unlike trim/filters/EQ, fluctuation is NOT part
    // of the snapshot/undo/autosave/A-B-compare machinery - it's a
    // playback-time behavior, never baked, so it persists on its own (a
    // debounced library.updateFluctuation) the moment a control settles,
    // and previews live without any ffmpeg round-trip.
    this.fluctuation = defaultFluctuation()
    this.flucVolBar = createFluctuationBar(this.els.flucVolBar, {
      valueMin: FLUC_VOL_MIN,
      valueMax: FLUC_VOL_MAX,
      defaults: { min: 0.5, bias: 0.8, max: 1 },
      format: (v) => `${Math.round(v * 100)}%`,
      onChange: (vals) => {
        this.fluctuation.volume = { ...this.fluctuation.volume, ...vals }
        this.applyFluctuationControls()
      }
    })
    this.flucPitchBar = createFluctuationBar(this.els.flucPitchBar, {
      valueMin: FLUC_PITCH_MIN,
      valueMax: FLUC_PITCH_MAX,
      defaults: { min: -1, bias: 0, max: 1 },
      format: (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} st`,
      onChange: (vals) => {
        this.fluctuation.pitch = { ...this.fluctuation.pitch, ...vals }
        this.applyFluctuationControls()
      }
    })
    this.flucPanBar = createFluctuationBar(this.els.flucPanBar, {
      valueMin: FLUC_PAN_MIN,
      valueMax: FLUC_PAN_MAX,
      defaults: PAN_DRIFT_DEFAULTS,
      format: formatPan,
      onChange: (vals) => {
        this.fluctuation.pan = { ...this.fluctuation.pan, ...vals }
        this.applyFluctuationControls()
      }
    })
    // Per-play random bars (v0.1.218) - Random Interval + Scheduled.
    this.shotBars = { scatter: {}, schedule: {} }
    for (const kind of ['scatter', 'schedule']) {
      for (const axis of SHOT_AXIS_NAMES) {
        const cfg = SHOT_AXES[axis]
        const key = `${kind}${axis[0].toUpperCase()}${axis.slice(1)}`
        this.shotBars[kind][axis] = createFluctuationBar(this.els[`${key}Bar`], {
          valueMin: cfg.lo,
          valueMax: cfg.hi,
          defaults: cfg.defaults,
          format: cfg.format,
          onChange: () => (kind === 'scatter' ? this.applyScatterControls() : this.applyScheduleControls())
        })
        for (const suffix of ['FullyRandom', 'BiasEnabled']) {
          this.els[`${key}${suffix}`].addEventListener('change', () =>
            kind === 'scatter' ? this.applyScatterControls() : this.applyScheduleControls()
          )
        }
      }
    }
    const flucInputs = [
      this.els.flucPanEnabled,
      this.els.flucPanFullRandom,
      this.els.flucPanChangeMin,
      this.els.flucPanChangeMax,
      this.els.flucPanTransition,
      this.els.flucPanBias,
      this.els.flucVolBias,
      this.els.flucPitchBias,
      this.els.flucVolEnabled,
      this.els.flucVolFullRandom,
      this.els.flucVolChangeMin,
      this.els.flucVolChangeMax,
      this.els.flucVolTransition,
      this.els.flucPitchEnabled,
      this.els.flucPitchFullRandom,
      this.els.flucPitchChangeMin,
      this.els.flucPitchChangeMax,
      this.els.flucPitchTransition
    ]
    for (const el of flucInputs) {
      el.addEventListener(el.type === 'checkbox' ? 'change' : 'input', () => this.applyFluctuationControls())
    }
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
    if (this.mode !== 'sound') return false
    const active = document.activeElement
    const typing = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT' || active.isContentEditable)
    if (typing) return false
    if (evt.ctrlKey && !evt.shiftKey && !evt.altKey && (evt.key === 'm' || evt.key === 'M')) {
      evt.preventDefault()
      this.addMarkerAtPlayhead()
      return true
    }
    if (evt.key === 'Delete' && evt.target !== this.els.spectralCanvas) {
      const id = this.loopEditorController?.getSelectedMarker?.()
      if (id != null) {
        evt.preventDefault()
        this.deleteMarker(id)
        return true
      }
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
      if (this._clipRebaking || this._saveInProgress || this.eqCompareViewing === 'B') return
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

  disposePreview() {
    this.stopSeamListen({ pause: false })
    this.stopPreviewTicking()
    this.autosave.cancel()
    this.flushFluctuation()
    this.eqEditorController?.clearSpectrum()
    this.previewMode = 'live'
    if (this.bakedPreview) {
      this.bakedPreview.dispose()
      this.bakedPreview = null
    }
    if (this.els.previewModeToggle) this.updatePreviewModeToggle()
    if (!this.previewSource) return
    this.previewSource.dispose()
    this.previewSource = null
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

  async loadSound(id) {
    this.leaveCompareView()
    clearTimeout(this.detailPeaksDebounceTimer)
    clearTimeout(this._seamDetailPeaksTimer)
    this.seamView?.resetZoom()
    const entry = this.library.find((s) => s.id === id)
    if (!entry) return
    // Solo is scoped to whichever sound was previously open, not the one
    // about to load - un-solo it first (targeting the old id) before
    // switching currentEntry, same "fresh load = fresh arrangement" logic
    // the EQ graph's own per-band Solo already uses.
    this.setSolo(false)
    this.currentEntry = entry
    // Per-preset sound overrides (planned 2026-09-12): pins which preset
    // this editing session's Save targets. `entry` (from this.library) is
    // already the *effective* view (baseline merged with this preset's own
    // override, if any) as of refreshLibrary()'s last call - see its comment.
    this.editingPresetId = this.activePresetId
    this.disposePreview()

    this.els.empty.classList.add('hidden')
    this.els.panel.classList.remove('hidden')
    this.setBarEnabled(true)
    this.els.soundName.textContent = entry.name
    this.els.soundName.title = entry.name
    this.layout?.refreshStudio?.()
    this.setPlayPauseIcon(false)
    this.els.saveStatus.textContent = ''

    // entry.filters.eq is undefined on any sound saved before the
    // parametric EQ existed - explicitly defaulted here (not left to
    // setFilterSliders' own `if (filters.eq)` guard) so loading an old
    // sound always resets the EQ editor to flat defaults instead of
    // silently keeping whatever the previously-loaded sound left on screen.
    const filters = { ...NEUTRAL_FILTERS, ...entry.filters, eq: entry.filters?.eq ?? defaultEqBands() }
    this.setFilterSliders(filters)
    // A/B Compare's "B" (last saved mix) - captured once here from the
    // just-loaded entry's own saved data, deliberately never touched again
    // for the rest of this editing session (not even by an in-session Save -
    // "last saved... before the current session").
    this.savedEqSnapshot = filters.eq.map((b) => ({ ...b }))
    this.resetEqCompare()

    const crossfadeMs = entry.crossfadeSeconds != null ? Math.round(entry.crossfadeSeconds * 1000) : DEFAULT_CROSSFADE_MS
    this.els.crossfade.value = String(crossfadeMs)
    this.updateCrossfadeLabel(crossfadeMs)

    const speedPitch = entry.speedPitch ?? {
      speed: 1,
      pitchSemitones: 0,
      reversed: false,
      dopplerEnabled: false,
      dopplerClosestFraction: 0.5,
      dopplerIntensitySemitones: 5,
      dopplerReversed: false,
      dopplerSharpness: 0.5
    }
    this.setSpeedPitchControls(speedPitch)
    this.updateSpeedPitchLabels(speedPitch)
    // setDopplerEnabled/setDopplerClosestFraction are called again below,
    // after loopEditorController.load() - load() resets both to their
    // neutral defaults (a fresh sound shouldn't inherit the previous one's
    // Doppler state), which would otherwise immediately clobber what
    // setSpeedPitchControls just set here.
    this.loopEditorController?.setDopplerEnabled(speedPitch.dopplerEnabled ?? false)

    const playMode = entry.playMode ?? 'loop'
    const scatter = entry.scatter ?? defaultScatter()
    const schedule = entry.schedule ?? defaultSchedule()
    this.setPlayModeControls(playMode)
    this.setScatterControls(scatter)
    this.setScheduleControls(schedule)

    const fluctuation = entry.fluctuation ?? defaultFluctuation()
    this.setFluctuationControls(fluctuation)

    await this.engine.resume()
    this.previewSource = new PreviewSource(this.engine, {
      soundId: entry.id,
      loopStart: entry.loopStart,
      loopEnd: entry.loopEnd,
      volume: this.effectivePreviewVolume(),
      looping: this.looping,
      crossfadeSeconds: crossfadeMs / 1000,
      speedPitch,
      fluctuation,
      onNoiseProfile: (curve) => this.filterControls?.setNoiseProfile(curve)
    })
    this.previewMode = 'live'
    // Constructed unconditionally (cheap - a plain <audio> pointed at the
    // clip URL) even if no bake exists yet; savedPreviewEligible() is what
    // actually gates whether the toggle can be used, checked fresh on every
    // edit via updateSaveButtonState() -> updatePreviewModeToggle() below.
    this.bakedPreview = new BakedClipPreview(this.engine, entry.id, this.effectivePreviewVolume(), this.editingPresetId)
    // Only fires when Loop preview is off and playback runs off the end on
    // its own - the button/playhead-tracking RAF otherwise only stop via
    // the explicit Play/Pause click handler below.
    this.previewSource.onEnded = () => {
      this.stopPreviewTicking()
      this.setPlayPauseIcon(false)
      this.eqEditorController.clearSpectrum()
    }
    this.previewSource.onReverseStateChange = (state) => this.showReverseState(state)
    this.showReverseState(this.previewSource.reverseState)
    const duration = await this.previewSource.waitForMetadata()
    if (this.currentEntry?.id !== id) return // switched sounds while loading

    if (entry.durationSeconds == null) {
      await this.api.library.updateMeta(id, { durationSeconds: duration })
      entry.durationSeconds = duration
      if (entry.loopEnd == null) entry.loopEnd = duration
    }

    const loopStart = entry.loopStart
    const loopEnd = entry.loopEnd ?? duration
    this.previewSource.setLoopPoints(loopStart, loopEnd)
    this.previewSource.setFilters(this.previewFilters())
    this.previewSource.setFluctuation(this.fluctuation)
    this.previewSource.scrubTo(loopStart)
    this.loopEditorController.load(duration, loopStart, loopEnd)
    closeMarkerPopover()
    this.setMarkers(loadMarkers(entry.id, duration), { save: false })
    // load() resets its own volume-envelope state to neutral, same reason
    // it resets Doppler (a fresh sound shouldn't inherit the previous one's
    // drawn points) - re-applied here after load(), same ordering fix
    // Doppler already needed (see the comment on its own re-apply just
    // below).
    this.loopEditorController.setEnvelope(filters.volumeEnvelope?.enabled ?? false, filters.volumeEnvelope?.points)
    this.spectralView.setRegions(filters.spectralRepairs ?? [])
    this.updateSpectralControls()
    this.syncNoiseBand()
    this._spectrogramKey = null
    this.syncSpectralView()
    // BUG FIX (caught live testing this feature, not by review): loadSound()
    // only calls setPlayModeControls() (sets the radio buttons' checked
    // state), never applyPlayModeControl() itself - that only runs off the
    // radio buttons' own 'change' listeners, or the one other place it's
    // wired (undo/redo's applyEditorState). Loading a fresh sound therefore
    // never actually recomputed anything playMode-gated, including this new
    // envelope-visibility flag - it silently stayed at whatever the
    // previously-open sound left it as. Setting it directly here, matching
    // the same "explicit re-apply after load()'s own reset" pattern already
    // needed for setEnvelope/Doppler above, rather than trying to route
    // through applyPlayModeControl() (which also touches fade visuals/save
    // state this function handles separately already).
    this.loopEditorController.setEnvelopeUiVisible(playMode === 'loop')
    this.loopEditorController.setDopplerEnabled(speedPitch.dopplerEnabled ?? false)
    this.loopEditorController.setDopplerClosestFraction(speedPitch.dopplerClosestFraction ?? 0.5)
    this.loopEditorController.setDopplerReversed(speedPitch.dopplerReversed ?? false)
    this.updateFadeVisual()
    this.updateLoopTimeInputs(loopStart, loopEnd)
    this.loopEditorController.setPlayhead(loopStart)
    this.updateStickyProgress(loopStart)
    this.els.suggestStatus.textContent = ''
    this.els.suggestLoopBtn.disabled = false

    // Fire-and-forget: a real ffmpeg round-trip (six bandpass-filtered
    // passes, see src/main/ffmpeg/bandEnergy.js), so this arrives well after
    // everything else above already rendered. Fixed reference frequencies
    // (defaultEqBands' own, not this sound's possibly-customized bands) -
    // see EqEditor.js's setBandEnergy for why the backdrop is deliberately
    // decoupled from wherever the user later drags a node to.
    const bandFreqs = defaultEqBands().map((b) => b.freqHz)
    this.api.audio
      .getBandEnergy(id, { loopStart, loopEnd, freqs: bandFreqs })
      .then((energies) => {
        if (this.currentEntry?.id !== id || !energies) return
        this.eqEditorController.setBandEnergy(bandFreqs, energies)
      })
      .catch((err) => console.error('Editor: band energy analysis failed', err))
    this.savedSnapshot = this.snapshotOf(loopStart, loopEnd, filters, crossfadeMs, speedPitch, playMode, scatter, schedule)
    // Undo history is per-editing-session, same scope as A/B Compare - a
    // fresh load starts a fresh stack seeded with the just-loaded state, so
    // Ctrl+Z on the very first edit reverts to exactly what was loaded.
    clearTimeout(this._historyCommitTimer)
    this.history.reset(JSON.parse(this.savedSnapshot))
    this.updateUndoRedoButtonsUI()
    this.updateSaveButtonState()

    this.els.waveformStatus.textContent = this.waveformPeaksCache.has(id) ? '' : 'Loading waveform…'
    // A failed fetch used to leave "Loading waveform…" up forever; say why instead.
    let peaks = null
    let failure = null
    try {
      // 60 s covers an hour-long file; past that the main process never answered.
      let timer
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("no answer after 60 s")), 60000) })
      peaks = await Promise.race([this.getWaveformPeaks(id), timeout]).finally(() => clearTimeout(timer))
    } catch (err) {
      console.error('Editor: waveform load failed', err)
      failure = err?.message || String(err)
    }
    if (this.currentEntry?.id !== id) return
    this.loopEditorController.setPeaks(peaks)
    this.syncSeamView()
    this.els.waveformStatus.textContent = peaks ? '' : failure ? `Waveform failed to load: ${failure}` : 'Waveform preview unavailable for this file.'
  }

  // trigger: 'manual' (the Save button) or 'auto' (runAutosave) - only
  // changes the status-line wording below, everything else about the save
  // is identical either way. _saveInProgress guards against a manual click
  // and a debounced autosave firing at the same moment starting two
  // overlapping bakes of the same sound.
  async save(options = {}) {
    const { trigger = 'manual', forceBake = false } = options
    // Defense in depth - the Save button is already disabled while viewing
    // B (see updateSaveButtonState), but currentFilters() would silently
    // read B's read-only data instead of A's real live edits if this ever
    // ran anyway.
    if (!this.currentEntry || !this.loopEditorController || this.eqCompareViewing === 'B' || this.compare.isSaved) return
    if (this._saveInProgress) return
    this._saveInProgress = true
    this.saveMorph?.working(trigger === 'auto' ? 'Auto-saving' : 'Saving')
    try {
      await this.performSave(trigger, forceBake)
      this.saveMorph?.done(trigger === 'auto' ? 'Auto-saved' : 'Changes saved')
    } catch (err) {
      this.saveMorph?.fail("Couldn't save. Try again")
      this.updateSaveButtonState()
      throw err
    } finally {
      this._saveInProgress = false
    }
  }

  async performSave(trigger, forceBake = false) {
    const savedWord = trigger === 'auto' ? 'Auto-saved' : 'Saved'
    const id = this.currentEntry.id
    // BUG FIX (self-review, v0.1.196): everything this async function reads
    // off `this` after an `await` - `this.currentEntry`, `this.editingPresetId`,
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
    // regardless of what `this.currentEntry` points to by the time it
    // resolves; `stillEditingThisEntry()` gates anything that should only
    // happen if the Remix UI is still actually showing this sound (status
    // text, the Save button, savedSnapshot, the baked-preview swap).
    const entry = this.currentEntry
    const savingEditingPresetId = this.editingPresetId
    const savingFluctuation = this.fluctuation
    const stillEditingThisEntry = () => this.currentEntry === entry
    // Captured before savedSnapshot is rewritten below. The Save button can
    // now be lit by a fluctuation-only edit (see updateSaveButtonState) - in
    // that case nothing that feeds the ffmpeg render actually changed, so
    // skip the bake round-trip entirely rather than re-rendering a
    // byte-identical clip (fluctuation is never baked in).
    const bakeRelevantDirty = forceBake || this.hasUnsavedChanges()
    const flucDirty = this.fluctuationDirty()
    const { loopStart, loopEnd } = this.loopEditorController.getLoopPoints()
    const filters = this.currentFilters()
    const crossfadeMs = this.currentCrossfadeMs()
    const crossfadeSeconds = crossfadeMs / 1000
    const speedPitch = this.currentSpeedPitch()
    const playMode = this.currentPlayMode()
    const scatter = this.currentScatterConfig()
    const schedule = this.currentScheduleConfig()
    // Random-interval and Scheduled playback both replay the clip as
    // one-shots, never back-to-back — the crossfade+rotation a looped clip
    // needs to hide its own wrap point would be wrong for either, so the
    // bake below always uses 0 (plain trim) for both regardless of the
    // crossfade slider's own saved value. Mirrors library.js/tabs/mixer's
    // own effectiveCrossfadeSeconds exactly — keep in sync if this ever
    // changes.
    const effectiveCrossfadeSeconds =
      playMode === 'scatter' || playMode === 'scheduled' || speedPitch.dopplerEnabled ? 0 : crossfadeSeconds

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
    if (savingEditingPresetId) this.presets = await this.api.presets.list()
    const editingPreset = savingEditingPresetId ? this.presets.find((p) => p.id === savingEditingPresetId) : null
    let presetSoundItem = editingPreset?.sounds.find((s) => s.soundId === id) ?? null
    // Owner, 2026-11-21: a sound out of the mix with a parked copy
    // (removedOverrides) edits that copy only, never the shared defaults;
    // the app's updateSoundOverride writes the parked slot for it.
    const parkedSlot = !presetSoundItem && Object.hasOwn(editingPreset?.removedOverrides ?? {}, id)
    if (parkedSlot) presetSoundItem = { soundId: id, overrides: editingPreset.removedOverrides[id], parked: true }
    if (presetSoundItem) {
      const updated = await this.api.presets.updateSoundOverride(savingEditingPresetId, id, overridePatch)
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
      await this.api.library.updateLoopPoints(id, { loopStart, loopEnd })
      await this.api.library.updateFilters(id, filters)
      await this.api.library.updateCrossfade(id, crossfadeSeconds)
      await this.api.library.updateSpeedPitch(id, speedPitch)
      await this.api.library.updatePlayMode(id, playMode)
      await this.api.library.updateScatterConfig(id, scatter)
      await this.api.library.updateSchedule(id, schedule)
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
        window.dispatchEvent(
          new CustomEvent('noctivago:sound-override-changed', {
            detail: { presetId: savingEditingPresetId, soundId: id, overrides: presetSoundItem.overrides, loopClip, parked: Boolean(presetSoundItem.parked) }
          })
        )
      } else {
        window.dispatchEvent(
          new CustomEvent('noctivago:sound-baseline-changed', {
            detail: { soundId: id, loopStart, loopEnd, filters, crossfadeSeconds, speedPitch, playMode, scatter, schedule, loopClip }
          })
        )
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
      this.savedSnapshot = this.snapshotOf(loopStart, loopEnd, filters, crossfadeMs, speedPitch, playMode, scatter, schedule)
    }

    // Persist the drift settings in the same Save (their own IPC call, not
    // folded into the bake) and cancel any still-pending debounced write so
    // it doesn't fire a second, redundant one right after. Uses the
    // pre-await savingFluctuation capture, not a live this.fluctuation read,
    // for the same reason `entry` is captured above - this.fluctuation would
    // already belong to a different sound if the user switched mid-save.
    if (flucDirty) {
      clearTimeout(this._fluctuationSaveTimer)
      this._pendingFluctuation = null
      await this.api.library.updateFluctuation(id, savingFluctuation)
      entry.fluctuation = savingFluctuation
      window.dispatchEvent(
        new CustomEvent('noctivago:sound-fluctuation-changed', { detail: { soundId: id, fluctuation: savingFluctuation } })
      )
      if (stillEditingThisEntry()) this.savedFluctuationSnapshot = this.fluctuationSnapshot()
    }

    // Only fluctuation (or nothing) changed - the existing bake, if any, is
    // still valid. Skip the ffmpeg re-render.
    if (!bakeRelevantDirty) {
      notifyLiveReconcile()
      if (stillEditingThisEntry()) {
        this.els.saveStatus.textContent = `${savedWord} — original file untouched.${overrideHint}`
        this.updateSaveButtonState()
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
      this.els.save.disabled = true
      if (!this.saveMorph) this.setSaveLabel(trigger === 'auto' ? 'Auto-saving…' : 'Saving…')
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
      let resume = null
      if (stillEditingThisEntry() && this.bakedPreview) {
        resume = {
          time: this.bakedPreview.currentTime || 0,
          playing: this.previewMode === 'saved' && this.bakedPreview.playing
        }
        if (resume.playing) {
          this.stopPreviewTicking()
          this.setPlayPauseIcon(false)
        }
        this._clipRebaking = true
        this.bakedPreview.dispose()
        this.bakedPreview = null
      }
      let result
      try {
        result = await this.api.audio.renderLoopClip(id, {
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
          this.els.saveStatus.textContent =
            (playMode === 'scatter'
              ? `${savedWord} — original file untouched. Rendered a clip for random-interval playback.`
              : playMode === 'scheduled'
                ? `${savedWord} — original file untouched. Rendered a clip for scheduled playback.`
                : `${savedWord} — original file untouched. Rendered a gapless clip for seamless looping.`) + overrideHint
        }
      } else {
        entry.loopClipReady = false
        entry.loopClipStart = null
        entry.loopClipEnd = null
        entry.loopClipFilters = null
        entry.loopClipCrossfadeSeconds = null
        entry.loopClipSpeedPitch = null
        if (stillEditingThisEntry()) {
          this.els.saveStatus.textContent =
            (playMode === 'scatter'
              ? `${savedWord} — original file untouched. Clip render failed, so this will stream directly for random-interval playback.`
              : playMode === 'scheduled'
                ? `${savedWord} — original file untouched. Clip render failed, so this will stream directly for scheduled playback.`
                : `${savedWord} — original file untouched. Gapless clip render failed, so this will loop with a small seam.`) + overrideHint
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
      if (resume) this._clipRebaking = false
      if (stillEditingThisEntry()) {
        const resumingSaved = this.previewMode === 'saved' && result.ok
        const resumeTime = resumingSaved ? resume?.time ?? this.bakedPreview?.currentTime ?? 0 : 0
        const resumePlaying = resumingSaved && (resume ? resume.playing : Boolean(this.bakedPreview?.playing))
        this.bakedPreview?.dispose()
        this.bakedPreview = new BakedClipPreview(this.engine, id, this.effectivePreviewVolume(), savingEditingPresetId)
        if (resumingSaved) {
          this.bakedPreview.scrubTo(resumeTime)
          if (resumePlaying) {
            this.engine
              .resume()
              .then(() => this.bakedPreview?.play())
              .then(() => {
                this.setPlayPauseIcon(true)
                this.tickPreviewPlayhead()
              })
              .catch((err) => console.error('Editor: failed to resume saved-audio preview after re-bake', err))
          }
        }
        this.updateSaveButtonState()
      }
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
        this.els.saveStatus.textContent =
          (playMode === 'scatter'
            ? `${savedWord} — original file untouched. This trim is over 10 minutes, so random-interval playback will stream directly.`
            : playMode === 'scheduled'
              ? `${savedWord} — original file untouched. This trim is over 10 minutes, so scheduled playback will stream directly.`
              : `${savedWord} — original file untouched. This trim is over 10 minutes, so it will loop with a small seam instead of a gapless clip.`) + overrideHint
      }
      notifyLiveReconcile()
      if (stillEditingThisEntry()) this.updateSaveButtonState()
    }
  }

  // Picks "<name> copy", then "<name> copy 2", "<name> copy 3"... against
  // whatever's currently in the library - names aren't enforced unique
  // elsewhere in this app, but a distinct default avoids two identical-
  // looking rows in the Mixer's own list right after saving.
  nextCopyName(baseName) {
    const existing = new Set(this.library.map((e) => e.name))
    let candidate = `${baseName} copy`
    let n = 2
    while (existing.has(candidate)) {
      candidate = `${baseName} copy ${n}`
      n += 1
    }
    return candidate
  }

  // "Save as copy" - trims a segment out of a longer recording (the owner's
  // own use case: several distinct bird calls in one field recording) into
  // its own independent sound, without touching the source's own saved
  // trim/filters at all. Deliberately does *not* run this.save() first or
  // touch this.currentEntry/this.savedSnapshot in any way - the workflow is
  // trim to segment 1, Save as copy, adjust the trim to segment 2 (still on
  // the *same* open sound), Save as copy again, and so on, so the sound
  // staying open in Remix must keep behaving exactly like nothing happened.
  // Mirrors save()'s own structure closely (same field reads, same bake
  // call, same MAX_BUFFER_CLIP_SECONDS cap) but targets the brand-new id
  // library.duplicateSound() hands back instead of this.currentEntry.id.
  async saveAsCopy() {
    if (!this.currentEntry || !this.loopEditorController || this.eqCompareViewing === 'B') return
    const { loopStart, loopEnd } = this.loopEditorController.getLoopPoints()
    const filters = this.currentFilters()
    const crossfadeMs = this.currentCrossfadeMs()
    const crossfadeSeconds = crossfadeMs / 1000
    const speedPitch = this.currentSpeedPitch()
    const playMode = this.currentPlayMode()
    const scatter = this.currentScatterConfig()
    const schedule = this.currentScheduleConfig()
    const effectiveCrossfadeSeconds =
      playMode === 'scatter' || playMode === 'scheduled' || speedPitch.dopplerEnabled ? 0 : crossfadeSeconds

    const name = this.nextCopyName(this.currentEntry.name)
    this.els.saveAsCopy.disabled = true
    this.els.saveStatus.textContent = `Saving a copy as "${name}"…`
    const newEntry = await this.api.library.duplicateSound(this.currentEntry.id, { name })
    if (!newEntry) {
      this.els.saveAsCopy.disabled = false
      this.els.saveStatus.textContent = 'Save as copy failed — could not create the new sound.'
      return
    }

    await this.api.library.updateLoopPoints(newEntry.id, { loopStart, loopEnd })
    await this.api.library.updateFilters(newEntry.id, filters)
    await this.api.library.updateCrossfade(newEntry.id, crossfadeSeconds)
    await this.api.library.updateSpeedPitch(newEntry.id, speedPitch)
    await this.api.library.updatePlayMode(newEntry.id, playMode)
    await this.api.library.updateScatterConfig(newEntry.id, scatter)
    await this.api.library.updateSchedule(newEntry.id, schedule)

    let baked = false
    if (loopEnd - loopStart <= MAX_BUFFER_CLIP_SECONDS) {
      const result = await this.api.audio.renderLoopClip(newEntry.id, {
        loopStart,
        loopEnd,
        filters,
        crossfadeSeconds: effectiveCrossfadeSeconds,
        speedPitch
      })
      baked = result.ok
    }
    this.els.saveAsCopy.disabled = false
    this.els.saveStatus.textContent = baked
      ? `Saved a copy: "${name}".`
      : `Saved a copy: "${name}" (streams directly - trim over 10 minutes, or the clip render failed).`
    await this.refreshLibrary()
  }

  // "Save segment as new" (Desktop 2.0, owner 2026-11-10): a brand-new sound
  // that is only the trimmed part. Unlike Save as copy it carries none of
  // this sound's settings: filters, EQ, speed, pitch, play mode, per-play
  // ranges and drift all start at their defaults. The open sound is untouched.
  async saveSegmentAsNew() {
    if (!this.currentEntry || !this.loopEditorController || this.eqCompareViewing === 'B') return
    const { loopStart, loopEnd } = this.loopEditorController.getLoopPoints()
    const filters = structuredClone(NEUTRAL_FILTERS)
    const speedPitch = defaultSpeedPitch()
    const crossfadeSeconds = DEFAULT_CROSSFADE_MS / 1000
    const name = this.nextCopyName(this.currentEntry.name)
    this.els.saveSegment.disabled = true
    this.els.saveStatus.textContent = `Saving the segment as "${name}"…`
    const newEntry = await this.api.library.duplicateSound(this.currentEntry.id, { name })
    if (!newEntry) {
      this.els.saveSegment.disabled = false
      this.els.saveStatus.textContent = 'Save segment failed — could not create the new sound.'
      return
    }

    await this.api.library.updateLoopPoints(newEntry.id, { loopStart, loopEnd })
    await this.api.library.updateFilters(newEntry.id, filters)
    await this.api.library.updateCrossfade(newEntry.id, crossfadeSeconds)
    await this.api.library.updateSpeedPitch(newEntry.id, speedPitch)
    await this.api.library.updatePlayMode(newEntry.id, 'loop')
    await this.api.library.updateScatterConfig(newEntry.id, defaultScatter())
    await this.api.library.updateSchedule(newEntry.id, defaultSchedule())
    await this.api.library.updateFluctuation(newEntry.id, defaultFluctuation())

    let baked = false
    if (loopEnd - loopStart <= MAX_BUFFER_CLIP_SECONDS) {
      const result = await this.api.audio.renderLoopClip(newEntry.id, { loopStart, loopEnd, filters, crossfadeSeconds, speedPitch })
      baked = result.ok
    }
    this.els.saveSegment.disabled = false
    this.els.saveStatus.textContent = baked
      ? `Saved the segment as a new sound: "${name}".`
      : `Saved the segment as a new sound: "${name}" (streams directly - trim over 10 minutes, or the clip render failed).`
    await this.refreshLibrary()
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
