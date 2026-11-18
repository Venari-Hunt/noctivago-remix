// attachKnob: wraps an existing range input in the Remix knob (Knob.jsx, the
// one knob for the tab). The input stays in the DOM (visually hidden) and keeps
// its id, value and listeners; the knob only sets input.value and fires the
// same 'input' and 'change' events a slider drag would, so no wiring changes.
//   attachKnob(input, { label, valueEl })
// Wheel rule, arrow keys and double-click reset: see Knob.jsx.
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { Knob } from './Knob.jsx'
export { knobFraction, knobValueAt } from './knobMath.js'

export function attachKnob(input, { label, valueEl } = {}) {
  const doc = input.ownerDocument
  if (!input.getAttribute('aria-label')) input.setAttribute('aria-label', label ?? '')
  input.classList.add('rx-kn-input')

  // The React root needs a host element; display: contents keeps it out of
  // the layout, so the knob is the flex/grid child as before.
  const host = doc.createElement('div')
  host.style.display = 'contents'
  const root = createRoot(host)

  const draw = () => {
    const el = createElement(Knob, {
      label: label ?? '',
      value: Number(input.value),
      min: Number(input.min || 0),
      max: Number(input.max || 100),
      step: Number(input.step || 1),
      disabled: input.disabled,
      input,
      valueEl,
      onChange: (next) => {
        input.value = String(next)
        input.dispatchEvent(new Event('input', { bubbles: true }))
      },
      onCommit: () => input.dispatchEvent(new Event('change', { bubbles: true })),
      onReset: () => {
        // Back to the markup default (the input's defaultValue), as sliders
        // did before 2.0. 'change' follows 'input', the same commit a drag
        // ends with (undo, save).
        if (input.value === input.defaultValue) return
        input.value = input.defaultValue
        input.dispatchEvent(new Event('input', { bubbles: true }))
        input.dispatchEvent(new Event('change', { bubbles: true }))
      }
    })
    flushSync(() => root.render(el))
  }
  const sync = () => draw()

  // Code that loads a sound sets input.value directly, which fires no event.
  // Wrapping the property on this one element keeps the arc in step.
  const proto = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')
  Object.defineProperty(input, 'value', {
    configurable: true,
    get() {
      return proto.get.call(this)
    },
    set(v) {
      proto.set.call(this, v)
      sync()
    }
  })

  input.addEventListener('input', sync)
  draw()
  return { el: host, sync }
}
