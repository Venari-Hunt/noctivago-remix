// Remix's Sound-mode filter knobs (high/low-pass, gain, pan, noise gate,
// noise reduction, echo, reverb) - the pilot for moving Remix's UI to React
// one panel at a time. Built to ../../islands/FilterControls.js by
// scripts/build-plugins.mjs; index.js imports that and calls
// mountFilterControls() on the empty #editor-filters box.
//
// The values live in a tiny external store, not in React state, because
// index.js reads them synchronously (currentFilters()) right after setting
// them (setFilterSliders()) - a React render hasn't happened yet at that
// point. React only renders from the store via useSyncExternalStore.
import { createRoot } from 'react-dom/client'
import { createPortal } from 'react-dom'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { knobFraction, knobValueAt } from './Knob.js'
import { formatPan } from './filterSummary.js'
export { filterSummaries } from './filterSummary.js'

const RANGES = {
  highpassHz: { min: 0, max: 2000, step: 10, def: 0 },
  lowpassHz: { min: 150, max: 20000, step: 50, def: 20000 },
  gainDb: { min: -24, max: 24, step: 0.5, def: 0 },
  pan: { min: -1, max: 1, step: 0.05, def: 0 },
  gateThresholdDb: { min: -80, max: 0, step: 1, def: -80 },
  gateRangeDb: { min: 0, max: 80, step: 1, def: 0 },
  gateAttackMs: { min: 1, max: 200, step: 1, def: 10 },
  gateReleaseMs: { min: 10, max: 1000, step: 10, def: 150 },
  denoiseStrengthDb: { min: 1, max: 48, step: 1, def: 12 },
  echoDelayMs: { min: 0, max: 1500, step: 10, def: 0 },
  echoDecay: { min: 0, max: 0.85, step: 0.01, def: 0 },
  reverbSizeMs: { min: 0, max: 4000, step: 100, def: 0 },
  reverbMix: { min: 0, max: 1, step: 0.01, def: 0 }
}

const DEFAULTS = {
  ...Object.fromEntries(Object.entries(RANGES).map(([key, r]) => [key, r.def])),
  denoiseEnabled: false,
  denoiseSampleStartSec: 0,
  denoiseSampleEndSec: 0
}

// A range input can't hold a value outside [min, max]; the old DOM sliders
// clamped silently, so the store does too.
function normalize(key, value) {
  if (key === 'denoiseEnabled') return Boolean(value)
  const n = Number(value) || 0
  const range = RANGES[key]
  return range ? Math.min(range.max, Math.max(range.min, n)) : n
}

const hz = (v) => (v >= 1000 ? `${(v / 1000).toFixed(v % 1000 ? 1 : 0)} kHz` : `${v} Hz`)

const DRAG_PX_FULL_RANGE = 160 // same as Knob.js and the mock
const WHEEL_PER_STEP = 30
const sideDelta = (evt) => {
  if (Math.abs(evt.deltaX) > Math.abs(evt.deltaY)) return evt.deltaX
  return evt.shiftKey ? evt.deltaY : 0
}

