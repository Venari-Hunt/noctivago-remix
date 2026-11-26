import { AudioEngine } from '../audio/AudioEngine.js'
import { normalizeRegions } from '../domain/spectralLayout.js'
import { mountLoopEditor, mountWaveformScrollbar } from '../mounts/loopEditorMount.js'
import { mountSpectral } from '../mounts/spectralMount.js'
import { mountSeam } from '../mounts/seamMount.js'
import { mountEqEditor, mountMixEqTargets } from '../mounts/eqMount.js'
import { mountMixFluctuation } from '../mounts/mixFlucMount.js'
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
import { filterSummaries } from './FilterControls.jsx'
import { filterPickerSounds } from '../domain/pickerList.js'
import { groupDriftFor, groupOverrideNotes } from '../domain/driftState.js'
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
import { applySoundOverride,HISTORY_COMMIT_DEBOUNCE_MS, HISTORY_LIMIT, defaultEqBands, defaultVolumeEnvelope, NEUTRAL_FILTERS, defaultFluctuation, FILTER_PRESETS, NEUTRAL_WHOLE_MIX, NEUTRAL_GROUP_FILTERS, SHOT_AXES, shotBiasDefault, SHOT_AXIS_NAMES, cloneWholeMix, wholeMixEqual, cloneGroupFilters, groupFiltersEqual } from '../domain/mixSettings.js'
import { mountMarkerUi } from './markerUi.js'
import { icon } from './icons.js'
import { arrangeLayout, arrangeBar, driftSummary } from './layout.js'
import { wireNameMarquee } from './nameMarquee.js'
import { requestMixerStatus } from './mixerBridge.js'
import { groupDetail, presetDetail, soundDetail, panOverride, withSoundVolume } from '../domain/detailPanel.js'
import { ItemPreviewPlayer } from '../audio/ItemPreview.js'
import { soundPlan, groupPlan, previewKind, effectiveSound } from '../domain/itemPreview.js'
import { autosaveCallbacks } from '../callbacks/autosaveCallbacks.js'
import { previewCallbacks } from '../callbacks/previewCallbacks.js'
import { soundLoaderCallbacks } from '../callbacks/soundLoaderCallbacks.js'
import { saveCallbacks } from '../callbacks/saveCallbacks.js'
import { mountCallbacks } from '../callbacks/mountCallbacks.js'
import { findAllEls } from '../panels/index.js'
import * as markers from '../tab/markers.js'
import * as fluctuation from '../tab/fluctuation.js'
import * as spectralRepair from '../tab/spectralRepair.js'
import * as loopLayoutMethods from '../tab/loopLayout.js'
import * as presetGroupMode from '../tab/presetGroupMode.js'
import * as stickyPreview from '../tab/stickyPreview.js'
import * as eqFilters from '../tab/eqFilters.js'
import * as mixPlayback from '../tab/mixPlayback.js'

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
    this.autosave = createAutosave(autosaveCallbacks(this))
    this.previewCtl = createPreviewController(previewCallbacks(this))
    this.soundLoader = createSoundLoader(soundLoaderCallbacks(this))
    this.saveCtl = createSaveController(saveCallbacks(this))
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
    return mountCallbacks(this)
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
    stickyPreview.wireStickyBar(this)
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

  setMarkers(...args) {
    return markers.setMarkers(this, ...args)
  }

  refreshMarkerUi(...args) {
    return markers.refreshMarkerUi(this, ...args)
  }

  addMarkerAtPlayhead(...args) {
    return markers.addMarkerAtPlayhead(this, ...args)
  }

  goToMarker(...args) {
    return markers.goToMarker(this, ...args)
  }

  deleteMarker(...args) {
    return markers.deleteMarker(this, ...args)
  }

  editMarker(...args) {
    return markers.editMarker(this, ...args)
  }

  handleMarkerKey(...args) {
    return markers.handleMarkerKey(this, ...args)
  }

  effectivePreviewVolume(...args) {
    return stickyPreview.effectivePreviewVolume(this, ...args)
  }

  activePreview(...args) {
    return stickyPreview.activePreview(this, ...args)
  }

  savedPreviewEligible(...args) {
    return stickyPreview.savedPreviewEligible(this, ...args)
  }

  togglePreviewMode(...args) {
    return stickyPreview.togglePreviewMode(this, ...args)
  }

  updatePreviewModeToggle(...args) {
    return stickyPreview.updatePreviewModeToggle(this, ...args)
  }

  updatePreviewMuteIcon(...args) {
    return stickyPreview.updatePreviewMuteIcon(this, ...args)
  }

  updateLoopToggleVisual(...args) {
    return stickyPreview.updateLoopToggleVisual(this, ...args)
  }

  toggleSolo(...args) {
    return stickyPreview.toggleSolo(this, ...args)
  }

  setSolo(...args) {
    return stickyPreview.setSolo(this, ...args)
  }

  setPlayPauseIcon(...args) {
    return stickyPreview.setPlayPauseIcon(this, ...args)
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

  // --- EQ and filters: src/tab/eqFilters.js ---
  setFilterSliders(...args) {
    return eqFilters.setFilterSliders(this, ...args)
  }

  currentFilters(...args) {
    return eqFilters.currentFilters(this, ...args)
  }

  previewFilters(...args) {
    return eqFilters.previewFilters(this, ...args)
  }

  updateEqFieldsFromSelection(...args) {
    return eqFilters.updateEqFieldsFromSelection(this, ...args)
  }

  applyEqFieldsToSelectedBand(...args) {
    return eqFilters.applyEqFieldsToSelectedBand(this, ...args)
  }

  applyEqControls(...args) {
    return eqFilters.applyEqControls(this, ...args)
  }

  eqDiffersFromSaved(...args) {
    return eqFilters.eqDiffersFromSaved(this, ...args)
  }

  updateEqRevertBannerVisibility(...args) {
    return eqFilters.updateEqRevertBannerVisibility(this, ...args)
  }

  switchEqCompareView(...args) {
    return eqFilters.switchEqCompareView(this, ...args)
  }

  updateEqCompareButtonsUI(...args) {
    return eqFilters.updateEqCompareButtonsUI(this, ...args)
  }

  revertEqToSaved(...args) {
    return eqFilters.revertEqToSaved(this, ...args)
  }

  resetEqCompare(...args) {
    return eqFilters.resetEqCompare(this, ...args)
  }

  applyFilterControls(...args) {
    return eqFilters.applyFilterControls(this, ...args)
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

  // --- Loop layout and Loop seam: src/tab/loopLayout.js ---
  liveLayout() {
    return loopLayoutMethods.liveLayout(this)
  }

  currentSpeedPitchDoppler() {
    return loopLayoutMethods.currentSpeedPitchDoppler(this)
  }

  savedLayout() {
    return loopLayoutMethods.savedLayout(this)
  }

  clipTimeToSource(clipTime) {
    return loopLayoutMethods.clipTimeToSource(this, clipTime)
  }

  sourceTimeToClip(t) {
    return loopLayoutMethods.sourceTimeToClip(this, t)
  }

  syncSeamView(...args) {
    return loopLayoutMethods.syncSeamView(this, ...args)
  }

  scheduleSeamPeaks(...args) {
    return loopLayoutMethods.scheduleSeamPeaks(this, ...args)
  }

  scheduleSeamDetailPeaks(sourceRanges) {
    return loopLayoutMethods.scheduleSeamDetailPeaks(this, sourceRanges)
  }

  updateSeamPlayhead(sourceTime) {
    return loopLayoutMethods.updateSeamPlayhead(this, sourceTime)
  }

  toggleSeamListen() {
    return loopLayoutMethods.toggleSeamListen(this)
  }

  stopSeamListen(...args) {
    return loopLayoutMethods.stopSeamListen(this, ...args)
  }

  // --- Spectral repair ---
  // The panel shows the trim only (that's all a bake reads). The spectrogram
  // is refetched for a new trim once the drag settles.
  syncSpectralView() {
    return spectralRepair.syncSpectralView(this)
  }

  setSpectralTool(tool) {
    return spectralRepair.setSpectralTool(this, tool)
  }

  syncSpectralTool() {
    return spectralRepair.syncSpectralTool(this)
  }

  syncNoiseBand() {
    return spectralRepair.syncNoiseBand(this)
  }

  useShapeAsNoiseSample() {
    return spectralRepair.useShapeAsNoiseSample(this)
  }

  updateSpectralControls() {
    return spectralRepair.updateSpectralControls(this)
  }

  setFluctuationControls(...args) {
    return fluctuation.setFluctuationControls(this, ...args)
  }

  writeFluctuationAxisFields(...args) {
    return fluctuation.writeFluctuationAxisFields(this, ...args)
  }

  updateFluctuationEnabledUI() {
    return fluctuation.updateFluctuationEnabledUI(this)
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

  readFluctuationAxisFields(...args) {
    return fluctuation.readFluctuationAxisFields(this, ...args)
  }

  applyFluctuationControls() {
    return fluctuation.applyFluctuationControls(this)
  }

  persistFluctuation() {
    return fluctuation.persistFluctuation(this)
  }

  flushFluctuation() {
    return fluctuation.flushFluctuation(this)
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

  fluctuationSnapshot() {
    return fluctuation.fluctuationSnapshot(this)
  }

  fluctuationDirty() {
    return fluctuation.fluctuationDirty(this)
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

  // --- Sticky bar and preview mode: src/tab/stickyPreview.js ---
  stopPreviewTicking(...args) {
    return stickyPreview.stopPreviewTicking(this, ...args)
  }

  tickPreviewPlayhead(...args) {
    return stickyPreview.tickPreviewPlayhead(this, ...args)
  }

  wireStickyProgressDrag(...args) {
    return stickyPreview.wireStickyProgressDrag(this, ...args)
  }

  updateStickyProgress(...args) {
    return stickyPreview.updateStickyProgress(this, ...args)
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

  // --- Mix panel play, volume and spectrogram: src/tab/mixPlayback.js ---
  startWholeMixSpectrumTicking(...args) {
    return mixPlayback.startWholeMixSpectrumTicking(this, ...args)
  }

  stopWholeMixSpectrumTicking(...args) {
    return mixPlayback.stopWholeMixSpectrumTicking(this, ...args)
  }

  resetLevelHistory(...args) {
    return mixPlayback.resetLevelHistory(this, ...args)
  }

  tickWholeMixSpectrum(...args) {
    return mixPlayback.tickWholeMixSpectrum(this, ...args)
  }

  updateMixPlayPauseUI(...args) {
    return mixPlayback.updateMixPlayPauseUI(this, ...args)
  }

  updateMixVolumeUI(...args) {
    return mixPlayback.updateMixVolumeUI(this, ...args)
  }

  onMixPlayPauseClick(...args) {
    return mixPlayback.onMixPlayPauseClick(this, ...args)
  }

  playGroupOnly(...args) {
    return mixPlayback.playGroupOnly(this, ...args)
  }

  onMixSoloGroupClick(...args) {
    return mixPlayback.onMixSoloGroupClick(this, ...args)
  }

  async refreshMixPanel(...args) {
    return presetGroupMode.refreshMixPanel(this, ...args)
  }

  renderPresetSelectOptions(...args) {
    return presetGroupMode.renderPresetSelectOptions(this, ...args)
  }

  selectMixPreset(...args) {
    return presetGroupMode.selectMixPreset(this, ...args)
  }

  writePresetMixControls(...args) {
    return presetGroupMode.writePresetMixControls(this, ...args)
  }

  readPresetMixControlsAndPreview(...args) {
    return presetGroupMode.readPresetMixControlsAndPreview(this, ...args)
  }

  readMixFluctuation(...args) {
    return presetGroupMode.readMixFluctuation(this, ...args)
  }

  readMixFlucAxis(...args) {
    return presetGroupMode.readMixFlucAxis(this, ...args)
  }

  writeMixFluctuation(...args) {
    return presetGroupMode.writeMixFluctuation(this, ...args)
  }

  writeMixFlucAxis(...args) {
    return presetGroupMode.writeMixFlucAxis(this, ...args)
  }

  updateMixFlucEnabledUI(...args) {
    return presetGroupMode.updateMixFlucEnabledUI(this, ...args)
  }

  setPresetEffectPreset(...args) {
    return presetGroupMode.setPresetEffectPreset(this, ...args)
  }

  updatePresetMixLabels(...args) {
    return presetGroupMode.updatePresetMixLabels(this, ...args)
  }

  async saveWholeMix(...args) {
    return presetGroupMode.saveWholeMix(this, ...args)
  }

  dispatchWholeMixPreview(...args) {
    return presetGroupMode.dispatchWholeMixPreview(this, ...args)
  }

  renderGroupSelectOptions(...args) {
    return presetGroupMode.renderGroupSelectOptions(this, ...args)
  }

  renderCopyGroupTargetOptions(...args) {
    return presetGroupMode.renderCopyGroupTargetOptions(this, ...args)
  }

  async copyGroupToPreset(...args) {
    return presetGroupMode.copyGroupToPreset(this, ...args)
  }

  selectGroup(...args) {
    return presetGroupMode.selectGroup(this, ...args)
  }

  renderGroupMembers(...args) {
    return presetGroupMode.renderGroupMembers(this, ...args)
  }

  toggleGroupMember(...args) {
    return presetGroupMode.toggleGroupMember(this, ...args)
  }

  queueGroupMutation(...args) {
    return presetGroupMode.queueGroupMutation(this, ...args)
  }

  async _toggleGroupMemberNow(...args) {
    return presetGroupMode._toggleGroupMemberNow(this, ...args)
  }

  writeGroupControls(...args) {
    return presetGroupMode.writeGroupControls(this, ...args)
  }

  readGroupControlsAndPreview(...args) {
    return presetGroupMode.readGroupControlsAndPreview(this, ...args)
  }

  setGroupEffectPreset(...args) {
    return presetGroupMode.setGroupEffectPreset(this, ...args)
  }

  updateGroupLabels(...args) {
    return presetGroupMode.updateGroupLabels(this, ...args)
  }

  updateGroupDirty(...args) {
    return presetGroupMode.updateGroupDirty(this, ...args)
  }

  saveGroup(...args) {
    return presetGroupMode.saveGroup(this, ...args)
  }

  async saveGroupNow(...args) {
    return presetGroupMode.saveGroupNow(this, ...args)
  }

  deleteGroup(...args) {
    return presetGroupMode.deleteGroup(this, ...args)
  }

  async deleteGroupNow(...args) {
    return presetGroupMode.deleteGroupNow(this, ...args)
  }

  createGroup(...args) {
    return presetGroupMode.createGroup(this, ...args)
  }

  async createGroupNow(...args) {
    return presetGroupMode.createGroupNow(this, ...args)
  }

  dispatchGroupPreview(...args) {
    return presetGroupMode.dispatchGroupPreview(this, ...args)
  }
}
