// Remix's Sound-mode filter sliders (high/low-pass, gain, pan, noise gate,
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
import { useEffect, useState, useSyncExternalStore } from 'react'

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

function formatPan(pan) {
  return pan === 0 ? 'Center' : `${pan < 0 ? 'L' : 'R'} ${Math.round(Math.abs(pan) * 100)}%`
}

function Slider({ label, title, field, values, onEdit, format }) {
  const { min, max, step, def } = RANGES[field]
  return (
    <label title={title}>
      <span>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={values[field]}
        onChange={(e) => onEdit({ [field]: Number(e.target.value) })}
        onDoubleClick={(e) => {
          // The app-wide double-click reset (src/renderer/core/sliderReset.js)
          // reads the input's native defaultValue, which React overwrites on
          // every render of a controlled input - so this slider resets itself
          // and keeps the event from reaching that document listener.
          e.stopPropagation()
          onEdit({ [field]: def })
        }}
      />
      <span className="editor-filter-value">{format(values[field])}</span>
    </label>
  )
}

// Seconds field. Holds the text as typed ("1." mid-edit) locally and only
// resyncs from the store when the store's number actually differs, e.g.
// after "Noise sample from loop start".
function SecondsField({ label, title, field, values, onEdit }) {
  const value = values[field]
  const [text, setText] = useState(String(value))
  useEffect(() => {
    if ((Number(text) || 0) !== value) setText(String(value))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])
  return (
    <label title={title}>
      <span>{label}</span>
      <input
        type="number"
        min="0"
        step="0.1"
        value={text}
        onChange={(e) => {
          setText(e.target.value)
          onEdit({ [field]: Number(e.target.value) || 0 })
        }}
      />
      <span className="editor-filter-value">s</span>
    </label>
  )
}

function FilterControls({ store, onEdit, onNoiseSampleFromLoop }) {
  const values = useSyncExternalStore(store.subscribe, store.get)
  const gateOn = values.gateThresholdDb > -80 && values.gateRangeDb > 0
  const slider = { values, onEdit }
  return (
    <>
      <Slider {...slider} label="High-pass" field="highpassHz" format={(v) => (v > 0 ? `${v} Hz` : 'Off')} />
      <Slider {...slider} label="Low-pass" field="lowpassHz" format={(v) => (v < 20000 ? `${v} Hz` : 'Off')} />
      <Slider {...slider} label="Gain" field="gainDb" format={(v) => `${v > 0 ? '+' : ''}${v} dB`} />
      <Slider
        {...slider}
        label="Pan"
        field="pan"
        title="Stereo pan: move the sound toward the left or right speaker. Double-click to center."
        format={formatPan}
      />
      <Slider
        {...slider}
        label="Gate threshold"
        field="gateThresholdDb"
        title="Noise gate: quiets the sound whenever it drops below this level, to cut a hissy/rumbly noise floor between events. Left edge = off."
        format={(v) => (v > -80 ? `${v} dB` : 'Off')}
      />
      <Slider
        {...slider}
        label="Gate reduction"
        field="gateRangeDb"
        title="How much quieter the sound gets while the gate is closed (below the threshold). 0 = off."
        format={(v) => (v > 0 ? `-${v} dB` : 'Off')}
      />
      <Slider
        {...slider}
        label="Gate attack"
        field="gateAttackMs"
        title="How quickly the gate opens once the sound rises above the threshold."
        format={(v) => (gateOn ? `${v} ms` : '—')}
      />
      <Slider
        {...slider}
        label="Gate release"
        field="gateReleaseMs"
        title="How quickly the gate closes again once the sound falls back below the threshold. A longer release keeps a fading tail from chattering."
        format={(v) => (gateOn ? `${v} ms` : '—')}
      />
      <label title="Reduce steady background noise (hiss, hum, an air conditioner). Two-step: mark a stretch of the trimmed region that is noise only in the two fields below, then Save. Bake-only — no live preview, switch the preview to Saved audio to hear it.">
        <span>Noise reduction</span>
        <input
          type="checkbox"
          checked={values.denoiseEnabled}
          onChange={(e) => onEdit({ denoiseEnabled: e.target.checked })}
        />
        <span className="editor-filter-value">{values.denoiseEnabled ? 'On (bake only)' : 'Off'}</span>
      </label>
      <Slider
        {...slider}
        label="NR strength"
        field="denoiseStrengthDb"
        title="How aggressively to subtract the sampled noise profile. Higher removes more but can start to sound watery."
        format={(v) => (values.denoiseEnabled ? `${v} dB` : '—')}
      />
      <SecondsField
        {...slider}
        label="Noise from"
        field="denoiseSampleStartSec"
        title="Start of the noise-only sample, in seconds into the file. Pick a stretch of the trimmed loop region with only background noise and no events — ideally near its start."
      />
      <SecondsField
        {...slider}
        label="Noise to"
        field="denoiseSampleEndSec"
        title="End of the noise-only sample, in seconds into the file."
      />
      <div className="editor-filter-action">
        <button
          className="btn btn-small"
          type="button"
          title="Set the noise sample to the first ~1.5 seconds of the trimmed loop region"
          onClick={onNoiseSampleFromLoop}
        >
          Noise sample from loop start
        </button>
      </div>
      <Slider {...slider} label="Echo delay" field="echoDelayMs" format={(v) => (v > 0 ? `${v} ms` : 'Off')} />
      <Slider {...slider} label="Echo decay" field="echoDecay" format={(v) => (v > 0 ? v.toFixed(2) : 'Off')} />
      <Slider
        {...slider}
        label="Reverb size"
        field="reverbSizeMs"
        format={(v) => (v > 0 ? `${(v / 1000).toFixed(1)}s` : 'Off')}
      />
      <Slider
        {...slider}
        label="Reverb mix"
        field="reverbMix"
        format={(v) => (v > 0 ? `${Math.round(v * 100)}%` : 'Off')}
      />
    </>
  )
}

/**
 * Renders the filter sliders into `container`.
 *
 * @param {HTMLElement} container
 * @param {{ onChange: () => void, onNoiseSampleFromLoop: () => void }} callbacks
 *   onChange fires after every user edit, once the new values are readable
 *   through getValues().
 * @returns {{ getValues: () => object, setValues: (patch: object) => void, unmount: () => void }}
 *   setValues never calls onChange - same as setting a DOM input's .value.
 */
export function mountFilterControls(container, { onChange, onNoiseSampleFromLoop }) {
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
  root.render(<FilterControls store={store} onEdit={onEdit} onNoiseSampleFromLoop={onNoiseSampleFromLoop} />)
  return { getValues: () => values, setValues, unmount: () => root.unmount() }
}
