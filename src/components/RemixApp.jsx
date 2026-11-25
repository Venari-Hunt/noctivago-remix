import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'

const PRESETS = [
  ['muffled', 'Muffled'],
  ['phone', 'Over the Phone'],
  ['radio', 'On the Radio'],
  ['distant', 'Distant'],
  ['echo', 'Echo'],
  ['reverb', 'Reverb'],
  ['underwater', 'Underwater']
]

const host = (id) => <div id={id} style={{ display: 'contents' }} />

/**
 * The Remix tab shell: mode switch, picker row, the three mode panels, the
 * leave-confirm modal. Rendered once and never re-rendered: the tab and
 * layout.js own the DOM from here on (same ids and classes as the old markup).
 */
export function RemixApp() {
  return (
    <>
      <div className="editor-tab">
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
          <div id="editor-panel" className="editor-panel hidden">
            {host('rx-trim-host')}
            {host('rx-looprow-host')}
            {host('rx-playback-host')}
            {host('rx-seam-host')}
            {host('rx-speed-host')}
            <div id="editor-filters" className="editor-filters"></div>
            {host('rx-eq-host-sound')}
            {host('rx-spectrum-host')}
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
            <p id="editor-save-status" className="editor-save-status"></p>
          </div>
          <p id="editor-empty" className="editor-empty">Select a sound above to trim and apply filters.</p>
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

export function mountRemixApp(container) {
  flushSync(() => createRoot(container).render(<RemixApp />))
}
