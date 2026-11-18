// The approved look's knob: a 270-degree arc around a range input. The one
// knob for the whole Remix tab (rebuild plan step 1). Drag left/right; the
// wheel is the app's one knob rule (core knobSelect.js, owner 2026-11-14):
// click the knob to select it, then the plain wheel turns it. data-knob opts
// in. Arrow keys work because the hidden input keeps the focus.
//
// Two ways to use it:
//  - Controlled (FilterControls): pass `value` and `onChange`; the component
//    renders its own range input.
//  - Wrapping (attachKnob in Knob.js): pass `input`, an existing range input;
//    it is moved into the ring and keeps its id, value and listeners.
import { useLayoutEffect, useRef } from 'react'
import { knobFraction, knobValueAt, DRAG_PX_FULL_RANGE } from './knobMath.js'

/**
 * @param {object} p
 * @param {string} p.label
 * @param {string} [p.title]
 * @param {number} p.value
 * @param {number} p.min
 * @param {number} p.max
 * @param {number} p.step
 * @param {string} [p.id]            id of the rendered input (controlled mode)
 * @param {boolean} [p.dim]          drawn dimmed, still works
 * @param {boolean} [p.disabled]     drawn dimmed and ignores drag and reset
 * @param {(next: number) => void} p.onChange   every step of a drag or key press
 * @param {() => void} [p.onCommit]  once a drag ends (the wrapper's 'change')
 * @param {() => void} p.onReset     double-click: back to the default
 * @param {string} [p.valueText]     text of the output (controlled mode)
 * @param {HTMLInputElement} [p.input]  wrap this existing input instead
 * @param {HTMLElement} [p.valueEl]  existing element shown in place of the output
 */
export function Knob({ label, title, value, min, max, step, id, dim = false, disabled = false, onChange, onCommit, onReset, valueText, input, valueEl }) {
  const knobRef = useRef(null)
  const ringRef = useRef(null)
  const drag = useRef(null)
  const latest = useRef(null)
  latest.current = { value, min, max, step, onChange, onCommit, onReset, input }

  // Wrapped input and value element are DOM that React does not own: move
  // them into place after render (the markup order is ring, label, value).
  useLayoutEffect(() => {
    if (input && input.parentNode !== ringRef.current) ringRef.current.appendChild(input)
    if (valueEl && valueEl.parentNode !== knobRef.current) knobRef.current.appendChild(valueEl)
  })

  const inputEl = () => latest.current.input ?? ringRef.current.querySelector('input')
  const setFraction = (fraction) => {
    const c = latest.current
    const next = knobValueAt(fraction, c.min, c.max, c.step)
    if (next !== c.value) c.onChange(next)
  }
  const end = () => {
    if (drag.current?.moved) latest.current.onCommit?.()
    drag.current = null
  }

  return (
    <div
      ref={knobRef}
      data-knob=""
      className={`rx-kn${dim || disabled ? ' rx-kn-disabled' : ''}`}
      title={title ? `${title} Drag, or click and scroll.` : 'Drag, or click and scroll'}
      style={{ '--p': knobFraction(value, min, max) * 100 }}
    >
      <div
        ref={ringRef}
        className="rx-ring"
        onPointerDown={(evt) => {
          if (evt.button !== 0 || disabled) return
          const c = latest.current
          drag.current = { x: evt.clientX, from: knobFraction(c.value, c.min, c.max), moved: false }
          evt.currentTarget.setPointerCapture(evt.pointerId)
          inputEl().focus({ preventScroll: true })
          evt.preventDefault()
        }}
        onPointerMove={(evt) => {
          const d = drag.current
          if (!d) return
          const dx = evt.clientX - d.x
          if (Math.abs(dx) > 3) d.moved = true
          if (d.moved) setFraction(d.from + dx / DRAG_PX_FULL_RANGE)
        }}
        onPointerUp={end}
        onPointerCancel={end}
        onDoubleClick={(e) => {
          // The app-wide double-click reset (src/renderer/core/sliderReset.js)
          // never sees a knob: pointer capture sends the dblclick to the ring,
          // and React overwrites a controlled input's defaultValue. So the
          // knob resets itself and keeps the event from that listener.
          e.stopPropagation()
          if (!disabled) latest.current.onReset()
        }}
      >
        <svg viewBox="0 0 72 72" aria-hidden="true">
          <circle className="rx-trk" cx="36" cy="36" r="31" pathLength="100" />
          <circle className="rx-val" cx="36" cy="36" r="31" pathLength="100" />
        </svg>
        <i className="rx-unity" />
        {!input && (
          <input
            id={id}
            className="rx-kn-input"
            type="range"
            aria-label={label}
            min={min}
            max={max}
            step={step}
            value={value}
            onChange={(e) => onChange(Number(e.target.value))}
          />
        )}
      </div>
      <label htmlFor={input ? input.id || undefined : id}>{label}</label>
      {!valueEl && <output className="editor-filter-value">{valueText}</output>}
    </div>
  )
}
