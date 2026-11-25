// Group panel and Preset panel (rebuild plan step 8), as the final markup.
// Both are the same card: filter sliders, the EQ host, effect chips, Reset
// filters, the drift host. They differ in the id prefix, the sliders on show
// (Group adds Pan and Occlusion, Preset adds Fade in), the top of the card
// and the footer text. Each renders once into its `.editor-mode-panel` box
// (RemixTab toggles `hidden` on that box); EqView and Drift mount into the
// hosts below, and every control stays uncontrolled, read by id.
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { FILTER_ROWS, effectChips } from './mixPanelsLogic.js'

const RESET_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>'

function FilterRows({ prefix, rows }) {
  return (
    <div className="editor-filters">
      {rows.map((r) =>
        r.kind === 'number' ? (
          <label key={r.key}>
            <span>{r.label}</span>
            <input id={`${prefix}-${r.key}`} type="number" min={r.min} max={r.max} step={r.step} defaultValue={r.value} />
            <span className="editor-filter-value">{r.note}</span>
          </label>
        ) : (
          <label key={r.key} title={r.title}>
            <span>{r.label}</span>
            <input id={`${prefix}-${r.key}`} type="range" min={r.min} max={r.max} step={r.step} defaultValue={r.value} />
            <span id={`${prefix}-${r.key}-value`} className="editor-filter-value">
              {r.initial}
            </span>
          </label>
        )
      )}
    </div>
  )
}

function Chips({ attr }) {
  return (
    <div className="editor-presets">
      <span className="editor-presets-label">Presets</span>
      {effectChips().map(([key, label]) => (
        <button key={key} className="btn btn-small" type="button" {...{ [attr]: key }}>
          {label}
        </button>
      ))}
    </div>
  )
}

function Footer({ id }) {
  return (
    <div className="editor-actions">
      <button id={id} className="btn btn-icon-text" type="button" dangerouslySetInnerHTML={{ __html: RESET_ICON + 'Reset filters' }} />
    </div>
  )
}

function PresetPanel() {
  return (
    <div id="editor-mix-preset-controls" className="editor-mix-controls editor-mix-disabled">
      <p className="editor-mix-status">Live loudness (last ~10s) - hit Play in the preview to hear and see this preset.</p>
      <canvas id="editor-mix-preset-waveform" className="editor-mix-waveform-canvas"></canvas>
      <FilterRows prefix="editor-mix-preset" rows={FILTER_ROWS.preset} />
      <div id="rx-eq-host-preset" style={{ display: 'contents' }}></div>
      <Chips attr="data-mix-preset-effect" />
      <Footer id="editor-mix-preset-reset-filters" />
      <div id="rx-drift-host-preset" style={{ display: 'contents' }}></div>
      <p id="editor-mix-preset-hint" className="editor-mix-status">
        Pick a preset in the list. These settings are saved on it and heard live on the whole mix whenever it's loaded in the Mixer.
      </p>
    </div>
  )
}

function GroupPanel() {
  return (
    <>
      <div id="editor-mix-group-editor" className="editor-mix-group-editor hidden">
        <div className="editor-mix-row">
          <span>Name</span>
          <input id="editor-mix-group-name" type="text" />
        </div>
        <p className="editor-mix-status">Live loudness (last ~10s) - hit Play in the preview to hear and see just this group.</p>
        <canvas id="editor-mix-group-waveform" className="editor-mix-waveform-canvas"></canvas>
        <p className="editor-mix-status">Sounds in this preset's mix:</p>
        <ul id="editor-mix-group-members" className="editor-mix-group-members"></ul>
        <FilterRows prefix="editor-mix-group" rows={FILTER_ROWS.group} />
        <div id="rx-eq-host-group" style={{ display: 'contents' }}></div>
        <Chips attr="data-mix-group-effect" />
        <Footer id="editor-mix-group-reset-filters" />
        <div id="rx-drift-host-group" style={{ display: 'contents' }}></div>
      </div>
      <p id="editor-mix-group-empty" className="editor-mix-status">
        Pick a preset under the chips, then make or pick a group to EQ some of its sounds together (e.g. crickets + toads to sound like they're outside).
      </p>
    </>
  )
}

function mount(host, Panel) {
  const root = createRoot(host)
  flushSync(() => root.render(<Panel />))
  return root
}

export const mountPresetPanel = (host) => mount(host, PresetPanel)
export const mountGroupPanel = (host) => mount(host, GroupPanel)
