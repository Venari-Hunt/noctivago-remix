// Group panel and Preset panel (rebuild plan steps 8 and 9), as the final
// markup. Both are the same card: the canvas column (EQ tab row, loudness
// strip), the settings column shell, and the pieces layout.js (arrangeScope)
// hands to the accordions. They differ in the id prefix, the knobs on show
// (Group adds Pan and Occlusion, Preset adds Fade in), the top of the card
// and the hint text. Each renders once into its `.editor-mode-panel` box
// (RemixTab toggles `hidden` on that box); EqView and Drift mount into the
// hosts below, and every control stays uncontrolled, read by id.
//
// The accordion bodies sit in `.rx-bodies` (one `[data-body]` box per card)
// until arrangeScope moves them; knob rows are labels that mount() swaps for
// the knob (attachKnob), the same way TrimView does.
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { attachKnob } from './Knob.js'
import { icon } from './icons.js'
import { SettingsSide } from './SettingsSide.jsx'
import { FILTER_ROWS, effectChips } from './mixPanelsLogic.js'

const html = (__html) => ({ __html })

// Knob labels on the settings card (a few differ from the slider labels).
const KNOB_LABEL = { 'reverb-size': 'Room size', occlusion: 'Amount' }

// A range row that mount() turns into a knob. The value span feeds the knob's readout.
function KnobRow({ kind, rowKey }) {
  const r = FILTER_ROWS[kind].find((x) => x.key === rowKey)
  const p = `editor-mix-${kind}`
  const label = KNOB_LABEL[rowKey] ?? r.label
  return (
    <label data-knob-row={label}>
      <span>{label}</span>
      <input id={`${p}-${r.key}`} type="range" min={r.min} max={r.max} step={r.step} defaultValue={r.value} />
      <span id={`${p}-${r.key}-value`} className="editor-filter-value">
        {r.initial}
      </span>
    </label>
  )
}

const Knobs = ({ kind, keys }) => (
  <div className="rx-kgrid">
    {keys.map((k) => (
      <KnobRow key={k} kind={kind} rowKey={k} />
    ))}
  </div>
)

function Chips({ kind }) {
  const attr = `data-mix-${kind}-effect`
  return (
    <div className="rx-looks">
      {effectChips().map(([key, label]) => (
        <button key={key} className="rx-chip" type="button" {...{ [attr]: key }}>
          {label}
        </button>
      ))}
    </div>
  )
}

function ResetRow({ kind }) {
  return (
    <div className="rx-srow1">
      <button id={`editor-mix-${kind}-reset-filters`} className="rx-b rx-ghost" type="button" dangerouslySetInnerHTML={html(`${icon('refresh-cw')}<span>Reset filters</span>`)} />
    </div>
  )
}

const SPACE = ['echo-delay', 'echo-decay', 'reverb-size', 'reverb-mix']

// The canvas column: the view tab row (the EQ is the only view), then the
// loudness strip. arrangeScope puts the EQ graph right after the tabs.
function Canvas({ kind, children }) {
  return (
    <div className="rx-canvas">
      <div className="rx-tabs">
        <div className="rx-vtabs" role="group" aria-label="View">
          <button type="button" aria-pressed="true" title={`EQ for ${kind === 'group' ? 'this group' : 'the whole mix'}`}>
            EQ
          </button>
        </div>
      </div>
      {children}
    </div>
  )
}

function PresetPanel() {
  return (
    <div id="editor-mix-preset-controls" className="editor-mix-controls editor-mix-disabled rx-grid rx-scope">
      <Canvas kind="preset">
        <p className="editor-mix-status rx-hint">Live loudness (last ~10s) - hit Play in the preview to hear and see this preset.</p>
        <canvas id="editor-mix-preset-waveform" className="editor-mix-waveform-canvas"></canvas>
        <p id="editor-mix-preset-hint" className="editor-mix-status rx-hint">
          Pick a preset in the list. These settings are saved on it and heard live on the whole mix whenever it's loaded in the Mixer.
        </p>
      </Canvas>
      <SettingsSide />
      <div className="rx-bodies" hidden>
        <div data-body="tone">
          <div className="rx-filter-group">
            <Knobs kind="preset" keys={['highpass', 'lowpass', 'gain']} />
            {/* Fade in is not in the mock; it sits under Tone as a time row. */}
            <div className="rx-trow" title="Eases the whole mix up when the preset loads">
              <span>Fade in when the preset loads</span>
              <input id="editor-mix-preset-fadein" type="number" min="0" max="60" step="0.5" defaultValue="0" aria-label="Fade in" />
              <span>s</span>
            </div>
          </div>
        </div>
        <div data-body="space">
          <div className="rx-filter-group">
            <Knobs kind="preset" keys={SPACE} />
          </div>
        </div>
        <div data-body="looks">
          <Chips kind="preset" />
          <ResetRow kind="preset" />
        </div>
      </div>
      <div id="rx-eq-host-preset" style={{ display: 'contents' }}></div>
      <div id="rx-drift-host-preset" style={{ display: 'contents' }}></div>
    </div>
  )
}

function GroupPanel() {
  return (
    <>
      <div id="editor-mix-group-editor" className="editor-mix-group-editor hidden rx-grid rx-scope">
        <Canvas kind="group">
          <p className="editor-mix-status rx-hint">Live loudness (last ~10s) - hit Play in the preview to hear and see just this group.</p>
          <canvas id="editor-mix-group-waveform" className="editor-mix-waveform-canvas"></canvas>
        </Canvas>
        <SettingsSide />
        <div className="rx-bodies" hidden>
          {/* "Sounds in this group" (name and members) is not in the mock; the group cannot work without it, so it leads the column. */}
          <div data-body="members">
            <div className="rx-trow rx-name-row">
              <span>Name</span>
              <input id="editor-mix-group-name" className="rx-field" type="text" aria-label="Group name" />
            </div>
            <p className="rx-hint rx-hint-l">Sounds in this preset's mix:</p>
            <ul id="editor-mix-group-members" className="editor-mix-group-members"></ul>
          </div>
          <div data-body="tone">
            <div className="rx-filter-group">
              <Knobs kind="group" keys={['highpass', 'lowpass', 'gain', 'pan']} />
            </div>
          </div>
          <div data-body="space">
            <div className="rx-filter-group">
              <Knobs kind="group" keys={SPACE} />
            </div>
          </div>
          <div data-body="occl">
            <div className="rx-filter-group">
              <p className="rx-hint rx-hint-l">Sounds like this group is behind a wall or a door.</p>
              <Knobs kind="group" keys={['occlusion']} />
            </div>
          </div>
          <div data-body="looks">
            <Chips kind="group" />
            <ResetRow kind="group" />
          </div>
        </div>
        <div id="rx-eq-host-group" style={{ display: 'contents' }}></div>
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
  for (const row of host.querySelectorAll('[data-knob-row]')) {
    const knob = attachKnob(row.querySelector('input'), { label: row.dataset.knobRow, valueEl: row.querySelector('.editor-filter-value') })
    row.replaceWith(knob.el)
  }
  return root
}

export const mountPresetPanel = (host) => mount(host, PresetPanel)
export const mountGroupPanel = (host) => mount(host, GroupPanel)
