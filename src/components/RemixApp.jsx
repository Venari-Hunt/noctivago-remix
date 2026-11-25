import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { icon, PLAY_ICON_SVG, VOLUME_ICON_SVG } from './icons.js'
import { SettingsSide } from './SettingsSide.jsx'

const MODE_HINT = 'Trim, filters, EQ and live preview for one sound at a time.'

const PRESETS = [
  ['muffled', 'Muffled'],
  ['phone', 'Over the Phone'],
  ['radio', 'On the Radio'],
  ['distant', 'Distant'],
  ['echo', 'Echo'],
  ['reverb', 'Reverb'],
  ['underwater', 'Underwater']
]

// The canvas views of the Sound editor. Each host is the view element itself:
// the tab's markup (TrimView, SeamView, EqView, SpectrumView) renders into it
// and layout.js only moves out what belongs to the settings column.
const VIEWS = [
  ['trim', 'Trim'],
  ['seam', 'Loop seam'],
  ['eq', 'EQ'],
  // Was "Spectrum", then "Repair"; Noise reduction and shape repair live here (owner, 2026-11-21).
  ['spec', 'Spectral repair']
]
const VIEW_HOST = { trim: 'rx-trim-host', seam: 'rx-seam-host', eq: 'rx-eq-host-sound', spec: 'rx-spectrum-host' }

const html = (__html) => ({ __html })

const COMPARE_TITLE = 'Last saved shows and plays the settings as they were last saved. Read-only: switch back to Now to keep editing.'

// The Sound canvas column: view tabs, Now / Last saved, the four views, save status.
function SoundCanvas() {
  return (
    <div className="rx-canvas">
      <div className="rx-tabs">
        <div className="rx-vtabs" role="group" aria-label="View">
          {VIEWS.map(([k, t]) => (
            <button key={k} type="button" data-rx-view={k} aria-pressed={k === 'trim'}>{t}</button>
          ))}
        </div>
        <div className="rx-seg rx-compare" role="group" aria-label="Compare with last saved" title={COMPARE_TITLE}>
          <button type="button" data-rx-compare="now" aria-pressed="true">Now</button>
          <button type="button" data-rx-compare="saved" aria-pressed="false">Last saved</button>
        </div>
      </div>
      {VIEWS.map(([k]) => (
        <div key={k} id={VIEW_HOST[k]} className={`rx-view rx-view-${k}`} />
      ))}
      <p id="editor-save-status" className="editor-save-status"></p>
    </div>
  )
}

const host = (id) => <div id={id} style={{ display: 'contents' }} />

