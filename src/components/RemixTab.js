import { AudioEngine } from '../audio/AudioEngine.js'
import { PreviewSource } from '../audio/PreviewSource.js'
import { BakedClipPreview } from '../audio/BakedClipPreview.js'
import { createLoopEditorController } from './LoopEditor.js'
import { createSeamViewController } from './SeamView.js'
import { createSpectralRepairController } from './SpectralRepairView.js'
import { formatHz, normalizeRegions } from '../domain/spectralLayout.js'
import { loopLayout, clipToSource, sourceToClip } from '../domain/loopLayout.js'
import { createEqEditorController, Q_MIN, Q_MAX, SLOPE_CAPABLE_EQ_TYPES } from './EqEditor.js'
import { createWaveformScrollbar } from './WaveformScrollbar.js'
import { createFluctuationBar } from './FluctuationBar.js'
import { normalizeFluctuationAxis } from '../audio/Modulator.js'
import { formatDuration, parseDuration } from '../domain/time.js'
import { mountFilterControls } from './FilterControls.jsx'
import { MAX_BUFFER_CLIP_SECONDS, applySoundOverride, DEFAULT_CROSSFADE_MS, SEAM_LEAD_SECONDS, SEAM_TAIL_SECONDS, HISTORY_COMMIT_DEBOUNCE_MS, HISTORY_LIMIT, AUTOSAVE_IDLE_MS, defaultEqBands, defaultVolumeEnvelope, NEUTRAL_FILTERS, FLUC_VOL_MIN, FLUC_VOL_MAX, FLUC_PITCH_MIN, FLUC_PITCH_MAX, FLUC_PAN_MIN, FLUC_PAN_MAX, PAN_DRIFT_DEFAULTS, formatPan, defaultFluctuation, FILTER_PRESETS, NEUTRAL_WHOLE_MIX, NEUTRAL_GROUP_FILTERS, defaultMixFluctuation, flucSeconds, SHOT_AXES, shotBiasDefault, SHOT_AXIS_NAMES, cloneWholeMix, wholeMixEqual, cloneGroupFilters, groupFiltersEqual } from '../domain/mixSettings.js'
import { PLAY_ICON_SVG, PAUSE_ICON_SVG, VOLUME_ICON_SVG, MUTE_ICON_SVG } from './icons.js'
import { wireNameMarquee } from './nameMarquee.js'
import { fluctuationTimingMarkup, driftAxisTogglesMarkup, shotAxisMarkup, mixFluctuationMarkup } from './markup.js'
import { requestAnalyser, requestMixerStatus } from './mixerBridge.js'
import { pushLevel, peakFromTimeDomain } from '../domain/levels.js'
import { drawLevelHistory } from './levelHistory.js'
import { escapeHtml } from '../domain/html.js'

