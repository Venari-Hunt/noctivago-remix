// The approved look's knob: a 270-degree arc around an existing range input.
// The input stays in the DOM (visually hidden) and keeps its id, value and
// listeners; the knob only sets input.value and fires the same 'input' and
// 'change' events a slider drag would, so no wiring changes.
//   attachKnob(input, { label, valueEl })
// Drag left/right, or side-scroll (Shift + wheel without a side wheel).
// Arrow keys work too, because the hidden input keeps the focus. Double-click
// resets it to its default.

const DRAG_PX_FULL_RANGE = 160 // same as the mock: 160 px of drag = the whole range
const WHEEL_PER_STEP = 30

const sideDelta = (evt) => {
  if (Math.abs(evt.deltaX) > Math.abs(evt.deltaY)) return evt.deltaX
  return evt.shiftKey ? evt.deltaY : 0
}

export function knobFraction(value, min, max) {
  if (!(max > min)) return 0
  return Math.min(1, Math.max(0, (value - min) / (max - min)))
}

// Snaps a 0..1 position to the input's own step grid.
export function knobValueAt(fraction, min, max, step) {
  const raw = min + Math.min(1, Math.max(0, fraction)) * (max - min)
  const s = step > 0 ? step : 1
  const snapped = min + Math.round((raw - min) / s) * s
  return Math.min(max, Math.max(min, Number(snapped.toFixed(6))))
}

export function attachKnob(input, { label, valueEl } = {}) {
  const doc = input.ownerDocument
  const knob = doc.createElement('div')
  knob.className = 'rx-kn'
  knob.title = 'Side-scroll or drag'
  knob.innerHTML =
    '<div class="rx-ring"><svg viewBox="0 0 72 72" aria-hidden="true"><circle class="rx-trk" cx="36" cy="36" r="31" pathLength="100"/><circle class="rx-val" cx="36" cy="36" r="31" pathLength="100"/></svg><i class="rx-unity"></i></div><label></label><output></output>'
  const ring = knob.querySelector('.rx-ring')
  const labelEl = knob.querySelector('label')
  const out = knob.querySelector('output')
  labelEl.textContent = label ?? ''
  if (input.id) labelEl.htmlFor = input.id
  if (!input.getAttribute('aria-label')) input.setAttribute('aria-label', label ?? '')
  input.classList.add('rx-kn-input')
  ring.appendChild(input)
  if (valueEl) out.replaceWith(valueEl)

  const range = () => ({ min: Number(input.min || 0), max: Number(input.max || 100), step: Number(input.step || 1) })
  const sync = () => {
    const { min, max } = range()
    knob.style.setProperty('--p', String(knobFraction(Number(input.value), min, max) * 100))
    knob.classList.toggle('rx-kn-disabled', input.disabled)
  }

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

  const setFraction = (fraction) => {
    if (input.disabled) return
    const { min, max, step } = range()
    const next = knobValueAt(fraction, min, max, step)
    if (next === Number(input.value)) return
    input.value = String(next)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const fractionNow = () => {
    const { min, max } = range()
    return knobFraction(Number(input.value), min, max)
  }

  let drag = null
  ring.addEventListener('pointerdown', (evt) => {
    if (evt.button !== 0 || input.disabled) return
    drag = { x: evt.clientX, from: fractionNow(), moved: false }
    ring.setPointerCapture(evt.pointerId)
    input.focus({ preventScroll: true })
    evt.preventDefault()
  })
  ring.addEventListener('pointermove', (evt) => {
    if (!drag) return
    const dx = evt.clientX - drag.x
    if (Math.abs(dx) > 3) drag.moved = true
    if (drag.moved) setFraction(drag.from + dx / DRAG_PX_FULL_RANGE)
  })
  const endDrag = () => {
    if (drag?.moved) input.dispatchEvent(new Event('change', { bubbles: true }))
    drag = null
  }
  ring.addEventListener('pointerup', endDrag)
  ring.addEventListener('pointercancel', endDrag)

  // Double-click resets to the markup default (the input's defaultValue), as
  // sliders did before 2.0. The app-wide reset (core/sliderReset.js) never
  // sees it: pointer capture sends the dblclick to the ring, not the input.
  // 'change' follows 'input', the same commit a drag ends with (undo, save).
  ring.addEventListener('dblclick', (evt) => {
    evt.stopPropagation()
    if (input.disabled || input.value === input.defaultValue) return
    input.value = input.defaultValue
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })

  let wheelTimer = null
  knob.addEventListener(
    'wheel',
    (evt) => {
      const d = sideDelta(evt)
      if (!d) return // the plain wheel still scrolls the panel
      evt.preventDefault()
      const unit = evt.deltaMode === 1 ? 40 : 1
      const { min, max, step } = range()
      // Never less than one step per notch, so a coarse input still moves.
      const byWheel = (d * unit) / WHEEL_PER_STEP / 100
      const oneStep = (step / (max - min)) * Math.sign(d)
      setFraction(fractionNow() + (Math.abs(byWheel) > Math.abs(oneStep) ? byWheel : oneStep))
      clearTimeout(wheelTimer)
      wheelTimer = setTimeout(() => input.dispatchEvent(new Event('change', { bubbles: true })), 250)
    },
    { passive: false }
  )
  input.addEventListener('input', sync)
  sync()
  return { el: knob, sync }
}