// The approved look's knob (same drawing as Knob.js's attachKnob, which wraps
// plain DOM inputs). A React-controlled range input can't be wrapped that way,
// so this draws the knob itself; the hidden input keeps keyboard and screen
// reader use. Drag left/right, side-scroll, or double-click to reset.
function Knob({ label, title, field, values, onEdit, format, dim = false }) {
  const { min, max, step, def } = RANGES[field]
  const value = values[field]
  const id = `editor-filter-${field}`
  const knobRef = useRef(null)
  const latest = useRef(null)
  latest.current = { value, onEdit }
  const drag = useRef(null)
  const setFraction = (fraction) => {
    const next = knobValueAt(fraction, min, max, step)
    if (next !== latest.current.value) latest.current.onEdit({ [field]: next })
  }

  useEffect(() => {
    const node = knobRef.current
    const onWheel = (evt) => {
      const d = sideDelta(evt)
      if (!d) return // the plain wheel still scrolls the panel
      evt.preventDefault()
      const unit = evt.deltaMode === 1 ? 40 : 1
      const byWheel = (d * unit) / WHEEL_PER_STEP / 100
      const oneStep = (step / (max - min)) * Math.sign(d)
      const from = knobFraction(latest.current.value, min, max)
      setFraction(from + (Math.abs(byWheel) > Math.abs(oneStep) ? byWheel : oneStep))
    }
    node.addEventListener('wheel', onWheel, { passive: false })
    return () => node.removeEventListener('wheel', onWheel)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div
      ref={knobRef}
      className={`rx-kn${dim ? ' rx-kn-disabled' : ''}`}
      title={title ? `${title} Side-scroll or drag.` : 'Side-scroll or drag'}
      style={{ '--p': knobFraction(value, min, max) * 100 }}
    >
      <div
        className="rx-ring"
        onPointerDown={(evt) => {
          if (evt.button !== 0) return
          drag.current = { x: evt.clientX, from: knobFraction(latest.current.value, min, max), moved: false }
          evt.currentTarget.setPointerCapture(evt.pointerId)
          evt.currentTarget.querySelector('input').focus({ preventScroll: true })
          evt.preventDefault()
        }}
        onPointerMove={(evt) => {
          const d = drag.current
          if (!d) return
          const dx = evt.clientX - d.x
          if (Math.abs(dx) > 3) d.moved = true
          if (d.moved) setFraction(d.from + dx / DRAG_PX_FULL_RANGE)
        }}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
        onDoubleClick={(e) => {
          // The app-wide double-click reset (src/renderer/core/sliderReset.js)
          // reads the input's native defaultValue, which React overwrites on
          // every render of a controlled input - so the knob resets itself and
          // keeps the event from reaching that document listener.
          e.stopPropagation()
          onEdit({ [field]: def })
        }}
      >
        <svg viewBox="0 0 72 72" aria-hidden="true">
          <circle className="rx-trk" cx="36" cy="36" r="31" pathLength="100" />
          <circle className="rx-val" cx="36" cy="36" r="31" pathLength="100" />
        </svg>
        <i className="rx-unity" />
        <input
          id={id}
          className="rx-kn-input"
          type="range"
          aria-label={label}
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onEdit({ [field]: Number(e.target.value) })}
        />
      </div>
      <label htmlFor={id}>{label}</label>
      <output className="editor-filter-value">{format(value)}</output>
    </div>
  )
}

// Seconds field. Holds the text as typed ("1." mid-edit) locally and only
// resyncs from the store when the store's number actually differs, e.g.
// after "Sample from loop start".
function SecondsField({ label, title, field, values, onEdit }) {
  const value = values[field]
  const [text, setText] = useState(String(value))
  useEffect(() => {
    if ((Number(text) || 0) !== value) setText(String(value))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])
  return (
    <input
      type="number"
      min="0"
      step="0.1"
      aria-label={label}
      title={title}
      value={text}
      onChange={(e) => {
        setText(e.target.value)
        onEdit({ [field]: Number(e.target.value) || 0 })
      }}
    />
  )
}