export default class EditorPlugin {
  constructor(app) {
    this.app = app
    this.api = app.noctivago
    this.engine = new AudioEngine()

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
    // BakedClipPreview.js's own doc comment for why this exists (Doppler and
    // Reverse have no live preview at all; Pitch is only a rough
    // approximation). 'live' (the editable Web Audio chain, previewSource)
    // or 'saved' (the actual baked clip file, bakedPreview) - always reset
    // to 'live' on a fresh load() since a new sound's own bake (if any) is
    // unrelated to whatever was being auditioned before. Otherwise sticky
    // (v0.1.142) - no longer force-reverted to 'live' just because an edit
    // made the bake stale, see savedPreviewEligible()/updatePreviewModeToggle().
    this.previewMode = 'live'
    this.bakedPreview = null
    this.previewRafId = null
    this.loopEditorController = null
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
    this.historyStack = []
    this.historyIndex = -1
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
    this._autosaveTimer = null
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
    container.innerHTML = `
      <div class="editor-tab">
        <div class="editor-mode-switch-row">
          <div class="editor-mode-switch">
            <button id="editor-mode-sound" class="editor-mode-pill editor-mode-pill-active" type="button">Sound</button>
            <button id="editor-mode-preset" class="editor-mode-pill" type="button">Preset</button>
            <button id="editor-mode-group" class="editor-mode-pill" type="button">Group</button>
          </div>
          <span id="editor-mode-hint" class="editor-mode-hint">Trim, filters, EQ and live preview for one sound at a time.</span>
        </div>

        <div id="editor-mix-picker-row" class="editor-mix-picker-row hidden">
          <span>Preset</span>
          <select id="editor-mix-preset-select"></select>
          <span id="editor-mix-group-select-label" class="hidden">Group</span>
          <select id="editor-mix-group-select" class="hidden"></select>
          <button id="editor-mix-group-new" class="btn btn-small hidden" type="button">+ New group</button>
        </div>

        <div id="editor-mode-panel-preset" class="editor-mode-panel hidden">
          <div id="editor-mix-preset-controls" class="editor-mix-controls editor-mix-disabled">
            <p class="editor-mix-status">Live loudness (last ~10s) - hit Play above to hear and see this preset.</p>
            <canvas id="editor-mix-preset-waveform" class="editor-mix-waveform-canvas"></canvas>
            <div class="editor-filters">
              <label>
                <span>High-pass</span>
                <input id="editor-mix-preset-highpass" type="range" min="0" max="2000" value="0" step="10" />
                <span id="editor-mix-preset-highpass-value" class="editor-filter-value">Off</span>
              </label>
              <label>
                <span>Low-pass</span>
                <input id="editor-mix-preset-lowpass" type="range" min="150" max="20000" value="20000" step="50" />
                <span id="editor-mix-preset-lowpass-value" class="editor-filter-value">Off</span>
              </label>
              <label>
                <span>Gain</span>
                <input id="editor-mix-preset-gain" type="range" min="-24" max="24" value="0" step="1" />
                <span id="editor-mix-preset-gain-value" class="editor-filter-value">0 dB</span>
              </label>
              <label>
                <span>Echo delay</span>
                <input id="editor-mix-preset-echo-delay" type="range" min="0" max="1500" value="0" step="10" />
                <span id="editor-mix-preset-echo-delay-value" class="editor-filter-value">Off</span>
              </label>
              <label>
                <span>Echo decay</span>
                <input id="editor-mix-preset-echo-decay" type="range" min="0" max="0.85" value="0" step="0.01" />
                <span id="editor-mix-preset-echo-decay-value" class="editor-filter-value">Off</span>
              </label>
              <label>
                <span>Reverb size</span>
                <input id="editor-mix-preset-reverb-size" type="range" min="0" max="4000" value="0" step="100" />
                <span id="editor-mix-preset-reverb-size-value" class="editor-filter-value">Off</span>
              </label>
              <label>
                <span>Reverb mix</span>
                <input id="editor-mix-preset-reverb-mix" type="range" min="0" max="1" value="0" step="0.01" />
                <span id="editor-mix-preset-reverb-mix-value" class="editor-filter-value">Off</span>
              </label>
              <label>
                <span>Fade in</span>
                <input id="editor-mix-preset-fadein" type="number" min="0" max="60" step="0.5" value="0" />
                <span class="editor-filter-value">s — eases the whole mix up when the preset loads</span>
              </label>
            </div>
            <div class="editor-eq">
              <div class="editor-eq-header">
                <span class="editor-eq-label">Parametric EQ</span>
                <div class="editor-eq-compare" role="group" aria-label="Compare current session vs. last saved">
                  <button id="editor-mix-preset-eq-compare-a" class="editor-eq-compare-btn editor-eq-compare-btn-active" type="button" title="Current session (editable)">A</button>
                  <button id="editor-mix-preset-eq-compare-b" class="editor-eq-compare-btn" type="button" title="Last saved mix (read-only)">B</button>
                </div>
                <button id="editor-mix-preset-eq-add-band" class="btn btn-svg-icon" type="button" title="Add a band">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                </button>
                <button id="editor-mix-preset-eq-remove-band" class="btn btn-svg-icon" type="button" title="Delete the selected band (or drag a node here)">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m5 0V4a2 2 0 0 1 2-2h0a2 2 0 0 1 2 2v2"/></svg>
                </button>
                <button id="editor-mix-preset-eq-reset" class="btn btn-small btn-icon-text" type="button">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
                  Reset EQ
                </button>
                <button id="editor-mix-preset-eq-zoom-out" class="btn btn-svg-icon" type="button" title="Zoom out on the frequency axis (or scroll over empty graph space)">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="8" y1="11" x2="14" y2="11"/></svg>
                </button>
                <button id="editor-mix-preset-eq-zoom-in" class="btn btn-svg-icon" type="button" title="Zoom in on the frequency axis (or scroll over empty graph space)">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>
                </button>
                <button id="editor-mix-preset-eq-invert" class="btn btn-small btn-icon-text" type="button" title="Flip every band's gain (boosts become cuts and vice versa)">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
                  Invert
                </button>
              </div>
              <button id="editor-mix-preset-eq-revert-banner" class="editor-eq-revert-banner hidden" type="button">Click to revert to previous session's mix</button>
              <canvas id="editor-mix-preset-eq-canvas" class="editor-mix-eq-canvas" title="Drag a node to adjust frequency/gain (hold Ctrl while dragging for finer control). Scroll over a node to adjust its Q. Double-click a node to reset its gain; Alt+click for a full reset."></canvas>
              <div class="editor-mix-eq-fields">
                <label><span>Type</span>
                  <select id="editor-mix-preset-eq-type">
                    <option value="off">Off</option>
                    <option value="lowpass">Low Pass</option>
                    <option value="highpass">High Pass</option>
                    <option value="bandpass">Band Pass</option>
                    <option value="notch">Notch</option>
                    <option value="lowshelf">Low Shelf</option>
                    <option value="highshelf">High Shelf</option>
                    <option value="peaking" selected>Peaking</option>
                  </select>
                </label>
                <label id="editor-mix-preset-eq-slope-label"><span>Slope</span>
                  <select id="editor-mix-preset-eq-slope">
                    <option value="gentle" selected>Gentle</option>
                    <option value="steep">Steep</option>
                  </select>
                </label>
                <label><span>Freq</span><input id="editor-mix-preset-eq-freq" type="number" min="20" max="20000" step="1" /></label>
                <label><span>Gain</span><input id="editor-mix-preset-eq-gain" type="number" min="-24" max="24" step="0.1" /></label>
                <label><span>Q</span><input id="editor-mix-preset-eq-q" type="number" min="0.1" max="20" step="0.1" /></label>
                <button id="editor-mix-preset-eq-mute" class="editor-eq-toggle-btn" type="button" title="Mute this band (keeps its settings, just stops applying it)">Mute</button>
                <button id="editor-mix-preset-eq-solo" class="editor-eq-toggle-btn" type="button" title="Solo this band (hear only its effect, for auditioning while tuning)">Solo</button>
              </div>
            </div>
            <div class="editor-presets">
              <span class="editor-presets-label">Presets</span>
              <button class="btn btn-small" type="button" data-mix-preset-effect="muffled">Muffled</button>
              <button class="btn btn-small" type="button" data-mix-preset-effect="phone">Over the Phone</button>
              <button class="btn btn-small" type="button" data-mix-preset-effect="radio">On the Radio</button>
              <button class="btn btn-small" type="button" data-mix-preset-effect="distant">Distant</button>
              <button class="btn btn-small" type="button" data-mix-preset-effect="echo">Echo</button>
              <button class="btn btn-small" type="button" data-mix-preset-effect="reverb">Reverb</button>
              <button class="btn btn-small" type="button" data-mix-preset-effect="underwater">Underwater</button>
            </div>
            <div class="editor-actions">
              <button id="editor-mix-preset-reset-filters" class="btn btn-icon-text" type="button">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
                Reset filters
              </button>
            </div>
${mixFluctuationMarkup('preset')}
            <p id="editor-mix-preset-hint" class="editor-mix-status">Pick a preset above. These settings are saved on it and heard live on the whole mix whenever it's loaded in the Mixer.</p>
          </div>
        </div>

        <div id="editor-mode-panel-group" class="editor-mode-panel hidden">
          <div id="editor-mix-group-editor" class="editor-mix-group-editor hidden">
            <div class="editor-mix-row">
              <span>Name</span>
              <input id="editor-mix-group-name" type="text" />
            </div>
            <p class="editor-mix-status">Live loudness (last ~10s) - hit Play above to hear and see just this group.</p>
            <canvas id="editor-mix-group-waveform" class="editor-mix-waveform-canvas"></canvas>
            <p class="editor-mix-status">Sounds in this preset's mix:</p>
            <ul id="editor-mix-group-members" class="editor-mix-group-members"></ul>
            <div class="editor-filters">
              <label>
                <span>High-pass</span>
                <input id="editor-mix-group-highpass" type="range" min="0" max="2000" value="0" step="10" />
                <span id="editor-mix-group-highpass-value" class="editor-filter-value">Off</span>
              </label>
              <label>
                <span>Low-pass</span>
                <input id="editor-mix-group-lowpass" type="range" min="150" max="20000" value="20000" step="50" />
                <span id="editor-mix-group-lowpass-value" class="editor-filter-value">Off</span>
              </label>
              <label>
                <span>Gain</span>
                <input id="editor-mix-group-gain" type="range" min="-24" max="24" value="0" step="1" />
                <span id="editor-mix-group-gain-value" class="editor-filter-value">0 dB</span>
              </label>
              <label>
                <span>Echo delay</span>
                <input id="editor-mix-group-echo-delay" type="range" min="0" max="1500" value="0" step="10" />
                <span id="editor-mix-group-echo-delay-value" class="editor-filter-value">Off</span>
              </label>
              <label>
                <span>Echo decay</span>
                <input id="editor-mix-group-echo-decay" type="range" min="0" max="0.85" value="0" step="0.01" />
                <span id="editor-mix-group-echo-decay-value" class="editor-filter-value">Off</span>
              </label>
              <label>
                <span>Reverb size</span>
                <input id="editor-mix-group-reverb-size" type="range" min="0" max="4000" value="0" step="100" />
                <span id="editor-mix-group-reverb-size-value" class="editor-filter-value">Off</span>
              </label>
              <label>
                <span>Reverb mix</span>
                <input id="editor-mix-group-reverb-mix" type="range" min="0" max="1" value="0" step="0.01" />
                <span id="editor-mix-group-reverb-mix-value" class="editor-filter-value">Off</span>
              </label>
              <label title="Sounds like this group is behind a wall or door - pulls the lowpass down and pushes reverb up together, on top of whatever Lowpass/Reverb are already set above. Left edge = off.">
                <span>Occlusion</span>
                <input id="editor-mix-group-occlusion" type="range" min="0" max="1" value="0" step="0.01" />
                <span id="editor-mix-group-occlusion-value" class="editor-filter-value">Off</span>
              </label>
            </div>
            <div class="editor-eq">
              <div class="editor-eq-header">
                <span class="editor-eq-label">Parametric EQ</span>
                <div class="editor-eq-compare" role="group" aria-label="Compare current session vs. last saved">
                  <button id="editor-mix-group-eq-compare-a" class="editor-eq-compare-btn editor-eq-compare-btn-active" type="button" title="Current session (editable)">A</button>
                  <button id="editor-mix-group-eq-compare-b" class="editor-eq-compare-btn" type="button" title="Last saved group (read-only)">B</button>
                </div>
                <button id="editor-mix-group-eq-add-band" class="btn btn-svg-icon" type="button" title="Add a band">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                </button>
                <button id="editor-mix-group-eq-remove-band" class="btn btn-svg-icon" type="button" title="Delete the selected band (or drag a node here)">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m5 0V4a2 2 0 0 1 2-2h0a2 2 0 0 1 2 2v2"/></svg>
                </button>
                <button id="editor-mix-group-eq-reset" class="btn btn-small btn-icon-text" type="button">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
                  Reset EQ
                </button>
                <button id="editor-mix-group-eq-zoom-out" class="btn btn-svg-icon" type="button" title="Zoom out on the frequency axis (or scroll over empty graph space)">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="8" y1="11" x2="14" y2="11"/></svg>
                </button>
                <button id="editor-mix-group-eq-zoom-in" class="btn btn-svg-icon" type="button" title="Zoom in on the frequency axis (or scroll over empty graph space)">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>
                </button>
                <button id="editor-mix-group-eq-invert" class="btn btn-small btn-icon-text" type="button" title="Flip every band's gain (boosts become cuts and vice versa)">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
                  Invert
                </button>
              </div>
              <button id="editor-mix-group-eq-revert-banner" class="editor-eq-revert-banner hidden" type="button">Click to revert to previous session's group</button>
              <canvas id="editor-mix-group-eq-canvas" class="editor-mix-eq-canvas" title="Drag a node to adjust frequency/gain (hold Ctrl while dragging for finer control). Scroll over a node to adjust its Q. Double-click a node to reset its gain; Alt+click for a full reset."></canvas>
              <div class="editor-mix-eq-fields">
                <label><span>Type</span>
                  <select id="editor-mix-group-eq-type">
                    <option value="off">Off</option>
                    <option value="lowpass">Low Pass</option>
                    <option value="highpass">High Pass</option>
                    <option value="bandpass">Band Pass</option>
                    <option value="notch">Notch</option>
                    <option value="lowshelf">Low Shelf</option>
                    <option value="highshelf">High Shelf</option>
                    <option value="peaking" selected>Peaking</option>
                  </select>
                </label>
                <label id="editor-mix-group-eq-slope-label"><span>Slope</span>
                  <select id="editor-mix-group-eq-slope">
                    <option value="gentle" selected>Gentle</option>
                    <option value="steep">Steep</option>
                  </select>
                </label>
                <label><span>Freq</span><input id="editor-mix-group-eq-freq" type="number" min="20" max="20000" step="1" /></label>
                <label><span>Gain</span><input id="editor-mix-group-eq-gain" type="number" min="-24" max="24" step="0.1" /></label>
                <label><span>Q</span><input id="editor-mix-group-eq-q" type="number" min="0.1" max="20" step="0.1" /></label>
                <button id="editor-mix-group-eq-mute" class="editor-eq-toggle-btn" type="button" title="Mute this band (keeps its settings, just stops applying it)">Mute</button>
                <button id="editor-mix-group-eq-solo" class="editor-eq-toggle-btn" type="button" title="Solo this band (hear only its effect, for auditioning while tuning)">Solo</button>
              </div>
            </div>
            <div class="editor-presets">
              <span class="editor-presets-label">Presets</span>
              <button class="btn btn-small" type="button" data-mix-group-effect="muffled">Muffled</button>
              <button class="btn btn-small" type="button" data-mix-group-effect="phone">Over the Phone</button>
              <button class="btn btn-small" type="button" data-mix-group-effect="radio">On the Radio</button>
              <button class="btn btn-small" type="button" data-mix-group-effect="distant">Distant</button>
              <button class="btn btn-small" type="button" data-mix-group-effect="echo">Echo</button>
              <button class="btn btn-small" type="button" data-mix-group-effect="reverb">Reverb</button>
              <button class="btn btn-small" type="button" data-mix-group-effect="underwater">Underwater</button>
            </div>
            <div class="editor-actions">
              <button id="editor-mix-group-reset-filters" class="btn btn-icon-text" type="button">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
                Reset filters
              </button>
            </div>
${mixFluctuationMarkup('group')}
          </div>
          <p id="editor-mix-group-empty" class="editor-mix-status">Pick a preset above, then create or pick a group to EQ some of its sounds together (e.g. crickets + toads to sound like they're outside).</p>
        </div>

        <div id="editor-mode-panel-sound">
        <div class="editor-picker">
          <input id="editor-sound-search" type="text" class="editor-sound-search" placeholder="Select a sound to edit…" autocomplete="off" />
          <ul id="editor-sound-options" class="editor-sound-options hidden"></ul>
        </div>
        <div id="editor-panel" class="editor-panel hidden">
          <div class="editor-name-row">
            <h3 id="editor-sound-name"></h3>
            <label id="editor-sync-group-row" class="editor-sync-group-row hidden">
              <span>Sync group</span>
              <input id="editor-scatter-sync-group" type="text" placeholder="e.g. door-effects" title="Give two or more Random Interval sounds the same name to make them always fire together - one starts, all start." />
            </label>
          </div>
          <canvas id="editor-canvas" width="640" height="160" title="Scroll to zoom, shift+scroll or middle-drag to pan. Right-click-drag inside the trimmed region to move it."></canvas>
          <div id="editor-scrollbar" class="editor-scrollbar">
            <div id="editor-scrollbar-thumb" class="editor-scrollbar-thumb"></div>
          </div>
          <p id="editor-waveform-status" class="editor-waveform-status"></p>
          <div class="editor-times">
            <label>Start <input id="editor-start-input" type="text" inputmode="numeric" placeholder="0:00" /></label>
            <label>End <input id="editor-end-input" type="text" inputmode="numeric" placeholder="0:00" /></label>
            <label>Length <input id="editor-length-input" type="text" inputmode="numeric" placeholder="0:00" /></label>
            <label class="editor-reverse-toggle">
              <input id="editor-doppler" type="checkbox" />
              Doppler (pass-by)
            </label>
          </div>
          <div class="editor-suggest-loop-row">
            <button id="editor-suggest-loop" class="btn btn-small btn-icon-text" type="button" title="Analyze the file and propose a seamless loop region. You can still adjust Start/End afterward.">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v4M12 18v4M4.9 4.9l2.8 2.8M16.3 16.3l2.8 2.8M2 12h4M18 12h4M4.9 19.1l2.8-2.8M16.3 7.7l2.8-2.8"/></svg>
              Suggest a loop point
            </button>
            <span id="editor-suggest-status" class="editor-suggest-status"></span>
          </div>
          <div id="editor-doppler-options" class="editor-speed-pitch hidden">
            <label>
              <span>Intensity</span>
              <input id="editor-doppler-intensity" type="range" min="1" max="12" value="5" step="1" />
              <span id="editor-doppler-intensity-value" class="editor-filter-value">5 st</span>
            </label>
            <label>
              <span>Sharpness</span>
              <input id="editor-doppler-sharpness" type="range" min="0" max="100" value="50" step="1" />
              <span id="editor-doppler-sharpness-value" class="editor-filter-value">50%</span>
            </label>
            <label class="editor-reverse-toggle">
              <input id="editor-doppler-reversed" type="checkbox" />
              Reverse (peak = furthest point, not closest)
            </label>
          </div>
          <p id="editor-doppler-hint" class="editor-speed-pitch-hint hidden">Simulates a sound passing by: pitch rises approaching the closest point (the gold marker on the waveform - drag it to control how fast each side ramps, double-click to re-center), then falls as it recedes toward Start/End. Reverse flips that: Start/End become the natural-pitch points and the marker becomes the peak shift instead — a sharp close pass-by rather than an approach/recede. Intensity sets how many semitones the shift swings; Sharpness sets how abruptly it swings through the marker — low is a slow continuous glide, high sits flat and does the whole swing in a burst right at the marker (the real pass-by whoosh). Only takes effect once saved (loops under 10 minutes) - no live preview while dragging.</p>
          <div class="editor-playmode">
            <span class="editor-playmode-label">Playback mode</span>
            <label class="editor-playmode-option">
              <input type="radio" name="editor-playmode" id="editor-playmode-loop" value="loop" checked />
              Loop
            </label>
            <label class="editor-playmode-option">
              <input type="radio" name="editor-playmode" id="editor-playmode-scatter" value="scatter" />
              Random interval
            </label>
            <label class="editor-playmode-option">
              <input type="radio" name="editor-playmode" id="editor-playmode-scheduled" value="scheduled" />
              Scheduled
            </label>
            <p class="editor-playmode-hint">Random interval replays this clip at a random gap instead of looping it back-to-back — good for a short, event-like sound (a creak, a bird call) inside a longer ambient mix. Scheduled instead plays it once at real-world clock times you set — a church bell at noon, an hourly chime.</p>
          </div>
          <div id="editor-fade-section" class="editor-fade-section hidden">
            <div class="editor-fade-heading">Fade shot edges <span class="editor-fluctuation-sub">(eases each play's start/end instead of a hard cut — drag the pins at the trim edges on the waveform above, or set exact values here)</span></div>
            <div id="editor-scatter-fade-fields" class="editor-fade-fields">
              <label class="editor-fade-enable">
                <input id="editor-scatter-fade-enabled" type="checkbox" />
                <span>Fade</span>
              </label>
              <label>
                <span>In</span>
                <input id="editor-scatter-fade-in" type="number" min="0" max="10000" step="50" value="0" disabled />
                <span class="editor-filter-value">ms</span>
              </label>
              <label>
                <span>Out</span>
                <input id="editor-scatter-fade-out" type="number" min="0" max="10000" step="50" value="0" disabled />
                <span class="editor-filter-value">ms</span>
              </label>
            </div>
            <div id="editor-schedule-fade-fields" class="editor-fade-fields">
              <label class="editor-fade-enable">
                <input id="editor-schedule-fade-enabled" type="checkbox" />
                <span>Fade</span>
              </label>
              <label>
                <span>In</span>
                <input id="editor-schedule-fade-in" type="number" min="0" max="10000" step="50" value="0" disabled />
                <span class="editor-filter-value">ms</span>
              </label>
              <label>
                <span>Out</span>
                <input id="editor-schedule-fade-out" type="number" min="0" max="10000" step="50" value="0" disabled />
                <span class="editor-filter-value">ms</span>
              </label>
            </div>
          </div>
          <div id="editor-crossfade-section" class="editor-crossfade">
            <div class="editor-seam-heading">Loop seam</div>
            <canvas id="editor-seam-canvas" class="editor-seam-canvas" title="How the loop plays: the end of the trim crossfades into its start in the middle. Drag an edge of the crossfade to resize it, double-click an edge to reset it, click anywhere else to jump there."></canvas>
            <label>
              <span>Loop crossfade</span>
              <input id="editor-crossfade" type="range" min="0" max="2000" value="200" step="10" />
              <span id="editor-crossfade-value" class="editor-filter-value">200 ms</span>
            </label>
            <div class="editor-seam-row">
              <button id="editor-seam-listen" class="btn btn-small" type="button" title="Play the few seconds around the loop point, through the crossfade, then stop">Listen to the seam</button>
              <span id="editor-seam-status" class="editor-suggest-status"></span>
            </div>
            <p class="editor-crossfade-hint">The saved loop is the second half of your trim, then the first half, with the end of the trim crossfading into its start in the middle, so the loop's own restart falls on one continuous recording. Longer crossfades help busy, textured audio (rain, fire, crowds); 0 turns blending off. Capped at a quarter of the trim, and the loop plays that much shorter.</p>
            <label class="editor-reverse-toggle">
              <input id="editor-envelope-enabled" type="checkbox" />
              Volume envelope
            </label>
            <button id="editor-envelope-reset" class="btn btn-small btn-icon-text" type="button">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
              Reset envelope
            </button>
            <p class="editor-crossfade-hint">Drag points directly on the waveform above to shape this sound's volume over time instead of one flat level (double-click empty space on the line to add a point, double-click a point to reset it to full, right-click a point to remove it). Attenuates only — never boosts above the sound's own level.</p>
          </div>
          <div id="editor-scatter-section" class="editor-scatter-controls hidden">
            <div class="editor-fluctuation-axis editor-gap-axis">
              <span class="editor-fluctuation-enable">Gap <span class="editor-fluctuation-sub">(how long to wait between replays)</span></span>
              <div class="editor-gap-range">
                <label>
                  <span>Min</span>
                  <input id="editor-scatter-gap-min" type="number" min="0" max="3600" step="1" value="5" />
                  <span class="editor-filter-value">s</span>
                </label>
                <label>
                  <span>Max</span>
                  <input id="editor-scatter-gap-max" type="number" min="0" max="3600" step="1" value="35" />
                  <span class="editor-filter-value">s</span>
                </label>
                <label>
                  <span>Bias</span>
                  <input id="editor-scatter-gap-bias" type="number" min="0" max="3600" step="1" value="20" />
                  <span class="editor-filter-value">s</span>
                </label>
              </div>
              <div class="editor-fluctuation-knobs">
                <label class="editor-fluctuation-fullrandom">
                  <input id="editor-scatter-gap-fully-random" type="checkbox" />
                  <span>Fully random <span class="editor-fluctuation-sub">(a new random wait, 0–2 min, before every replay — ignores Min/Max above)</span></span>
                </label>
                <label class="editor-fluctuation-fullrandom">
                  <input id="editor-scatter-gap-bias-enabled" type="checkbox" />
                  <span>Bias <span class="editor-fluctuation-sub">(this gap wins more often than a plain random pick within Min/Max)</span></span>
                </label>
              </div>
            </div>
            <p id="editor-scatter-group-note" class="editor-scatter-hint hidden"></p>
${shotAxisMarkup('editor-scatter-pitch', 'Pitch', '(a random shift every replay)')}
${shotAxisMarkup('editor-scatter-volume', 'Volume', '(a random level every replay; never above the sound\'s own)')}
${shotAxisMarkup('editor-scatter-pan', 'Pan', '(a random left/right position every replay)')}
${shotAxisMarkup('editor-scatter-speed', 'Speed', '(a random tempo every replay, 50–200%)')}
            <p class="editor-scatter-hint">Each replay picks a random gap, pitch, volume, pan, and speed within these ranges — or check "Fully random" to roll the whole range regardless of the min/max. Check "Bias" to make one value inside the range (the middle circle) win more often than a plain random pick. On the bars, drag the outer circles for the range; when they sit together there's no variation. Speed changes each shot's tempo/length with its pitch left alone. Fade (above, near the waveform) eases each shot's start/end instead of a hard cut. Sync group (next to the sound's name) makes two or more scatter sounds always fire together - one starts, all start.</p>
          </div>
          <div id="editor-schedule-section" class="editor-scatter-controls hidden">
            <label class="editor-playmode-option">
              <input type="radio" name="editor-schedule-type" id="editor-schedule-type-times" value="times" checked />
              Fixed times
            </label>
            <label class="editor-playmode-option">
              <input type="radio" name="editor-schedule-type" id="editor-schedule-type-interval" value="interval" />
              Recurring interval
            </label>
            <label id="editor-schedule-times-row">
              <span>Times (24h, comma-separated)</span>
              <input id="editor-schedule-times" type="text" inputmode="numeric" placeholder="12:00, 00:00" />
            </label>
            <label id="editor-schedule-interval-row" class="hidden">
              <span>Every</span>
              <input id="editor-schedule-interval" type="number" min="1" max="1440" step="1" value="60" />
              <span class="editor-filter-value">minutes</span>
            </label>
            <p id="editor-schedule-group-note" class="editor-scatter-hint hidden"></p>
${shotAxisMarkup('editor-schedule-pitch', 'Pitch', '(a random shift every trigger)')}
${shotAxisMarkup('editor-schedule-volume', 'Volume', '(a random level every trigger; never above the sound\'s own)')}
${shotAxisMarkup('editor-schedule-pan', 'Pan', '(a random left/right position every trigger)')}
${shotAxisMarkup('editor-schedule-speed', 'Speed', '(a random tempo every trigger, 50–200%)')}
            <p class="editor-schedule-hint">Fixed times play once at each listed clock time (24h HH:MM), every day. Recurring interval plays every N minutes, aligned to midnight — 60 lands on the hour, 30 on the hour and half-hour, like a digital clock rather than counting from whenever the app started. Each trigger picks a random pitch, volume, pan, and speed within these ranges, same as Random Interval — or check "Fully random" to roll the whole range regardless of the circles. Check "Bias" to make the middle circle's value win more often than a plain random pick. When a bar's outer circles sit together there's no variation. Speed changes each trigger's tempo/length with its pitch left alone. Fade (above, near the waveform) eases each trigger's start/end instead of a hard cut.</p>
          </div>
          <div class="editor-speed-pitch">
            <label>
              <span>Speed</span>
              <input id="editor-speed" type="range" min="50" max="200" value="100" step="5" />
              <span id="editor-speed-value" class="editor-filter-value">100%</span>
            </label>
            <label>
              <span>Pitch</span>
              <input id="editor-pitch" type="range" min="-12" max="12" value="0" step="1" />
              <span id="editor-pitch-value" class="editor-filter-value">Off</span>
            </label>
            <label class="editor-reverse-toggle">
              <input id="editor-reverse" type="checkbox" />
              Reverse
            </label>
            <p class="editor-speed-pitch-hint">Speed applies live, even for sounds too long to bake into a clip. Pitch and Reverse only take effect once saved (loops under 10 minutes) — Pitch previews approximately while dragging (briefly affects tempo too); Reverse has no live preview at all.</p>
          </div>
          <div id="editor-filters" class="editor-filters"></div>
          <div class="editor-eq">
            <div class="editor-eq-header">
              <span class="editor-eq-label">Parametric EQ</span>
              <div class="editor-eq-compare" role="group" aria-label="Compare current session vs. last saved">
                <button id="editor-eq-compare-a" class="editor-eq-compare-btn editor-eq-compare-btn-active" type="button" title="Current session (editable)">A</button>
                <button id="editor-eq-compare-b" class="editor-eq-compare-btn" type="button" title="Last saved mix (read-only)">B</button>
              </div>
              <button id="editor-eq-add-band" class="btn btn-svg-icon" type="button" title="Add a band">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              </button>
              <button id="editor-eq-remove-band" class="btn btn-svg-icon" type="button" title="Delete the selected band (or drag a node here)">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m5 0V4a2 2 0 0 1 2-2h0a2 2 0 0 1 2 2v2"/></svg>
              </button>
              <button id="editor-eq-reset" class="btn btn-small btn-icon-text" type="button">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
                Reset EQ
              </button>
              <button id="editor-eq-zoom-out" class="btn btn-svg-icon" type="button" title="Zoom out on the frequency axis (or scroll over empty graph space)">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="8" y1="11" x2="14" y2="11"/></svg>
              </button>
              <button id="editor-eq-zoom-in" class="btn btn-svg-icon" type="button" title="Zoom in on the frequency axis (or scroll over empty graph space)">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>
              </button>
              <button id="editor-eq-invert" class="btn btn-small btn-icon-text" type="button" title="Flip every band's gain (boosts become cuts and vice versa)">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
                Invert
              </button>
            </div>
            <button id="editor-eq-revert-banner" class="editor-eq-revert-banner hidden" type="button">Click to revert to previous session's mix</button>
            <canvas id="editor-eq-canvas" width="640" height="140" title="Drag a node to adjust frequency/gain (hold Ctrl while dragging for finer control). Scroll over a node to adjust its Q. Double-click a node to reset its gain; Alt+click for a full reset."></canvas>
            <div class="editor-eq-band-controls">
              <label>
                <span>Type</span>
                <select id="editor-eq-type">
                  <option value="off">Off</option>
                  <option value="lowpass">Low Pass</option>
                  <option value="highpass">High Pass</option>
                  <option value="bandpass">Band Pass</option>
                  <option value="notch">Notch</option>
                  <option value="lowshelf">Low Shelf</option>
                  <option value="highshelf">High Shelf</option>
                  <option value="peaking" selected>Peaking</option>
                </select>
              </label>
              <label id="editor-eq-slope-label">
                <span>Slope</span>
                <select id="editor-eq-slope">
                  <option value="gentle" selected>Gentle</option>
                  <option value="steep">Steep</option>
                </select>
              </label>
              <label>
                <span>Freq</span>
                <input id="editor-eq-freq" type="number" min="20" max="20000" step="1" />
                <span class="editor-filter-value">Hz</span>
              </label>
              <label>
                <span>Gain</span>
                <input id="editor-eq-gain" type="number" min="-24" max="24" step="0.1" />
                <span class="editor-filter-value">dB</span>
              </label>
              <label>
                <span>Q</span>
                <input id="editor-eq-q" type="number" min="0.1" max="20" step="0.1" />
              </label>
              <button id="editor-eq-mute" class="editor-eq-toggle-btn" type="button" title="Mute this band (keeps its settings, just stops applying it)">Mute</button>
              <button id="editor-eq-solo" class="editor-eq-toggle-btn" type="button" title="Solo this band (hear only its effect, for auditioning while tuning)">Solo</button>
            </div>
            <p class="editor-eq-hint">Click + to add a band, drag it to shape it (hold Ctrl while dragging for finer control), or type exact values above for the selected (highlighted) band. Scroll over a node to adjust its Q. Double-click resets just its gain; Alt+click fully resets it. The trash button (or dragging a node onto it) deletes the selected band. Mute silences a band without losing its settings; Solo hears only that band while tuning. The pink spectrum shows the sound's own content and doesn't change as you drag bands; the red-shaded regions show which frequencies your current bands would actually cut.</p>
          </div>
          <div id="editor-spectral-section" class="editor-spectral">
            <div class="editor-eq-header">
              <span class="editor-eq-label">Spectral repair</span>
              <button id="editor-spectral-delete" class="btn btn-svg-icon" type="button" title="Delete the selected box" disabled>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m5 0V4a2 2 0 0 1 2-2h0a2 2 0 0 1 2 2v2"/></svg>
              </button>
              <button id="editor-spectral-clear" class="btn btn-small btn-icon-text" type="button">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
                Clear all
              </button>
            </div>
            <canvas id="editor-spectral-canvas" class="editor-spectral-canvas" title="Drag to draw a box around a sound to remove. Drag a box to move it, drag its edge to resize it, right-click it (or select it and press Delete) to remove it."></canvas>
            <div class="editor-spectral-controls">
              <span id="editor-spectral-selection" class="editor-spectral-selection">No box selected</span>
              <label>
                <span>Reduce by</span>
                <input id="editor-spectral-reduction" type="range" min="6" max="80" step="1" value="40" disabled />
                <span id="editor-spectral-reduction-value" class="editor-filter-value">40 dB</span>
              </label>
            </div>
            <p class="editor-eq-hint">Removes a short sound hiding inside another one: a cough in the rain, a bird over the wind, a phone buzz. Find it as a bright spot on the spectrogram (time across, pitch up), drag a box around it, and just that box gets turned down. Everything outside the box stays as it was. Heard after you Save: switch the preview to <strong>Saved audio</strong> to check it.</p>
          </div>
          <div class="editor-presets">
            <span class="editor-presets-label">Presets</span>
            <button class="btn btn-small" type="button" data-preset="muffled">Muffled</button>
            <button class="btn btn-small" type="button" data-preset="phone">Over the Phone</button>
            <button class="btn btn-small" type="button" data-preset="radio">On the Radio</button>
            <button class="btn btn-small" type="button" data-preset="distant">Distant</button>
            <button class="btn btn-small" type="button" data-preset="echo">Echo</button>
            <button class="btn btn-small" type="button" data-preset="reverb">Reverb</button>
            <button class="btn btn-small" type="button" data-preset="underwater">Underwater</button>
          </div>
          <div class="editor-actions">
            <button id="editor-reset-filters" class="btn btn-icon-text" type="button">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
              Reset filters
            </button>
          </div>
          <div id="editor-fluctuation-section" class="editor-fluctuation">
            <div class="editor-fluctuation-head">
              <span class="editor-fluctuation-label">Fluctuation</span>
              <span class="editor-fluctuation-hint">Slow, random drift while the sound loops — wind gusting stronger and weaker, rain swelling and fading, something drifting closer and further. On each bar: drag the outer circles for the lowest/highest it reaches, the middle circle for where it sits most of the time. "Change every" is the seconds between new targets (a random value in that range); "Transition" is roughly how long each glide takes. "Fully random" ignores the circles and roams the whole range. Applies live in the Mixer and the preview, and is baked into exports. Saves on its own the moment you let go of a control — no need to hit Save.</span>
            </div>
            <p id="editor-fluc-group-note" class="editor-fluctuation-hint hidden"></p>
            <p id="editor-fluctuation-saved-note" class="editor-fluctuation-hint hidden">Drift only plays in the <strong>Live edit</strong> preview — the <strong>Saved audio</strong> preview is the baked clip, which never contains it. Switch the preview toggle to Live edit to hear it.</p>
            <div class="editor-fluctuation-axis">
              <label class="editor-fluctuation-enable">
                <input id="editor-fluc-vol-enabled" type="checkbox" />
                Volume drift <span class="editor-fluctuation-sub">(rides below the sound's set volume)</span>
              </label>
              <canvas id="editor-fluc-vol-bar" class="editor-fluctuation-bar" title="Drag the circles. Double-click one to reset it."></canvas>
              ${fluctuationTimingMarkup('editor-fluc-vol')}
              ${driftAxisTogglesMarkup('editor-fluc-vol')}
            </div>
            <div class="editor-fluctuation-axis">
              <label class="editor-fluctuation-enable">
                <input id="editor-fluc-pitch-enabled" type="checkbox" />
                Pitch drift <span class="editor-fluctuation-sub">(small shifts read as a gentle wobble)</span>
              </label>
              <canvas id="editor-fluc-pitch-bar" class="editor-fluctuation-bar" title="Drag the circles. Double-click one to reset it."></canvas>
              ${fluctuationTimingMarkup('editor-fluc-pitch')}
              ${driftAxisTogglesMarkup('editor-fluc-pitch')}
            </div>
            <div class="editor-fluctuation-axis">
              <label class="editor-fluctuation-enable">
                <input id="editor-fluc-pan-enabled" type="checkbox" />
                Pan drift <span class="editor-fluctuation-sub">(wanders left/right, starting from the Pan slider's position)</span>
              </label>
              <canvas id="editor-fluc-pan-bar" class="editor-fluctuation-bar" title="Drag the circles. Double-click one to reset it."></canvas>
              ${fluctuationTimingMarkup('editor-fluc-pan')}
              ${driftAxisTogglesMarkup('editor-fluc-pan')}
            </div>
          </div>
          <p id="editor-save-status" class="editor-save-status"></p>
        </div>
        <p id="editor-empty" class="editor-empty">Select a sound above to trim and apply filters.</p>
        </div>
      </div>
      <button id="editor-scroll-top" class="editor-scroll-top-btn hidden" type="button" title="Scroll to top">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 19V5"/>
          <path d="M5 12l7-7 7 7"/>
        </svg>
      </button>
      <div id="editor-leave-confirm" class="modal hidden">
        <div class="modal-card">
          <h2>Leave with unsaved changes?</h2>
          <p class="modal-hint">Whatever's changed since you opened this sound in Remix hasn't been saved - leaving now discards it.</p>
          <div class="modal-actions">
            <button id="editor-leave-confirm-dont-ask" class="btn" type="button">Don't ask again</button>
            <button id="editor-leave-confirm-no" class="btn" type="button">No</button>
            <button id="editor-leave-confirm-yes" class="btn btn-primary" type="button">Yes</button>
          </div>
        </div>
      </div>
    `

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
      spectralDelete: container.querySelector('#editor-spectral-delete'),
      spectralClear: container.querySelector('#editor-spectral-clear'),
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
      fluctuationSection: container.querySelector('#editor-fluctuation-section'),
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
      mixPresetEqCanvas: container.querySelector('#editor-mix-preset-eq-canvas'),
      mixPresetEqCompareA: container.querySelector('#editor-mix-preset-eq-compare-a'),
      mixPresetEqCompareB: container.querySelector('#editor-mix-preset-eq-compare-b'),
      mixPresetEqRevertBanner: container.querySelector('#editor-mix-preset-eq-revert-banner'),
      mixPresetEqAddBand: container.querySelector('#editor-mix-preset-eq-add-band'),
      mixPresetEqRemoveBand: container.querySelector('#editor-mix-preset-eq-remove-band'),
      mixPresetEqZoomIn: container.querySelector('#editor-mix-preset-eq-zoom-in'),
      mixPresetEqZoomOut: container.querySelector('#editor-mix-preset-eq-zoom-out'),
      mixPresetEqInvert: container.querySelector('#editor-mix-preset-eq-invert'),
      mixPresetEqType: container.querySelector('#editor-mix-preset-eq-type'),
      mixPresetEqSlope: container.querySelector('#editor-mix-preset-eq-slope'),
      mixPresetEqSlopeLabel: container.querySelector('#editor-mix-preset-eq-slope-label'),
      mixPresetEqFreq: container.querySelector('#editor-mix-preset-eq-freq'),
      mixPresetEqGain: container.querySelector('#editor-mix-preset-eq-gain'),
      mixPresetEqQ: container.querySelector('#editor-mix-preset-eq-q'),
      mixPresetEqMute: container.querySelector('#editor-mix-preset-eq-mute'),
      mixPresetEqSolo: container.querySelector('#editor-mix-preset-eq-solo'),
      mixPresetEqReset: container.querySelector('#editor-mix-preset-eq-reset'),
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
      mixGroupEqCanvas: container.querySelector('#editor-mix-group-eq-canvas'),
      mixGroupEqCompareA: container.querySelector('#editor-mix-group-eq-compare-a'),
      mixGroupEqCompareB: container.querySelector('#editor-mix-group-eq-compare-b'),
      mixGroupEqRevertBanner: container.querySelector('#editor-mix-group-eq-revert-banner'),
      mixGroupEqAddBand: container.querySelector('#editor-mix-group-eq-add-band'),
      mixGroupEqRemoveBand: container.querySelector('#editor-mix-group-eq-remove-band'),
      mixGroupEqZoomIn: container.querySelector('#editor-mix-group-eq-zoom-in'),
      mixGroupEqZoomOut: container.querySelector('#editor-mix-group-eq-zoom-out'),
      mixGroupEqInvert: container.querySelector('#editor-mix-group-eq-invert'),
      mixGroupEqType: container.querySelector('#editor-mix-group-eq-type'),
      mixGroupEqSlope: container.querySelector('#editor-mix-group-eq-slope'),
      mixGroupEqSlopeLabel: container.querySelector('#editor-mix-group-eq-slope-label'),
      mixGroupEqFreq: container.querySelector('#editor-mix-group-eq-freq'),
      mixGroupEqGain: container.querySelector('#editor-mix-group-eq-gain'),
      mixGroupEqQ: container.querySelector('#editor-mix-group-eq-q'),
      mixGroupEqMute: container.querySelector('#editor-mix-group-eq-mute'),
      mixGroupEqSolo: container.querySelector('#editor-mix-group-eq-solo'),
      mixGroupEqReset: container.querySelector('#editor-mix-group-eq-reset'),
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
    this.els.spectralReduction.addEventListener('input', () => {
      this.spectralView.setSelectedReduction(Number(this.els.spectralReduction.value))
    })
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
    this.seamView.onViewportChange((sourceRange) => {
      this.scheduleSeamDetailPeaks(sourceRange)
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
    // marker - no live preview to update (Doppler is bake-only, see
    // speedPitch's own doc comment), just the dirty-check/history hook every
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
    this.presetEq = createEqEditorController(this.els.mixPresetEqCanvas)
    this.presetEq.onChange(() => this.applyPresetEqControls())
    this.presetEq.onDoubleClick((index) => {
      this.presetEq.setSelectedIndex(index)
      this.presetEq.setSelectedBand({ gainDb: 0 })
      this.applyPresetEqControls()
    })
    this.presetEq.onAltClick((index) => {
      this.presetEq.setSelectedIndex(index)
      this.presetEq.setSelectedBand({ gainDb: 0, q: 1, type: 'peaking', slope: 'gentle' })
      this.applyPresetEqControls()
    })
    this.presetEq.setTrashDropTarget(this.els.mixPresetEqRemoveBand)

    this.groupEq = createEqEditorController(this.els.mixGroupEqCanvas)
    this.groupEq.onChange(() => this.applyGroupEqControls())
    this.groupEq.onDoubleClick((index) => {
      this.groupEq.setSelectedIndex(index)
      this.groupEq.setSelectedBand({ gainDb: 0 })
      this.applyGroupEqControls()
    })
    this.groupEq.onAltClick((index) => {
      this.groupEq.setSelectedIndex(index)
      this.groupEq.setSelectedBand({ gainDb: 0, q: 1, type: 'peaking', slope: 'gentle' })
      this.applyGroupEqControls()
    })
    this.groupEq.setTrashDropTarget(this.els.mixGroupEqRemoveBand)

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
        this.pickerHighlightIndex = (this.pickerHighlightIndex + 1) % options.length
        this.renderPickerOptions()
      } else if (evt.key === 'ArrowUp') {
        evt.preventDefault()
        if (options.length === 0) return
        this.pickerHighlightIndex = (this.pickerHighlightIndex - 1 + options.length) % options.length
        this.renderPickerOptions()
      } else if (evt.key === 'Enter') {
        evt.preventDefault()
        // Defaults to the first result when nothing's been arrow-navigated
        // yet - requested directly: typing a precise search and hitting
        // Enter shouldn't need an extra arrow-down first, since a precise
        // query usually narrows straight down to the one sound you meant.
        const picked = options[this.pickerHighlightIndex] ?? options[0]
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
      onChange: () => this.applyFilterControls(),
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
      const band = this.eqEditorController.getBands()[idx]
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
    container.innerHTML = `
      <div id="editor-sticky-sound-controls" class="editor-sticky-mode-group">
      <button id="editor-play-pause" class="btn btn-svg-icon" type="button" title="Play">${PLAY_ICON_SVG}</button>
      <button id="editor-loop-toggle" class="editor-loop-icon-btn editor-loop-icon-btn-active" type="button" title="Loop preview" aria-pressed="true">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M17 1l4 4-4 4"/>
          <path d="M3 11V9a4 4 0 0 1 4-4h14"/>
          <path d="M7 23l-4-4 4-4"/>
          <path d="M21 13v2a4 4 0 0 1-4 4H3"/>
        </svg>
      </button>
      <button id="editor-preview-mode-toggle" class="btn btn-small editor-preview-mode-toggle" type="button" disabled>Live edit</button>
      <div id="editor-sticky-progress" class="editor-sticky-progress" title="Drag to seek">
        <div class="editor-sticky-progress-track">
          <div id="editor-sticky-progress-fill" class="editor-sticky-progress-fill"></div>
        </div>
        <div id="editor-sticky-progress-thumb" class="editor-sticky-progress-thumb"></div>
      </div>
      <span id="editor-sticky-time" class="editor-sticky-time">0:00 / 0:00</span>
      <input id="editor-sticky-volume" type="range" min="0" max="100" value="${Math.round(this.previewVolume * 100)}" class="editor-sticky-volume" title="Preview volume" />
      <button id="editor-sticky-mute" class="btn btn-svg-icon" type="button" title="Mute">${VOLUME_ICON_SVG}</button>
      <button id="editor-sticky-solo" class="editor-sticky-solo" type="button" title="Solo: mute every other sound already playing in the Mixer while you audition this one">Solo</button>
      <button id="editor-undo" class="btn btn-svg-icon" type="button" title="Undo (Ctrl+Z)" disabled>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
      </button>
      <button id="editor-redo" class="btn btn-svg-icon" type="button" title="Redo (Ctrl+Shift+Z)" disabled>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-9.36 2.13L23 10"/></svg>
      </button>
      <button id="editor-cancel" class="btn btn-icon-text" type="button" title="Discard every change made since this sound was opened in Remix">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
        Cancel
      </button>
      <button id="editor-save" class="btn btn-primary btn-icon-text editor-sticky-save" type="button">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
        <span id="editor-save-label">Save</span>
      </button>
      <button id="editor-save-as-copy" class="btn btn-icon-text" type="button" title="Trim out just this segment and save it as a brand-new sound, without touching this one's own saved trim - for cutting several segments out of one longer recording">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        Save as copy
      </button>
      </div>
      <div id="editor-sticky-mix-controls" class="editor-sticky-mode-group hidden">
        <button id="editor-mix-play-pause" class="btn btn-svg-icon" type="button" title="Play">${PLAY_ICON_SVG}</button>
        <button id="editor-mix-solo-group" class="editor-sticky-solo hidden" type="button">Solo group</button>
        <span id="editor-mix-status" class="editor-sticky-time"></span>
        <select id="editor-mix-copy-group-to" class="hidden" title="Copy this group's name, filters/EQ and members into another preset - it's governed entirely by whichever preset it ends up in from then on">
          <option value="" selected disabled>Copy to preset…</option>
        </select>
        <button id="editor-mix-delete-group" class="btn btn-danger btn-icon-text hidden" type="button">Delete group</button>
        <button id="editor-mix-save" class="btn btn-primary btn-icon-text editor-sticky-save" type="button">Save</button>
      </div>
    `

    this.els.playPause = container.querySelector('#editor-play-pause')
    this.els.loopToggle = container.querySelector('#editor-loop-toggle')
    this.els.previewModeToggle = container.querySelector('#editor-preview-mode-toggle')
    this.els.previewModeToggle.addEventListener('click', () => this.togglePreviewMode())
    this.els.stickyProgress = container.querySelector('#editor-sticky-progress')
    this.els.stickyProgressFill = container.querySelector('#editor-sticky-progress-fill')
    this.els.stickyProgressThumb = container.querySelector('#editor-sticky-progress-thumb')
    this.els.stickyTime = container.querySelector('#editor-sticky-time')
    this.wireStickyProgressDrag()
    this.els.stickyVolume = container.querySelector('#editor-sticky-volume')
    this.els.stickyMute = container.querySelector('#editor-sticky-mute')
    this.els.stickySolo = container.querySelector('#editor-sticky-solo')
    this.els.undo = container.querySelector('#editor-undo')
    this.els.redo = container.querySelector('#editor-redo')
    this.els.cancel = container.querySelector('#editor-cancel')
    this.els.undo.addEventListener('click', () => this.undo())
    this.els.redo.addEventListener('click', () => this.redo())
    this.els.cancel.addEventListener('click', () => this.cancelEdits())
    this.els.save = container.querySelector('#editor-save')
    this.els.saveLabel = container.querySelector('#editor-save-label')
    this.els.save.addEventListener('click', () => this.save().catch((err) => console.error('Editor: save failed', err)))
    this.els.saveAsCopy = container.querySelector('#editor-save-as-copy')
    this.els.saveAsCopy.addEventListener('click', () => this.saveAsCopy().catch((err) => console.error('Editor: save as copy failed', err)))

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

    this.els.stickySoundControls = container.querySelector('#editor-sticky-sound-controls')
    this.els.stickyMixControls = container.querySelector('#editor-sticky-mix-controls')
    this.els.mixPlayPause = container.querySelector('#editor-mix-play-pause')
    this.els.mixSoloGroup = container.querySelector('#editor-mix-solo-group')
    this.els.mixStatus = container.querySelector('#editor-mix-status')
    this.els.mixSave = container.querySelector('#editor-mix-save')
    this.els.mixDeleteGroup = container.querySelector('#editor-mix-delete-group')
    this.els.mixCopyGroupTo = container.querySelector('#editor-mix-copy-group-to')
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
    if (!eligible && this.previewMode === 'saved' && !this._clipRebaking) {
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
    this.els.previewModeToggle.textContent = this.previewMode === 'saved' ? 'Saved audio' : 'Live edit'
    this.els.previewModeToggle.classList.toggle('editor-preview-mode-toggle-active', this.previewMode === 'saved')
    const stale = this.previewMode === 'saved' && this.hasUnsavedChanges()
    this.els.previewModeToggle.classList.toggle('editor-preview-mode-toggle-stale', stale)
    this.els.previewModeToggle.title = eligible
      ? this.previewMode === 'saved'
        ? stale
          ? 'Hearing the last saved/baked audio - edited since then, autosave will refresh it shortly. Click to switch to the live editable preview'
          : 'Hearing the actual saved/baked audio - click to switch back to the live editable preview'
        : 'Hearing the live editable preview (Doppler, Reverse and Noise reduction have no live preview, and Pitch is only approximate) - click to hear the actual saved audio instead'
      : 'Click to render and hear the actual saved audio'
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
    const activePreset = this.presets.find((p) => p.id === this.activePresetId)
    this.library = library.map((entry) => {
      const override = activePreset?.sounds.find((s) => s.soundId === entry.id)?.overrides
      return applySoundOverride(entry, override)
    })
    if (this.currentEntry) {
      const updated = this.editableSounds().find((s) => s.id === this.currentEntry.id)
      // Don't stomp on text the user is actively typing to search.
      if (updated && document.activeElement !== this.els.soundSearch) this.setSearchValue(updated.name)
      else if (!updated) this.els.soundSearch.value = ''
    }
    if (!this.els.soundOptions.classList.contains('hidden')) this.renderPickerOptions()
  }

  editableSounds() {
    return this.library.filter((s) => s.status !== 'missing')
  }

  filteredPickerSounds() {
    const query = this.pickerQuery.trim().toLowerCase()
    const editable = this.editableSounds()
    if (!query) return editable
    return editable.filter((s) => s.name.toLowerCase().includes(query))
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
      li.textContent = entry.name
      li.title = entry.name
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
    this.currentEntry = null
    this.disposePreview()
    this.els.panel.classList.add('hidden')
    this.els.empty.classList.remove('hidden')
    clearTimeout(this._historyCommitTimer)
    this.historyStack = []
    this.historyIndex = -1
    this.updateUndoRedoButtonsUI()
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
    const bands = this.eqEditorController.getBands()
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
    const key = `${id}:${loopStart}:${loopEnd}`
    if (key === this._spectrogramKey) return
    this._spectrogramKey = key
    this.spectralView.setView(loopStart, loopEnd)
    this.spectralView.setSpectrogram(null, 'Reading the sound…')
    clearTimeout(this._spectrogramTimer)
    this._spectrogramTimer = setTimeout(async () => {
      let spec = null
      try {
        spec = await this.api.audio.getSpectrogram(id, { windowStart: loopStart, windowEnd: loopEnd, ...this.spectralView.requestSize() })
      } catch (err) {
        console.error('Editor: spectrogram fetch failed', err)
      }
      if (key !== this._spectrogramKey) return
      this.spectralView.setSpectrogram(spec, spec ? '' : "Couldn't read this sound")
    }, 250)
  }

  updateSpectralControls() {
    const box = this.spectralView.getSelected()
    this.els.spectralDelete.disabled = !box
    this.els.spectralReduction.disabled = !box
    this.els.spectralClear.disabled = this.spectralView.getRegions().length === 0
    if (!box) {
      const count = this.spectralView.getRegions().length
      this.els.spectralSelection.textContent = count ? `${count} box${count === 1 ? '' : 'es'}. Click one to change it.` : 'No box selected'
      return
    }
    this.els.spectralSelection.textContent = `${box.startSec.toFixed(2)}–${box.endSec.toFixed(2)} s · ${formatHz(box.lowHz)}–${formatHz(box.highHz)}`
    this.els.spectralReduction.value = String(box.reductionDb)
    this.els.spectralReductionValue.textContent = `${box.reductionDb} dB`
  }

  syncSeamView() {
    if (!this.seamView || !this.loopEditorController) return
    const { loopStart, loopEnd } = this.loopEditorController.getLoopPoints()
    this.seamView.setLoop(loopStart, loopEnd)
    this.seamView.setCrossfade(this.currentCrossfadeMs() / 1000)
    this.seamView.setEnabled(!this.currentSpeedPitchDoppler())
    this.scheduleSeamPeaks()
  }

  // The strip needs peaks for just the trim. Base (whole-file) peaks show
  // immediately; a finer fetch for the trim replaces them once settled.
  scheduleSeamPeaks() {
    clearTimeout(this._seamPeaksTimer)
    const id = this.currentEntry?.id
    if (!id || !this.seamView) return
    const { loopStart, loopEnd } = this.loopEditorController.getLoopPoints()
    const base = this.waveformPeaksCache.get(id)
    const key = `${id}:${loopStart}:${loopEnd}:${Boolean(base)}`
    if (key === this._seamPeaksKey) return
    this._seamPeaksKey = key
    const duration = this.currentEntry?.durationSeconds
    if (base && duration) this.seamView.setPeaks(base, 0, duration)
    this._seamPeaksTimer = setTimeout(async () => {
      const width = Math.max(1, Math.round(this.els.seamCanvas.getBoundingClientRect().width))
      try {
        const peaks = await this.api.audio.getWaveformPeaks(id, width * 2, loopStart, loopEnd)
        const current = this.loopEditorController.getLoopPoints()
        if (!peaks || this.currentEntry?.id !== id || current.loopStart !== loopStart || current.loopEnd !== loopEnd) return
        this.seamView.setPeaks(peaks, loopStart, loopEnd)
      } catch (err) {
        console.error('Editor: seam strip peaks fetch failed', err)
      }
    }, 300)
  }

  // Finer peaks for exactly what the "Loop seam" strip's current zoom
  // shows (v0.1.231) - the same idea as maybeFetchDetailPeaks for the main
  // trim waveform, keyed off the source-time range SeamView's own
  // onViewportChange already resolved (it can be two disjoint stretches'
  // union collapsed into one span, when the view straddles the crossfade
  // blend - see that file's computeSourceRange).
  scheduleSeamDetailPeaks(sourceRange) {
    clearTimeout(this._seamDetailPeaksTimer)
    const id = this.currentEntry?.id
    if (!id || !this.seamView || !sourceRange) return
    const [start, end] = sourceRange
    if (!(end > start)) return
    this._seamDetailPeaksTimer = setTimeout(async () => {
      const width = Math.max(1, Math.round(this.els.seamCanvas.getBoundingClientRect().width))
      try {
        const peaks = await this.api.audio.getWaveformPeaks(id, width, start, end)
        if (!peaks || this.currentEntry?.id !== id) return
        this.seamView.setDetailPeaks(peaks, start, end)
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
    this.els.seamListen.textContent = 'Stop'
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
    this.els.seamListen.textContent = 'Listen to the seam'
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
    const f = {
      volume: normalizeFluctuationAxis(fluctuation?.volume, 1),
      pitch: normalizeFluctuationAxis(fluctuation?.pitch, 0),
      // A sound saved before pan drift existed gets the default spread on the
      // bar, not all three circles collapsed at center.
      pan: fluctuation?.pan ? normalizeFluctuationAxis(fluctuation.pan, 0) : { ...defaultFluctuation().pan }
    }
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
    const id = this.currentEntry?.id
    if (!id) return null
    const preset = this.presets?.find((p) => p.id === this.editingPresetId)
    const group = preset?.groups?.find((g) => g.soundIds?.includes(id))
    const f = group?.filters?.fluctuation
    if (!f) return null
    const perSound = ['volume', 'pitch', 'pan'].filter((a) => f[a]?.enabled && (f[a].perSound || a === 'pitch'))
    // Mirrors groupDrift.js's BUS_CAPABLE_AXES (can't import it - plugin
    // sandbox) - a shared (non-per-sound) volume or pan drift on the group's
    // bus switches off that same axis's own drift on the member, so they
    // move together instead of each also wandering on its own.
    const sharedAxes = ['volume', 'pan'].filter((a) => f[a]?.enabled && !f[a].perSound)
    return perSound.length || sharedAxes.length ? { group, perSound, sharedAxes } : null
  }

  updateGroupOverrideNotes() {
    const info = this.groupDriftForCurrentSound()
    const list = (axes) => axes.join(' and ')
    let fluc = ''
    let shot = ''
    if (info) {
      const name = `"${info.group.name}"`
      if (info.perSound.length) {
        fluc = `In the Mixer and exports, this sound's ${list(info.perSound)} drift comes from its group ${name} (each sound on its own), not from the bars below.`
        shot = `In the Mixer and exports, the ${list(info.perSound)} range comes from this sound's group ${name}'s drift settings, not from the bars below.`
      }
      const overridden = info.sharedAxes.filter((a) => !info.perSound.includes(a))
      if (overridden.length) {
        fluc = `${fluc ? `${fluc} ` : ''}Its group ${name} drifts ${list(overridden)} for the whole group, so this sound's own ${list(overridden)} drift is switched off there.`
      }
    }
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
          this.savedFluctuationSnapshot = JSON.stringify({
            volume: normalizeFluctuationAxis(fluctuation?.volume, 1),
            pitch: normalizeFluctuationAxis(fluctuation?.pitch, 0),
            pan: normalizeFluctuationAxis(fluctuation?.pan, 0)
          })
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
    this.els.fluctuationSection.classList.toggle('hidden', flucHidden)
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
    this.els.fluctuationSection.classList.toggle('hidden', flucHidden)
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
    this.els.pitchValue.textContent = pitchSemitones === 0 ? 'Off' : `${pitchSemitones > 0 ? '+' : ''}${pitchSemitones} st`
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
    return JSON.stringify({
      volume: normalizeFluctuationAxis(this.fluctuation?.volume, 1),
      pitch: normalizeFluctuationAxis(this.fluctuation?.pitch, 0),
      pan: normalizeFluctuationAxis(this.fluctuation?.pan, 0)
    })
  }

  fluctuationDirty() {
    return this.savedFluctuationSnapshot != null && this.fluctuationSnapshot() !== this.savedFluctuationSnapshot
  }

  updateSaveButtonState() {
    // While viewing the read-only B (last saved) reference, currentFilters()
    // reflects B's data rather than A's real live edits (A's own bands are
    // stashed in eqLiveBandsStash, not currently loaded into the graph) - the
    // normal dirty-check would misleadingly compare "B vs. what's actually
    // saved" (always equal) and hide genuinely pending changes in A. Force
    // Save disabled with an explicit label instead of trusting that check
    // while B is on screen.
    if (this.eqCompareViewing === 'B') {
      this.els.save.disabled = true
      this.els.saveLabel.textContent = 'Viewing saved mix'
      if (this.els.saveAsCopy) this.els.saveAsCopy.disabled = true
      this.updatePreviewModeToggle()
      return
    }
    // Fluctuation isn't part of hasUnsavedChanges() (it never re-bakes), but
    // a pending drift edit is still something the user expects Save to act on
    // - fold it in here only, so the button lights up and performSave() knows
    // to persist it, without fluctuation leaking into the stale-clip / undo
    // machinery hasUnsavedChanges() also feeds.
    const dirty = this.hasUnsavedChanges() || this.fluctuationDirty()
    this.els.save.disabled = !dirty
    this.els.saveLabel.textContent = dirty ? 'Save' : 'Nothing to save'
    // Unlike Save, always enabled while viewing A regardless of dirty state -
    // saving a copy of the *current* (even unchanged) trim under a new name
    // is still a meaningful action, not just a no-op.
    if (this.els.saveAsCopy) this.els.saveAsCopy.disabled = false
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
    if (this._restoringHistory || !this.currentEntry) return
    clearTimeout(this._autosaveTimer)
    this._autosaveTimer = setTimeout(() => this.runAutosave(), AUTOSAVE_IDLE_MS)
  }

  async runAutosave() {
    if (!this.currentEntry || this.eqCompareViewing === 'B' || !this.hasUnsavedChanges()) return
    if (this._saveInProgress) {
      // A manual Save (or a previous autosave) is still mid-render - try
      // again shortly rather than starting a second overlapping bake of the
      // same sound.
      this._autosaveTimer = setTimeout(() => this.runAutosave(), AUTOSAVE_IDLE_MS)
      return
    }
    try {
      await this.save({ trigger: 'auto' })
    } catch (err) {
      console.error('Editor: autosave failed', err)
    }
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
    if (this._restoringHistory || !this.currentEntry) return
    clearTimeout(this._historyCommitTimer)
    this._historyCommitTimer = setTimeout(() => this.commitHistoryPoint(), HISTORY_COMMIT_DEBOUNCE_MS)
  }

  commitHistoryPoint() {
    if (!this.currentEntry || !this.loopEditorController) return
    const state = this.captureEditorState()
    const serialized = JSON.stringify(state)
    // No-op if nothing actually changed since the last recorded point (e.g.
    // a field was focused/blurred with no real edit) - avoids padding the
    // stack with identical entries.
    if (this.historyIndex >= 0 && JSON.stringify(this.historyStack[this.historyIndex]) === serialized) return
    // A fresh edit after undoing discards whatever redo branch existed -
    // same convention every text editor's own undo stack uses.
    this.historyStack = this.historyStack.slice(0, this.historyIndex + 1)
    this.historyStack.push(state)
    if (this.historyStack.length > HISTORY_LIMIT) this.historyStack.shift()
    this.historyIndex = this.historyStack.length - 1
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

  undo() {
    // A pending debounced commit represents an edit that hasn't been
    // recorded yet - flush it first so Ctrl+Z's first press undoes the most
    // recent *real* change instead of silently discarding it unrecorded.
    clearTimeout(this._historyCommitTimer)
    this.commitHistoryPoint()
    if (this.historyIndex <= 0) return
    this.historyIndex -= 1
    this.applyEditorState(this.historyStack[this.historyIndex])
  }

  redo() {
    if (this.historyIndex >= this.historyStack.length - 1) return
    this.historyIndex += 1
    this.applyEditorState(this.historyStack[this.historyIndex])
  }

  updateUndoRedoButtonsUI() {
    if (this.els.undo) this.els.undo.disabled = this.historyIndex <= 0
    if (this.els.redo) this.els.redo.disabled = this.historyIndex >= this.historyStack.length - 1
  }

  // Reloading the current sound from its own saved library data already
  // resets every control back to last-saved (the same path used repeatedly
  // during this feature's own testing to discard edits) - Cancel just wires
  // that existing path to a button instead of requiring a re-pick.
  cancelEdits() {
    if (!this.currentEntry) return
    this.selectPickerSound(this.currentEntry.id)
  }

  // The leave-confirmation prompt (Yes/No/Don't ask again) - TabHost's
  // onBeforeHide hook awaits this before actually switching away from the
  // Remix tab, so returning false here keeps the user on Remix. Nothing to
  // confirm (no unsaved changes, or the user already opted out) resolves
  // true immediately with no dialog shown at all.
  confirmLeaveIfDirty() {
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
      this.updateSeamPlayhead(source)
      this.updateStickyProgress(active.currentTime)
    } else {
      const currentTime = active.currentTime
      this.loopEditorController.setPlayhead(currentTime)
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
    this.eqEditorController.tickSpectrum(active.analyserNode)
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
  }

  disposePreview() {
    this.stopSeamListen({ pause: false })
    this.stopPreviewTicking()
    clearTimeout(this._autosaveTimer)
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
    this.setPlayPauseIcon(false)
  }

  async getWaveformPeaks(id) {
    if (this.waveformPeaksCache.has(id)) return this.waveformPeaksCache.get(id)
    const peaks = await this.api.audio.getWaveformPeaks(id, this.els.canvas.width)
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
    this.els.soundName.textContent = entry.name
    this.els.soundName.title = entry.name
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
    const scatter = entry.scatter ?? {
      minGapSeconds: 5,
      maxGapSeconds: 35,
      gapFullyRandom: false,
      gapBiasEnabled: false,
      gapBiasSeconds: 20,
      minPitchSemitones: 0,
      maxPitchSemitones: 0,
      pitchFullyRandom: false,
      pitchBiasEnabled: false,
      pitchBiasSemitones: 0,
      minVolume: 1,
      maxVolume: 1,
      minSpeed: 1,
      maxSpeed: 1,
      fadeInMs: 0,
      fadeOutMs: 0,
      syncGroup: ''
    }
    const schedule = entry.schedule ?? {
      type: 'times',
      times: [],
      intervalMinutes: 60,
      minPitchSemitones: 0,
      maxPitchSemitones: 0,
      pitchFullyRandom: false,
      pitchBiasEnabled: false,
      pitchBiasSemitones: 0,
      minVolume: 1,
      maxVolume: 1,
      minSpeed: 1,
      maxSpeed: 1,
      fadeInMs: 0,
      fadeOutMs: 0
    }
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
      fluctuation
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
    this.previewSource.audioEl.currentTime = loopStart
    this.loopEditorController.load(duration, loopStart, loopEnd)
    // load() resets its own volume-envelope state to neutral, same reason
    // it resets Doppler (a fresh sound shouldn't inherit the previous one's
    // drawn points) - re-applied here after load(), same ordering fix
    // Doppler already needed (see the comment on its own re-apply just
    // below).
    this.loopEditorController.setEnvelope(filters.volumeEnvelope?.enabled ?? false, filters.volumeEnvelope?.points)
    this.spectralView.setRegions(filters.spectralRepairs ?? [])
    this.updateSpectralControls()
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
    this.historyStack = [JSON.parse(this.savedSnapshot)]
    this.historyIndex = 0
    this.updateUndoRedoButtonsUI()
    this.updateSaveButtonState()

    this.els.waveformStatus.textContent = this.waveformPeaksCache.has(id) ? '' : 'Loading waveform…'
    const peaks = await this.getWaveformPeaks(id)
    if (this.currentEntry?.id !== id) return
    this.loopEditorController.setPeaks(peaks)
    this.syncSeamView()
    this.els.waveformStatus.textContent = peaks ? '' : 'Waveform preview unavailable for this file.'
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
    if (!this.currentEntry || !this.loopEditorController || this.eqCompareViewing === 'B') return
    if (this._saveInProgress) return
    this._saveInProgress = true
    try {
      await this.performSave(trigger, forceBake)
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
    if (presetSoundItem) {
      const updated = await this.api.presets.updateSoundOverride(savingEditingPresetId, id, overridePatch)
      const updatedItem = updated?.sounds.find((s) => s.soundId === id)
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
            detail: { presetId: savingEditingPresetId, soundId: id, overrides: presetSoundItem.overrides, loopClip }
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
      this.els.saveLabel.textContent = trigger === 'auto' ? 'Auto-saving…' : 'Saving…'
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
    this.els.mixPresetEqType.addEventListener('change', () => this.applyPresetEqFieldsToSelectedBand())
    this.els.mixPresetEqSlope.addEventListener('change', () => this.applyPresetEqFieldsToSelectedBand())
    this.els.mixPresetEqFreq.addEventListener('input', () => this.applyPresetEqFieldsToSelectedBand())
    this.els.mixPresetEqGain.addEventListener('input', () => this.applyPresetEqFieldsToSelectedBand())
    this.els.mixPresetEqQ.addEventListener('input', () => this.applyPresetEqFieldsToSelectedBand())
    this.els.mixPresetEqReset.addEventListener('click', () => {
      this.presetEq.load(defaultEqBands())
      this.updatePresetEqFieldsFromSelection()
      this.applyPresetEqControls()
    })
    this.els.mixPresetEqAddBand.addEventListener('click', () => {
      this.presetEq.addBand()
      this.updatePresetEqFieldsFromSelection()
      this.applyPresetEqControls()
    })
    this.els.mixPresetEqRemoveBand.addEventListener('click', () => {
      this.presetEq.removeSelectedBand()
      this.updatePresetEqFieldsFromSelection()
      this.applyPresetEqControls()
    })
    this.els.mixPresetEqZoomIn.addEventListener('click', () => this.presetEq.zoomIn())
    this.els.mixPresetEqZoomOut.addEventListener('click', () => this.presetEq.zoomOut())
    this.els.mixPresetEqInvert.addEventListener('click', () => {
      this.presetEq.invertBands()
      this.updatePresetEqFieldsFromSelection()
      this.applyPresetEqControls()
    })
    this.els.mixPresetEqCompareA.addEventListener('click', () => this.switchPresetEqCompareView('A'))
    this.els.mixPresetEqCompareB.addEventListener('click', () => this.switchPresetEqCompareView('B'))
    this.els.mixPresetEqRevertBanner.addEventListener('click', () => this.revertPresetEqToSaved())
    this.els.mixPresetEqMute.addEventListener('click', () => {
      const idx = this.presetEq.getSelectedIndex()
      const band = this.presetEq.getBands()[idx]
      if (!band) return
      this.presetEq.setSelectedBand({ muted: !band.muted })
      this.applyPresetEqControls()
    })
    this.els.mixPresetEqSolo.addEventListener('click', () => {
      const idx = this.presetEq.getSelectedIndex()
      if (idx === -1) return
      const current = this.presetEq.getSoloIndex()
      this.presetEq.setSoloIndex(current === idx ? -1 : idx)
      this.applyPresetEqControls()
    })
    this.els.mixPresetResetFilters.addEventListener('click', () => {
      this.writePresetMixControls(NEUTRAL_WHOLE_MIX)
      this.presetEq.load(defaultEqBands())
      this.updatePresetEqFieldsFromSelection()
      this.readPresetMixControlsAndPreview()
      this.applyPresetEqControls()
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
    for (const el of [this.els.mixGroupHighpass, this.els.mixGroupLowpass, this.els.mixGroupGain, this.els.mixGroupEchoDelay, this.els.mixGroupEchoDecay, this.els.mixGroupReverbSize, this.els.mixGroupReverbMix, this.els.mixGroupOcclusion]) {
      el.addEventListener('input', () => this.readGroupControlsAndPreview())
    }
    for (const el of [this.els.mixGroupFlucEnabled, this.els.mixGroupFlucFullRandom, this.els.mixGroupFlucChangeMin, this.els.mixGroupFlucChangeMax, this.els.mixGroupFlucTransition, this.els.mixGroupFlucPanEnabled, this.els.mixGroupFlucPanFullRandom, this.els.mixGroupFlucPanChangeMin, this.els.mixGroupFlucPanChangeMax, this.els.mixGroupFlucPanTransition, this.els.mixGroupFlucBias, this.els.mixGroupFlucPerSound, this.els.mixGroupFlucPanBias, this.els.mixGroupFlucPanPerSound, this.els.mixGroupFlucPitchEnabled, this.els.mixGroupFlucPitchFullRandom, this.els.mixGroupFlucPitchChangeMin, this.els.mixGroupFlucPitchChangeMax, this.els.mixGroupFlucPitchTransition, this.els.mixGroupFlucPitchBias]) {
      el.addEventListener(el.type === 'checkbox' ? 'change' : 'input', () => this.readGroupControlsAndPreview())
    }
    this.els.mixGroupEqType.addEventListener('change', () => this.applyGroupEqFieldsToSelectedBand())
    this.els.mixGroupEqSlope.addEventListener('change', () => this.applyGroupEqFieldsToSelectedBand())
    this.els.mixGroupEqFreq.addEventListener('input', () => this.applyGroupEqFieldsToSelectedBand())
    this.els.mixGroupEqGain.addEventListener('input', () => this.applyGroupEqFieldsToSelectedBand())
    this.els.mixGroupEqQ.addEventListener('input', () => this.applyGroupEqFieldsToSelectedBand())
    this.els.mixGroupEqReset.addEventListener('click', () => {
      this.groupEq.load(defaultEqBands())
      this.updateGroupEqFieldsFromSelection()
      this.applyGroupEqControls()
    })
    this.els.mixGroupEqAddBand.addEventListener('click', () => {
      this.groupEq.addBand()
      this.updateGroupEqFieldsFromSelection()
      this.applyGroupEqControls()
    })
    this.els.mixGroupEqRemoveBand.addEventListener('click', () => {
      this.groupEq.removeSelectedBand()
      this.updateGroupEqFieldsFromSelection()
      this.applyGroupEqControls()
    })
    this.els.mixGroupEqZoomIn.addEventListener('click', () => this.groupEq.zoomIn())
    this.els.mixGroupEqZoomOut.addEventListener('click', () => this.groupEq.zoomOut())
    this.els.mixGroupEqInvert.addEventListener('click', () => {
      this.groupEq.invertBands()
      this.updateGroupEqFieldsFromSelection()
      this.applyGroupEqControls()
    })
    this.els.mixGroupEqCompareA.addEventListener('click', () => this.switchGroupEqCompareView('A'))
    this.els.mixGroupEqCompareB.addEventListener('click', () => this.switchGroupEqCompareView('B'))
    this.els.mixGroupEqRevertBanner.addEventListener('click', () => this.revertGroupEqToSaved())
    this.els.mixGroupEqMute.addEventListener('click', () => {
      const idx = this.groupEq.getSelectedIndex()
      const band = this.groupEq.getBands()[idx]
      if (!band) return
      this.groupEq.setSelectedBand({ muted: !band.muted })
      this.applyGroupEqControls()
    })
    this.els.mixGroupEqSolo.addEventListener('click', () => {
      const idx = this.groupEq.getSelectedIndex()
      if (idx === -1) return
      const current = this.groupEq.getSoloIndex()
      this.groupEq.setSoloIndex(current === idx ? -1 : idx)
      this.applyGroupEqControls()
    })
    this.els.mixGroupResetFilters.addEventListener('click', () => {
      this.writeGroupControls(NEUTRAL_GROUP_FILTERS)
      this.groupEq.load(defaultEqBands())
      this.updateGroupEqFieldsFromSelection()
      this.readGroupControlsAndPreview()
      this.applyGroupEqControls()
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
    this.els.stickyMixControls.classList.toggle('hidden', mode === 'sound')
    this.els.mixDeleteGroup.classList.toggle('hidden', mode !== 'group' || !this.selectedGroupId)
    this.els.mixCopyGroupTo.classList.toggle('hidden', mode !== 'group' || !this.selectedGroupId)
    if (mode === 'preset') {
      this.els.mixSave.disabled = !this.selectedPresetId || wholeMixEqual(this.wholeMixCurrent, this.wholeMixSaved)
      this.els.mixStatus.textContent = this.selectedPresetId ? '' : 'Pick a preset above.'
    } else if (mode === 'group') {
      const dirty = this.selectedGroupId && (this.els.mixGroupName.value.trim() !== this.groups.find((g) => g.id === this.selectedGroupId)?.name || !groupFiltersEqual(this.groupCurrent, this.groupSaved))
      this.els.mixSave.disabled = !this.selectedGroupId || !dirty
      this.els.mixStatus.textContent = this.selectedGroupId ? '' : 'Pick or create a group above.'
    }
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
    const playing = isActivePreset && status.isPlaying
    const soloed = this.mode === 'group' && isActivePreset && status.soloedGroupId === this.selectedGroupId
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

    if (this.mode === 'group') {
      this.els.mixSoloGroup.classList.remove('hidden')
      this.els.mixSoloGroup.disabled = !this.selectedGroupId
      this.els.mixSoloGroup.classList.toggle('editor-sticky-solo-active', soloed)
      this.els.mixSoloGroup.textContent = soloed ? 'Unsolo group' : 'Solo group'
    } else {
      this.els.mixSoloGroup.classList.add('hidden')
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
    if (status.activePresetId !== this.selectedPresetId) {
      window.dispatchEvent(new CustomEvent('noctivago:remix-load-preset', { detail: { presetId: this.selectedPresetId } }))
    } else {
      window.dispatchEvent(new CustomEvent('noctivago:remix-toggle-playback', {}))
    }
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
    this.els.mixPresetSelect.innerHTML = this.presets.length
      ? this.presets.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join('')
      : '<option value="">No presets saved yet</option>'

    const stillThere = this.presets.some((p) => p.id === previous)
    const target = stillThere ? previous : (this.presets[0]?.id ?? null)
    this.els.mixPresetSelect.value = target ?? ''
    this.selectMixPreset(target, { silent: true })
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
    this.resetPresetEqCompare()
    this.updatePresetEqFieldsFromSelection()
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

  // Fires on every EQ graph change (drag, wheel Q, add/remove) and every
  // precision-field edit - same shape as Sound mode's own applyEqControls,
  // now that Preset mode shares the exact same EqEditor.js controller
  // (2026-09-06 direction) instead of the old scoped-down WholeMixEqEditor.
  applyPresetEqControls() {
    this.updatePresetEqFieldsFromSelection()
    this.wholeMixCurrent = { ...this.wholeMixCurrent, eq: this.presetEq.getBands() }
    this.updateModeUI()
    if (this.mode === 'preset') this.dispatchWholeMixPreview(this.wholeMixCurrent)
    this.updatePresetEqRevertBannerVisibility()
  }

  // Mirrors Sound mode's updateEqFieldsFromSelection exactly, just against
  // this.presetEq/mixPreset* instead of the Sound-mode controller/els.
  updatePresetEqFieldsFromSelection() {
    const bands = this.presetEq.getBands()
    const index = this.presetEq.getSelectedIndex()
    const band = bands[index]
    const readOnly = this.presetEq.isReadOnly()
    const hasSelection = Boolean(band)
    const disabled = readOnly || !hasSelection
    this.els.mixPresetEqType.disabled = disabled
    this.els.mixPresetEqFreq.disabled = disabled
    this.els.mixPresetEqGain.disabled = disabled
    this.els.mixPresetEqQ.disabled = disabled
    this.els.mixPresetEqMute.disabled = disabled
    this.els.mixPresetEqSolo.disabled = disabled
    this.els.mixPresetEqRemoveBand.disabled = disabled
    this.els.mixPresetEqAddBand.disabled = readOnly
    if (!hasSelection) {
      this.els.mixPresetEqType.value = 'peaking'
      this.els.mixPresetEqFreq.value = ''
      this.els.mixPresetEqGain.value = ''
      this.els.mixPresetEqQ.value = ''
      this.els.mixPresetEqSlope.value = 'gentle'
      this.els.mixPresetEqSlope.disabled = true
      this.els.mixPresetEqSlopeLabel.classList.add('hidden')
      this.els.mixPresetEqMute.classList.remove('editor-eq-mute-active')
      this.els.mixPresetEqSolo.classList.remove('editor-eq-solo-active')
      return
    }
    this.els.mixPresetEqType.value = band.type ?? 'peaking'
    this.els.mixPresetEqFreq.value = String(Math.round(band.freqHz))
    this.els.mixPresetEqGain.value = String(band.gainDb)
    this.els.mixPresetEqQ.value = String(band.q)
    const slopeCapable = SLOPE_CAPABLE_EQ_TYPES.includes(band.type)
    this.els.mixPresetEqSlope.value = band.slope ?? 'gentle'
    this.els.mixPresetEqSlope.disabled = disabled || !slopeCapable
    this.els.mixPresetEqSlopeLabel.classList.toggle('hidden', !slopeCapable)
    this.els.mixPresetEqMute.classList.toggle('editor-eq-mute-active', Boolean(band.muted))
    this.els.mixPresetEqSolo.classList.toggle('editor-eq-solo-active', this.presetEq.getSoloIndex() === index)
  }

  applyPresetEqFieldsToSelectedBand() {
    const type = this.els.mixPresetEqType.value
    const slope = this.els.mixPresetEqSlope.value
    const freqHz = Math.min(20000, Math.max(20, Number(this.els.mixPresetEqFreq.value)))
    const gainDb = Math.min(24, Math.max(-24, Number(this.els.mixPresetEqGain.value)))
    const q = Math.min(Q_MAX, Math.max(Q_MIN, Number(this.els.mixPresetEqQ.value)))
    this.presetEq.setSelectedBand({ type, slope, freqHz, gainDb, q })
    this.applyPresetEqControls()
  }

  // True whenever the live EQ bands (A) differ from the saved preset's own
  // EQ (B) - same technique as Sound mode's eqDiffersFromSaved, just against
  // wholeMixSaved.eq (which - unlike Sound mode's savedEqSnapshot - *does*
  // update after every real Save here, matching this mode's own pre-
  // existing dirty-check semantics for HP/LP/Gain/Echo/Reverb).
  presetEqDiffersFromSaved() {
    if (!this.presetEq) return false
    return JSON.stringify(this.presetEq.getBands()) !== JSON.stringify(this.wholeMixSaved.eq ?? [])
  }

  updatePresetEqRevertBannerVisibility() {
    const show = this.presetEqCompareViewing === 'A' && this.presetEqDiffersFromSaved()
    this.els.mixPresetEqRevertBanner.classList.toggle('hidden', !show)
  }

  switchPresetEqCompareView(target) {
    if (target === this.presetEqCompareViewing || !this.presetEq) return
    if (target === 'B') {
      this.presetEqLiveBandsStash = this.presetEq.getBands()
      this.presetEq.load((this.wholeMixSaved.eq ?? []).map((b) => ({ ...b })))
    } else {
      this.presetEq.load((this.presetEqLiveBandsStash ?? this.presetEq.getBands()).map((b) => ({ ...b })))
      this.presetEqLiveBandsStash = null
    }
    this.presetEqCompareViewing = target
    this.presetEq.setReadOnly(target === 'B')
    this.updatePresetEqFieldsFromSelection()
    this.applyPresetEqControls()
    this.updatePresetEqCompareButtonsUI()
  }

  updatePresetEqCompareButtonsUI() {
    this.els.mixPresetEqCompareA.classList.toggle('editor-eq-compare-btn-active', this.presetEqCompareViewing === 'A')
    this.els.mixPresetEqCompareB.classList.toggle('editor-eq-compare-btn-active', this.presetEqCompareViewing === 'B')
  }

  revertPresetEqToSaved() {
    if (!this.presetEq) return
    this.presetEqLiveBandsStash = null
    this.presetEqCompareViewing = 'A'
    this.presetEq.setReadOnly(false)
    this.presetEq.load((this.wholeMixSaved.eq ?? []).map((b) => ({ ...b })))
    this.updatePresetEqFieldsFromSelection()
    this.applyPresetEqControls()
    this.updatePresetEqCompareButtonsUI()
  }

  resetPresetEqCompare() {
    this.presetEqCompareViewing = 'A'
    this.presetEqLiveBandsStash = null
    this.presetEq?.setReadOnly(false)
    this.updatePresetEqCompareButtonsUI()
    this.updatePresetEqRevertBannerVisibility()
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
      this.updatePresetEqFieldsFromSelection()
      this.updatePresetEqRevertBannerVisibility()
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
    this.resetGroupEqCompare()
    this.updateGroupEqFieldsFromSelection()
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
    this.els.mixGroupEchoDelay.value = String(filters.echoDelayMs)
    this.els.mixGroupEchoDecay.value = String(filters.echoDecay)
    this.els.mixGroupReverbSize.value = String(filters.reverbSizeMs ?? 0)
    this.els.mixGroupReverbMix.value = String(filters.reverbMix ?? 0)
    this.els.mixGroupOcclusion.value = String(filters.occlusion ?? 0)
    this.writeMixFluctuation(filters.fluctuation, this.groupFlucEls)
  }

  // Mirrors applyPresetEqControls exactly - see its own comment.
  applyGroupEqControls() {
    this.updateGroupEqFieldsFromSelection()
    this.groupCurrent = { ...this.groupCurrent, eq: this.groupEq.getBands() }
    this.updateModeUI()
    if (this.mode === 'group') this.dispatchGroupPreview(this.groupCurrent)
    this.updateGroupEqRevertBannerVisibility()
  }

  updateGroupEqFieldsFromSelection() {
    const bands = this.groupEq.getBands()
    const index = this.groupEq.getSelectedIndex()
    const band = bands[index]
    const readOnly = this.groupEq.isReadOnly()
    const hasSelection = Boolean(band)
    const disabled = readOnly || !hasSelection
    this.els.mixGroupEqType.disabled = disabled
    this.els.mixGroupEqFreq.disabled = disabled
    this.els.mixGroupEqGain.disabled = disabled
    this.els.mixGroupEqQ.disabled = disabled
    this.els.mixGroupEqMute.disabled = disabled
    this.els.mixGroupEqSolo.disabled = disabled
    this.els.mixGroupEqRemoveBand.disabled = disabled
    this.els.mixGroupEqAddBand.disabled = readOnly
    if (!hasSelection) {
      this.els.mixGroupEqType.value = 'peaking'
      this.els.mixGroupEqFreq.value = ''
      this.els.mixGroupEqGain.value = ''
      this.els.mixGroupEqQ.value = ''
      this.els.mixGroupEqSlope.value = 'gentle'
      this.els.mixGroupEqSlope.disabled = true
      this.els.mixGroupEqSlopeLabel.classList.add('hidden')
      this.els.mixGroupEqMute.classList.remove('editor-eq-mute-active')
      this.els.mixGroupEqSolo.classList.remove('editor-eq-solo-active')
      return
    }
    this.els.mixGroupEqType.value = band.type ?? 'peaking'
    this.els.mixGroupEqFreq.value = String(Math.round(band.freqHz))
    this.els.mixGroupEqGain.value = String(band.gainDb)
    this.els.mixGroupEqQ.value = String(band.q)
    const slopeCapable = SLOPE_CAPABLE_EQ_TYPES.includes(band.type)
    this.els.mixGroupEqSlope.value = band.slope ?? 'gentle'
    this.els.mixGroupEqSlope.disabled = disabled || !slopeCapable
    this.els.mixGroupEqSlopeLabel.classList.toggle('hidden', !slopeCapable)
    this.els.mixGroupEqMute.classList.toggle('editor-eq-mute-active', Boolean(band.muted))
    this.els.mixGroupEqSolo.classList.toggle('editor-eq-solo-active', this.groupEq.getSoloIndex() === index)
  }

  applyGroupEqFieldsToSelectedBand() {
    const type = this.els.mixGroupEqType.value
    const slope = this.els.mixGroupEqSlope.value
    const freqHz = Math.min(20000, Math.max(20, Number(this.els.mixGroupEqFreq.value)))
    const gainDb = Math.min(24, Math.max(-24, Number(this.els.mixGroupEqGain.value)))
    const q = Math.min(Q_MAX, Math.max(Q_MIN, Number(this.els.mixGroupEqQ.value)))
    this.groupEq.setSelectedBand({ type, slope, freqHz, gainDb, q })
    this.applyGroupEqControls()
  }

  groupEqDiffersFromSaved() {
    if (!this.groupEq) return false
    return JSON.stringify(this.groupEq.getBands()) !== JSON.stringify(this.groupSaved.eq ?? [])
  }

  updateGroupEqRevertBannerVisibility() {
    const show = this.groupEqCompareViewing === 'A' && this.groupEqDiffersFromSaved()
    this.els.mixGroupEqRevertBanner.classList.toggle('hidden', !show)
  }

  switchGroupEqCompareView(target) {
    if (target === this.groupEqCompareViewing || !this.groupEq) return
    if (target === 'B') {
      this.groupEqLiveBandsStash = this.groupEq.getBands()
      this.groupEq.load((this.groupSaved.eq ?? []).map((b) => ({ ...b })))
    } else {
      this.groupEq.load((this.groupEqLiveBandsStash ?? this.groupEq.getBands()).map((b) => ({ ...b })))
      this.groupEqLiveBandsStash = null
    }
    this.groupEqCompareViewing = target
    this.groupEq.setReadOnly(target === 'B')
    this.updateGroupEqFieldsFromSelection()
    this.applyGroupEqControls()
    this.updateGroupEqCompareButtonsUI()
  }

  updateGroupEqCompareButtonsUI() {
    this.els.mixGroupEqCompareA.classList.toggle('editor-eq-compare-btn-active', this.groupEqCompareViewing === 'A')
    this.els.mixGroupEqCompareB.classList.toggle('editor-eq-compare-btn-active', this.groupEqCompareViewing === 'B')
  }

  revertGroupEqToSaved() {
    if (!this.groupEq) return
    this.groupEqLiveBandsStash = null
    this.groupEqCompareViewing = 'A'
    this.groupEq.setReadOnly(false)
    this.groupEq.load((this.groupSaved.eq ?? []).map((b) => ({ ...b })))
    this.updateGroupEqFieldsFromSelection()
    this.applyGroupEqControls()
    this.updateGroupEqCompareButtonsUI()
  }

  resetGroupEqCompare() {
    this.groupEqCompareViewing = 'A'
    this.groupEqLiveBandsStash = null
    this.groupEq?.setReadOnly(false)
    this.updateGroupEqCompareButtonsUI()
    this.updateGroupEqRevertBannerVisibility()
  }

  readGroupControlsAndPreview() {
    this.groupCurrent = {
      ...this.groupCurrent,
      highpassHz: Number(this.els.mixGroupHighpass.value),
      lowpassHz: Number(this.els.mixGroupLowpass.value),
      gainDb: Number(this.els.mixGroupGain.value),
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
      this.updateGroupEqFieldsFromSelection()
      this.updateGroupEqRevertBannerVisibility()
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