// Studio panes (mock-noctivago-remix-studio v2), left to right: the library over
// the preview module, then the head. layout.js wires them (buildStudio) and
// the sticky controls (Play, volumes, Undo, Save, ...) are rendered in place. The tab element is their grid.
function StudioLeft({ previewVolume }) {
  return (
    <div className="rx-lcol">
      <aside className="rx-pane rx-lib" aria-label="Library">
        <div
          className="rx-lib-h"
          dangerouslySetInnerHTML={html(
            `<h3>Remix</h3><button id="rx-new-group" class="rx-i rx-ib" type="button" title="New group" aria-label="New group">${icon('plus')}</button><button id="rx-lib-hide" class="rx-i rx-ib rx-narrow-only" type="button" title="Hide the library" aria-label="Hide the library">${icon('chevron-left')}</button>`
          )}
        />
        <div id="rx-chips" className="rx-chips" role="group" aria-label="What you remix" title={MODE_HINT}>
          {/* Sound, Group, Preset (the mock's order). The tab toggles editor-mode-pill-active on them; CSS reads that. */}
          <button id="editor-mode-sound" className="rx-mchip editor-mode-pill-active" type="button" dangerouslySetInnerHTML={html(`${icon('audio-waveform', 14)}Sound`)} />
          <button id="editor-mode-group" className="rx-mchip" type="button" dangerouslySetInnerHTML={html(`${icon('layers', 14)}Group`)} />
          <button id="editor-mode-preset" className="rx-mchip" type="button" dangerouslySetInnerHTML={html(`${icon('bookmark', 14)}Preset`)} />
        </div>
        <label id="rx-in-preset" className="rx-in-preset">
          <span>In preset</span>
          <select id="editor-mix-preset-select" className="rx-field" aria-label="Preset"></select>
        </label>
        <label
          className="rx-search"
          dangerouslySetInnerHTML={html(`${icon('search')}<input id="rx-lib-search" type="text" placeholder="Search sounds" aria-label="Search" autocomplete="off" />`)}
        />
        <div id="rx-lib-list" className="rx-list"></div>
      </aside>
      <section className="rx-pane rx-prev" aria-label="Preview">
        <div className="rx-prow">
          <span id="rx-pplay-slot" className="rx-slot">
            <button id="editor-play-pause" className="rx-pplay rx-only-sound" type="button" title="Play" aria-label="Preview" dangerouslySetInnerHTML={html(PLAY_ICON_SVG)} />
            <button id="editor-mix-play-pause" className="rx-pplay rx-only-mix" type="button" title="Play" aria-label="Play" dangerouslySetInnerHTML={html(PLAY_ICON_SVG)} />
          </span>
          <b id="rx-now-name" className="rx-now"></b>
          <span id="rx-prow-end" className="rx-slot">
            <button id="editor-sticky-solo" className="rx-i editor-sticky-solo rx-only-sound" type="button" aria-label="Solo" title="Solo: mute every other sound already playing in the Mixer while you audition this one">S</button>
            <button
              id="editor-loop-toggle"
              className="rx-i editor-loop-icon-btn editor-loop-icon-btn-active rx-only-sound"
              type="button"
              title="Loop preview"
              aria-label="Loop preview"
              aria-pressed="true"
              dangerouslySetInnerHTML={html(icon('repeat'))}
            />
            <button id="editor-mix-solo-group" className="rx-i editor-sticky-solo hidden rx-only-mix" type="button" title="Solo group" aria-label="Solo group">S</button>
          </span>
        </div>
        <div id="rx-pnote" className="rx-pnote" hidden>Playing this group only</div>
        <div className="rx-pseek"><span id="rx-cur">0:00</span><div id="rx-seek-slot" className="rx-seek-slot">
          <div id="editor-sticky-progress" className="editor-sticky-progress" title="Drag to seek">
            <div className="editor-sticky-progress-track"><div id="editor-sticky-progress-fill" className="editor-sticky-progress-fill" /></div>
            <div id="editor-sticky-progress-thumb" className="editor-sticky-progress-thumb" />
          </div>
        </div><span id="rx-total">0:00</span></div>
        <div id="rx-pvol" className="rx-pvol">
          <button id="editor-sticky-mute" className="rx-i rx-only-sound" type="button" title="Mute" dangerouslySetInnerHTML={html(VOLUME_ICON_SVG)} />
          <div className="rx-volume rx-only-sound">
            <input id="editor-sticky-volume" type="range" min="0" max="100" defaultValue={Math.round(previewVolume * 100)} className="editor-sticky-volume rx-fader" title="Preview volume" aria-label="Preview volume" />
          </div>
          {/* Group and Preset play through the Mixer: their volume row is the app's master volume. */}
          <button id="editor-mix-mute" className="rx-i rx-only-mix" type="button" title="Mute" aria-label="Mute" dangerouslySetInnerHTML={html(VOLUME_ICON_SVG)} />
          <div className="rx-volume rx-only-mix">
            <input id="editor-mix-volume" type="range" min="0" max="1000" defaultValue="500" className="editor-sticky-volume rx-fader" title="Volume (the app's master volume)" aria-label="Volume" />
          </div>
          <button id="editor-preview-mode-toggle" className="editor-preview-mode-toggle rx-live rx-only-sound" type="button" disabled>Live edit</button>
        </div>
      </section>
    </div>
  )
}

function StudioHead() {
  return (
    <div className="rx-pane rx-head">
      <button id="rx-lib-show" className="rx-i rx-ib rx-narrow-only" type="button" title="Show the library" aria-label="Show the library" dangerouslySetInnerHTML={html(icon('chevron-right'))} />
      <div className="rx-ht">
        <div id="rx-kind" className="rx-kind">Sound</div>
        <h2 id="rx-title" className="rx-title"></h2>
        <div id="rx-meta" className="rx-meta"></div>
      </div>
      {/* Undo, Redo, Cancel, Save as copy, Save (Sound) or the status and Save (Group, Preset), then Copy to preset and Delete group. */}
      <div id="rx-acts" className="rx-acts">
        <div id="editor-sticky-sound-controls" className="editor-sticky-mode-group">
          <button id="editor-undo" className="rx-i" type="button" title="Undo (Ctrl+Z)" aria-label="Undo" disabled dangerouslySetInnerHTML={html(icon('undo-2'))} />
          <button id="editor-redo" className="rx-i" type="button" title="Redo (Ctrl+Shift+Z)" aria-label="Redo" disabled dangerouslySetInnerHTML={html(icon('redo-2'))} />
          <button id="editor-cancel" className="rx-b rx-ghost" type="button" title="Discard every change made since this sound was opened in Remix">
            Cancel
          </button>
          <button
            id="editor-save-as-copy"
            className="rx-b"
            type="button"
            title="Save a new sound with this one's trim and every setting, without touching this one"
            dangerouslySetInnerHTML={html(`${icon('copy')}<span>Save as copy</span>`)}
          />
          <button id="editor-save" className="rx-b rx-pri editor-sticky-save" type="button" dangerouslySetInnerHTML={html(`${icon('save')}<span id="editor-save-label">Save</span>`)} />
        </div>
        <div id="editor-sticky-mix-controls" className="editor-sticky-mode-group hidden">
          <span id="editor-mix-status" className="editor-sticky-time rx-num" />
          <button id="editor-mix-save" className="rx-b rx-pri editor-sticky-save" type="button" dangerouslySetInnerHTML={html(`${icon('save')}<span>Save</span>`)} />
        </div>
        <div id="rx-group-actions" className="rx-group-actions">
          <span
            className="rx-i rx-copy-wrap"
            title="Copy this group to another preset"
            dangerouslySetInnerHTML={html(
              `${icon('copy')}<select id="editor-mix-copy-group-to" class="hidden" aria-label="Copy this group to another preset" title="Copy this group's name, filters/EQ and members into another preset - it's governed entirely by whichever preset it ends up in from then on"><option value="" selected disabled>Copy to preset…</option></select>`
            )}
          />
          <button id="editor-mix-delete-group" className="rx-i hidden" type="button" title="Delete group" aria-label="Delete group" dangerouslySetInnerHTML={html(icon('trash-2'))} />
        </div>
      </div>
      <button id="rx-side-show" className="rx-b rx-ghost rx-xs-only" type="button" aria-expanded="false" dangerouslySetInnerHTML={html(`${icon('sliders-horizontal')}Settings`)} />
    </div>
  )
}

