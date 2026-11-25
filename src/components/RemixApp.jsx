import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { icon } from './icons.js'

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

// The Sound settings column: its heading and the small-window close button.
// layout.js adds the accordions (Accordion.jsx) after them.
function SoundSide() {
  return (
    <aside className="rx-side" aria-label="Settings">
      <h3 className="rx-side-h">Settings</h3>
      {/* Below 860 the settings slide in from the right; this closes them (styles.css "Small windows"). */}
      <button className="rx-i rx-ib rx-side-hide rx-xs-only" type="button" title="Hide settings" aria-label="Hide settings" dangerouslySetInnerHTML={html(icon('x'))} />
    </aside>
  )
}

const host = (id) => <div id={id} style={{ display: 'contents' }} />

// Studio panes (mock-noctivago-remix-studio v2), left to right: the library over
// the preview module, then the head. layout.js wires them (buildStudio) and
// arrangeBar moves the sticky controls in. The tab element is their grid.
function StudioLeft() {
  return (
    <div className="rx-lcol">
      <aside className="rx-pane rx-lib" aria-label="Library">
        <div
          className="rx-lib-h"
          dangerouslySetInnerHTML={html(
            `<h3>Remix</h3><button id="rx-new-group" class="rx-i rx-ib" type="button" title="New group" aria-label="New group">${icon('plus')}</button><button id="rx-lib-hide" class="rx-i rx-ib rx-narrow-only" type="button" title="Hide the library" aria-label="Hide the library">${icon('chevron-left')}</button>`
          )}
        />
        <div id="rx-chips" className="rx-chips" role="group" aria-label="What you remix"></div>
        <label id="rx-in-preset" className="rx-in-preset"><span>In preset</span></label>
        <label
          className="rx-search"
          dangerouslySetInnerHTML={html(`${icon('search')}<input id="rx-lib-search" type="text" placeholder="Search sounds" aria-label="Search" autocomplete="off" />`)}
        />
        <div id="rx-lib-list" className="rx-list"></div>
      </aside>
      <section className="rx-pane rx-prev" aria-label="Preview">
        <div className="rx-prow"><span id="rx-pplay-slot" className="rx-slot"></span><b id="rx-now-name" className="rx-now"></b><span id="rx-prow-end" className="rx-slot"></span></div>
        <div id="rx-pnote" className="rx-pnote" hidden>Playing this group only</div>
        <div className="rx-pseek"><span id="rx-cur">0:00</span><div id="rx-seek-slot" className="rx-seek-slot"></div><span id="rx-total">0:00</span></div>
        <div id="rx-pvol" className="rx-pvol"></div>
        {/* emptied into the rows by arrangeBar */}
        <div id="rx-transport" className="rx-under rx-transport"></div>
      </section>
    </div>
  )
}

function StudioHead() {
  return (
    <div
      className="rx-pane rx-head"
      dangerouslySetInnerHTML={html(
        `<button id="rx-lib-show" class="rx-i rx-ib rx-narrow-only" type="button" title="Show the library" aria-label="Show the library">${icon('chevron-right')}</button>` +
          '<div class="rx-ht"><div id="rx-kind" class="rx-kind">Sound</div><h2 id="rx-title" class="rx-title"></h2><div id="rx-meta" class="rx-meta"></div></div><div id="rx-acts" class="rx-acts"></div>' +
          `<button id="rx-side-show" class="rx-b rx-ghost rx-xs-only" type="button" aria-expanded="false">${icon('sliders-horizontal')}Settings</button>`
      )}
    />
  )
}

/**
 * The Remix tab shell: mode switch, picker row, the three mode panels, the
 * leave-confirm modal. Rendered once and never re-rendered: the tab and
 * layout.js own the DOM from here on (same ids and classes as the old markup).
 */
export function RemixApp() {
  return (
    <>
      <div className="editor-tab rx">
        <StudioLeft />
        <StudioHead />
        <div className="editor-mode-switch-row">
          <div className="editor-mode-switch">
            <button id="editor-mode-sound" className="editor-mode-pill editor-mode-pill-active" type="button">Sound</button>
            <button id="editor-mode-preset" className="editor-mode-pill" type="button">Preset</button>
            <button id="editor-mode-group" className="editor-mode-pill" type="button">Group</button>
          </div>
          <span id="editor-mode-hint" className="editor-mode-hint">Trim, filters, EQ and live preview for one sound at a time.</span>
        </div>

        <div id="editor-mix-picker-row" className="editor-mix-picker-row hidden">
          <span>Preset</span>
          <select id="editor-mix-preset-select"></select>
          <span id="editor-mix-group-select-label" className="hidden">Group</span>
          <select id="editor-mix-group-select" className="hidden"></select>
          <button id="editor-mix-group-new" className="btn btn-small hidden" type="button">+ New group</button>
        </div>

        <div id="editor-mode-panel-preset" className="editor-mode-panel hidden"></div>

        <div id="editor-mode-panel-group" className="editor-mode-panel hidden"></div>

        <div id="editor-mode-panel-sound">
          {host('rx-picker-host')}
          <div id="editor-panel" className="editor-panel rx-grid hidden" data-view="trim">
            <SoundCanvas />
            <SoundSide />
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
        {/* Controls the library replaces stay in the DOM (the tab still reads and writes them), out of sight. */}
        <div className="rx-holder" hidden></div>
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

export function mountRemixApp(container) {
  flushSync(() => createRoot(container).render(<RemixApp />))
}