// Three settings groups, as in the approved mock: Tone, Cleanup, Space.
function FilterControls({ store, onEdit, onNoiseSampleFromLoop, targets }) {
  const values = useSyncExternalStore(store.subscribe, store.get)
  const gateOn = values.gateThresholdDb > -80 && values.gateRangeDb > 0
  const k = { values, onEdit }
  const tone = (
    <div className="rx-kgrid">
      <Knob {...k} label="High-pass" field="highpassHz" title="Cuts rumble below this frequency." format={(v) => (v > 0 ? hz(v) : 'Off')} />
      <Knob {...k} label="Low-pass" field="lowpassHz" title="Cuts hiss above this frequency." format={(v) => (v < 20000 ? hz(v) : 'Off')} />
      <Knob {...k} label="Gain" field="gainDb" format={(v) => `${v > 0 ? '+' : ''}${v} dB`} />
      <Knob {...k} label="Pan" field="pan" title="Stereo pan: move the sound toward the left or right speaker. Double-click to center." format={formatPan} />
    </div>
  )
  const clean = (
    <>
      <div className="rx-kgrid">
        <Knob {...k} label="Threshold" field="gateThresholdDb" title="Noise gate: quiets the sound whenever it drops below this level, to cut a hissy/rumbly noise floor between events. Left edge = off." format={(v) => (v > -80 ? `${v} dB` : 'Off')} />
        <Knob {...k} label="Reduction" field="gateRangeDb" title="How much quieter the sound gets while the gate is closed (below the threshold). 0 = off." format={(v) => (v > 0 ? `${v} dB` : 'Off')} />
        <Knob {...k} label="Attack" field="gateAttackMs" dim={!gateOn} title="How quickly the gate opens once the sound rises above the threshold." format={(v) => `${v} ms`} />
        <Knob {...k} label="Release" field="gateReleaseMs" dim={!gateOn} title="How quickly the gate closes again once the sound falls back below the threshold. A longer release keeps a fading tail from chattering." format={(v) => `${v} ms`} />
      </div>
      <label
        className="rx-srow rx-nr-row"
        title="Reduce steady background noise (hiss, hum, an air conditioner). Mark a stretch of the trimmed region that is noise only in the fields below, then Save. You hear it live while previewing, and Save bakes the same result."
      >
        <span className="rx-sl">
          <span>Noise reduction</span>
          <small>Plays live; saved the same way</small>
        </span>
        <input type="checkbox" checked={values.denoiseEnabled} onChange={(e) => onEdit({ denoiseEnabled: e.target.checked })} />
      </label>
      <div className="rx-kgrid">
        <Knob {...k} label="Strength" field="denoiseStrengthDb" dim={!values.denoiseEnabled} title="How aggressively to subtract the sampled noise profile. Higher removes more but can start to sound watery." format={(v) => `${v} dB`} />
      </div>
      <div className="rx-trow rx-noise-row">
        <span>Noise from</span>
        <SecondsField {...k} label="Noise from" field="denoiseSampleStartSec" title="Start of the noise-only sample, in seconds into the file. Pick a stretch of the trimmed loop region with only background noise and no events, ideally near its start." />
        <span>s to</span>
        <SecondsField {...k} label="Noise to" field="denoiseSampleEndSec" title="End of the noise-only sample, in seconds into the file." />
        <span>s</span>
      </div>
      <div className="rx-srow1">
        <button className="rx-b" type="button" title="Set the noise sample to the first ~1.5 seconds of the trimmed loop region" onClick={onNoiseSampleFromLoop}>
          Sample from loop start
        </button>
      </div>
    </>
  )
  const space = (
    <div className="rx-kgrid">
      <Knob {...k} label="Echo delay" field="echoDelayMs" format={(v) => (v > 0 ? `${v} ms` : 'Off')} />
      <Knob {...k} label="Echo decay" field="echoDecay" format={(v) => (v > 0 ? `${Math.round(v * 100)}%` : 'Off')} />
      <Knob {...k} label="Room size" field="reverbSizeMs" title="How long the reverb rings." format={(v) => (v > 0 ? `${(v / 1000).toFixed(1)} s` : 'Off')} />
      <Knob {...k} label="Reverb mix" field="reverbMix" format={(v) => (v > 0 ? `${Math.round(v * 100)}%` : 'Off')} />
    </div>
  )
  if (!targets) return <>{tone}{clean}{space}</>
  return (
    <>
      {createPortal(tone, targets.tone)}
      {createPortal(clean, targets.clean)}
      {createPortal(space, targets.space)}
    </>
  )
}

/**
 * Renders the filter knobs.
 *
 * @param {HTMLElement} container
 * @param {{ onChange: () => void, onNoiseSampleFromLoop: () => void, targets?: { tone: HTMLElement, clean: HTMLElement, space: HTMLElement } }} callbacks
 *   onChange fires after every user edit, once the new values are readable
 *   through getValues(). targets: where each settings group renders
 *   (portals); without it all three render into `container`.
 * @returns {{ getValues: () => object, setValues: (patch: object) => void, unmount: () => void }}
 *   setValues never calls onChange - same as setting a DOM input's .value.
 */
export function mountFilterControls(container, { onChange, onNoiseSampleFromLoop, targets }) {
  let values = { ...DEFAULTS }
  const listeners = new Set()
  const store = {
    get: () => values,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
  const setValues = (patch) => {
    const next = { ...values }
    for (const [key, value] of Object.entries(patch)) {
      if (key in DEFAULTS && value !== undefined) next[key] = normalize(key, value)
    }
    values = next
    for (const listener of listeners) listener()
  }
  const onEdit = (patch) => {
    setValues(patch)
    onChange()
  }

  const root = createRoot(container)
  root.render(<FilterControls store={store} onEdit={onEdit} onNoiseSampleFromLoop={onNoiseSampleFromLoop} targets={targets} />)
  return { getValues: () => values, setValues, unmount: () => root.unmount() }
}