/**
 * The Remix tab shell: mode switch, picker row, the three mode panels, the
 * leave-confirm modal. Rendered once and never re-rendered: the tab and
 * layout.js own the DOM from here on (same ids and classes as the old markup).
 */
export function RemixApp({ previewVolume }) {
  return (
    <>
      <div className="editor-tab rx">
        <StudioLeft previewVolume={previewVolume} />
        <StudioHead />
        <div id="editor-mode-panel-preset" className="editor-mode-panel hidden"></div>

        <div id="editor-mode-panel-group" className="editor-mode-panel hidden"></div>

        <div id="editor-mode-panel-sound">
          {host('rx-picker-host')}
          <div id="editor-panel" className="editor-panel rx-grid hidden" data-view="trim">
            <SoundCanvas />
            <SettingsSide />
            {host('rx-looprow-host')}
            {host('rx-playback-host')}
            {host('rx-speed-host')}
            <div id="editor-filters" className="editor-filters"></div>
            <div className="editor-presets">
              <span className="editor-presets-label">Presets</span>
              {PRESETS.map(([key, label]) => (
                <button key={key} className="btn btn-small" type="button" data-preset={key}>{label}</button>
              ))}
            </div>
            <div className="editor-actions">
              <button id="editor-reset-filters" className="btn btn-icon-text" type="button">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="1 4 1 10 7 10" /><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" /></svg>
                Reset filters
              </button>
            </div>
            {host('rx-drift-host-sound')}
          </div>
          <p id="editor-empty" className="editor-empty">Select a sound above to trim and apply filters.</p>
        </div>
        {/* Controls the library replaces stay in the DOM (the tab still reads and writes them), out of sight: the old picker, the mix pickers, the time readout. */}
        <div className="rx-holder" hidden>
          <span id="editor-mode-hint" className="editor-mode-hint">{MODE_HINT}</span>
          {/* Group mode lists the groups of one preset: that preset's select sits under the chips. The group select itself is replaced by the list. */}
          <div id="editor-mix-picker-row" className="editor-mix-picker-row hidden">
            <span>Preset</span>
            <span id="editor-mix-group-select-label" className="hidden">Group</span>
            <select id="editor-mix-group-select" className="hidden" aria-label="Group"></select>
            <button id="editor-mix-group-new" className="btn btn-small hidden" type="button">+ New group</button>
          </div>
          <span id="editor-sticky-time" className="editor-sticky-time rx-num">0:00 / 0:00</span>
        </div>
      </div>
      <button id="editor-scroll-top" className="editor-scroll-top-btn hidden" type="button" title="Scroll to top">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 19V5" />
          <path d="M5 12l7-7 7 7" />
        </svg>
      </button>
      <div id="editor-leave-confirm" className="modal hidden">
        <div className="modal-card">
          <h2>Leave with unsaved changes?</h2>
          <p className="modal-hint">Whatever's changed since you opened this sound in Remix hasn't been saved - leaving now discards it.</p>
          <div className="modal-actions">
            <button id="editor-leave-confirm-dont-ask" className="btn" type="button">Don't ask again</button>
            <button id="editor-leave-confirm-no" className="btn" type="button">No</button>
            <button id="editor-leave-confirm-yes" className="btn btn-primary" type="button">Yes</button>
          </div>
        </div>
      </div>
    </>
  )
}

export function mountRemixApp(container, { previewVolume }) {
  flushSync(() => createRoot(container).render(<RemixApp previewVolume={previewVolume} />))
}
