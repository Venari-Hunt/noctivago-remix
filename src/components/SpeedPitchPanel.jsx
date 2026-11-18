// Speed and pitch accordion (rebuild plan step 5): two knobs, then Reverse as
// a switch row, a hint and the Reverse status line. Renders the final markup
// once into a host box; layout.js then moves `.rx-speed-body` into the
// accordion.
//
// The range inputs are rendered here and handed to attachKnob, the thin
// wrapper over Knob.jsx, which moves each into its ring. They stay
// uncontrolled: RemixTab reads and writes them by id (value, 'input' and
// 'change' events), so no second copy of the values exists. React never
// renders this tree a second time.
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { attachKnob } from './Knob.js'

function KnobRow({ id, label, min, max, step, value, text }) {
  return (
    <label data-knob-row={label}>
      <span>{label}</span>
      <input id={id} type="range" min={min} max={max} defaultValue={value} step={step} />
      <span id={`${id}-value`} className="editor-filter-value">
        {text}
      </span>
    </label>
  )
}

function SpeedPitchPanel() {
  return (
    <div className="rx-speed-body">
      <div className="rx-kgrid">
        <KnobRow id="editor-speed" label="Speed" min="50" max="200" step="5" value="100" text="100%" />
        <KnobRow id="editor-pitch" label="Pitch" min="-12" max="12" step="1" value="0" text="Off" />
      </div>
      <label className="rx-srow">
        <span className="rx-sl">
          <span>Reverse</span>
          <small>Plays live for sounds up to 10 minutes</small>
        </span>
        <input id="editor-reverse" type="checkbox" aria-label="Reverse" />
      </label>
      <p className="rx-hint rx-hint-l">Speed applies live. Pitch applies once saved (loops under 10 minutes) and previews roughly while you drag.</p>
      <p id="editor-reverse-status" className="hidden rx-hint rx-hint-l" role="status" />
    </div>
  )
}

/**
 * Renders the Speed and pitch body into `host`. Call once, before RemixTab
 * looks its elements up.
 * @param {HTMLElement} host
 */
export function mountSpeedPitchPanel(host) {
  flushSync(() => createRoot(host).render(<SpeedPitchPanel />))
  for (const row of host.querySelectorAll('[data-knob-row]')) {
    const input = row.querySelector('input')
    const knob = attachKnob(input, { label: row.dataset.knobRow, valueEl: row.querySelector('.editor-filter-value') })
    row.replaceWith(knob.el)
  }
}
