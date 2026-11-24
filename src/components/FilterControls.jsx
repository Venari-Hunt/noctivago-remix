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
import { useEffect, useState, useSyncExternalStore } from 'react'
import { Knob } from './Knob.jsx'
import { formatPan } from './filterSummary.js'
import { createStore } from '../state/remixStore.js'
import { icon } from './icons.js'
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

// One knob for the tab (Knob.jsx); this adapts it to the store's field names.
function FieldKnob({ label, title, field, values, onEdit, format, dim = false }) {
  const { min, max, step, def } = RANGES[field]
  return (
    <Knob
      label={label}
      title={title}
      id={`editor-filter-${field}`}
      value={values[field]}
      min={min}
      max={max}
      step={step}
      dim={dim}
      valueText={format(values[field])}
      onChange={(next) => onEdit({ [field]: next })}
      onReset={() => onEdit({ [field]: def })}
    />
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

// Past this strength, spectral subtraction starts to sound watery (Audition, Audacity say the same).
const WATERY_DB = 24
const SHOW_SAMPLE_KEY = 'noctivago-remix-show-noise-sample'
const PROFILE_W = 296
const PROFILE_H = 56
const PROFILE_RANGE_DB = 60

// The learned noise profile (dB per log-spaced frequency, from noiseProfileCurve),
// drawn as in the approved Repair mock: a 2 px line with a 12% fill. Only the
// shape means anything, so the loudest point sits near the top.
function NoiseProfile({ curve }) {
  if (!curve || !curve.length) {
    return (
      <div id="editor-noise-profile" className="rx-nr-profile rx-nr-profile-empty" aria-label="Learned noise profile">
        Mark a noise sample to see its profile
      </div>
    )
  }
  const top = Math.max(...curve)
  const pts = Array.from(curve, (v, i) => {
    const x = (i / (curve.length - 1)) * PROFILE_W
    const y = 6 + Math.min(1, Math.max(0, (top - v) / PROFILE_RANGE_DB)) * (PROFILE_H - 12)
    return `${x.toFixed(1)} ${y.toFixed(1)}`
  })
  const line = `M${pts.join(' L')}`
  return (
    <svg id="editor-noise-profile" className="rx-nr-profile" viewBox={`0 0 ${PROFILE_W} ${PROFILE_H}`} preserveAspectRatio="none" aria-label="Learned noise profile">
      <path className="rx-nr-area" d={`M0 ${PROFILE_H} L${pts.join(' L')} L${PROFILE_W} ${PROFILE_H} Z`} />
      <path d={line} fill="none" strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

// Three settings groups, as in the approved mock: Tone, Cleanup, Space.
function FilterControls({ store, uiStore, onEdit, onNoiseSampleFromLoop, onMarkNoiseSample, onShowSample, targets }) {
  const values = useSyncExternalStore(store.subscribe, store.get)
  const ui = useSyncExternalStore(uiStore.subscribe, uiStore.get)
  const gateOn = values.gateThresholdDb > -80 && values.gateRangeDb > 0
  const k = { values, onEdit }
  const tone = (
    <div className="rx-kgrid">
      <FieldKnob {...k} label="High-pass" field="highpassHz" title="Cuts rumble below this frequency." format={(v) => (v > 0 ? hz(v) : 'Off')} />
      <FieldKnob {...k} label="Low-pass" field="lowpassHz" title="Cuts hiss above this frequency." format={(v) => (v < 20000 ? hz(v) : 'Off')} />
      <FieldKnob {...k} label="Gain" field="gainDb" format={(v) => `${v > 0 ? '+' : ''}${v} dB`} />
      <FieldKnob {...k} label="Pan" field="pan" title="Stereo pan: move the sound toward the left or right speaker. Double-click to center." format={formatPan} />
    </div>
  )
  const clean = (
    <>
      <div className="rx-kgrid">
        <FieldKnob {...k} label="Threshold" field="gateThresholdDb" title="Noise gate: quiets the sound whenever it drops below this level, to cut a hissy/rumbly noise floor between events. Left edge = off." format={(v) => (v > -80 ? `${v} dB` : 'Off')} />
        <FieldKnob {...k} label="Reduction" field="gateRangeDb" title="How much quieter the sound gets while the gate is closed (below the threshold). 0 = off." format={(v) => (v > 0 ? `${v} dB` : 'Off')} />
        <FieldKnob {...k} label="Attack" field="gateAttackMs" dim={!gateOn} title="How quickly the gate opens once the sound rises above the threshold." format={(v) => `${v} ms`} />
        <FieldKnob {...k} label="Release" field="gateReleaseMs" dim={!gateOn} title="How quickly the gate closes again once the sound falls back below the threshold. A longer release keeps a fading tail from chattering." format={(v) => `${v} ms`} />
      </div>
    </>
  )
  // Noise reduction (Repair tab, owner 2026-11-21): the sample is marked on the
  // spectrogram or typed here; "Use loop start" stays as the quick default.
  const noise = (
    <>
      <label
        className="rx-srow rx-nr-row"
        title="Reduce steady background noise (hiss, hum, an air conditioner). Mark a stretch of the trimmed region that is noise only, then Save. You hear it live while previewing, and Save bakes the same result."
      >
        <span className="rx-sl">
          <span>Reduce steady noise</span>
          <small>Learns the hiss from the noise sample</small>
        </span>
        <input type="checkbox" checked={values.denoiseEnabled} onChange={(e) => onEdit({ denoiseEnabled: e.target.checked })} />
      </label>
      <label className="rx-srow rx-nr-show" title="Draw the noise sample as a band on the waveform. Drag it there to sample from a new spot.">
        <span className="rx-sl">
          <span>Show sample on waveform</span>
          <small>Drag the band to sample elsewhere</small>
        </span>
        <input id="editor-noise-show" type="checkbox" checked={ui.showSample} onChange={(e) => onShowSample(e.target.checked)} />
      </label>
      <div className="rx-nr-fields">
        <label className="rx-nr-field">
          <span>Sample from (s)</span>
          <SecondsField {...k} label="Sample from" field="denoiseSampleStartSec" title="Start of the noise-only sample, in seconds into the file." />
        </label>
        <label className="rx-nr-field">
          <span>to (s)</span>
          <SecondsField {...k} label="Sample to" field="denoiseSampleEndSec" title="End of the noise-only sample, in seconds into the file." />
        </label>
      </div>
      <div className="rx-srow1 rx-nr-actions">
        <button
          id="editor-noise-mark"
          className={`rx-b${ui.markOn ? ' rx-on' : ''}`}
          type="button"
          aria-pressed={ui.markOn}
          title="Drag across the spectrogram to mark a stretch that is noise only (N)"
          onClick={onMarkNoiseSample}
          dangerouslySetInnerHTML={{ __html: `${icon('noise')}<span>Mark noise sample</span>` }}
        />
        <button id="editor-noise-loop" className="rx-b rx-ghost" type="button" title="Set the noise sample to the first ~1.5 seconds of the trimmed loop region" onClick={onNoiseSampleFromLoop}>
          Use loop start
        </button>
      </div>
      <NoiseProfile curve={ui.profile} />
      <div className="rx-kgrid">
        <FieldKnob {...k} label="Strength" field="denoiseStrengthDb" dim={!values.denoiseEnabled} title="How aggressively to subtract the sampled noise profile. Higher removes more but can start to sound watery." format={(v) => `${v} dB`} />
      </div>
      {values.denoiseStrengthDb > WATERY_DB && (
        <p id="editor-noise-warn" className="rx-hint rx-hint-l rx-nr-hint" dangerouslySetInnerHTML={{ __html: `${icon('info')}<span>Above ${WATERY_DB} dB the sound can turn watery.</span>` }} />
      )}
      <p className="rx-hint rx-hint-l rx-nr-hint" dangerouslySetInnerHTML={{ __html: `${icon('info')}<span>0.5 s or more works best.</span>` }} />
    </>
  )
  const space = (
    <div className="rx-kgrid">
      <FieldKnob {...k} label="Echo delay" field="echoDelayMs" format={(v) => (v > 0 ? `${v} ms` : 'Off')} />
      <FieldKnob {...k} label="Echo decay" field="echoDecay" format={(v) => (v > 0 ? `${Math.round(v * 100)}%` : 'Off')} />
      <FieldKnob {...k} label="Room size" field="reverbSizeMs" title="How long the reverb rings." format={(v) => (v > 0 ? `${(v / 1000).toFixed(1)} s` : 'Off')} />
      <FieldKnob {...k} label="Reverb mix" field="reverbMix" format={(v) => (v > 0 ? `${Math.round(v * 100)}%` : 'Off')} />
    </div>
  )
  if (!targets) return <>{tone}{clean}{noise}{space}</>
  return (
    <>
      {createPortal(tone, targets.tone)}
      {createPortal(clean, targets.clean)}
      {createPortal(noise, targets.noise)}
      {createPortal(space, targets.space)}
    </>
  )
}

/**
 * Renders the filter knobs.
 *
 * @param {HTMLElement} container
 * @param {{ onChange: () => void, onNoiseSampleFromLoop: () => void, onMarkNoiseSample: () => void, targets?: { tone: HTMLElement, clean: HTMLElement, noise: HTMLElement, space: HTMLElement } }} callbacks
 *   onChange fires after every user edit, once the new values are readable
 *   through getValues(). targets: where each settings group renders
 *   (portals); without it all four render into `container`.
 * @returns {{ getValues: () => object, setValues: (patch: object) => void, setMarkOn: (on: boolean) => void, unmount: () => void }}
 *   setValues never calls onChange - same as setting a DOM input's .value.
 *   setMarkOn lights the "Mark noise sample" button (the Noise sample tool is on).
 */
export function mountFilterControls(container, { onChange, onNoiseSampleFromLoop, onMarkNoiseSample, onShowSampleChange = () => {}, targets }) {
  const store = createStore(DEFAULTS, normalize)
  // "Show sample on waveform" is a per-viewer choice, remembered in the browser (on by default).
  let showSample = true
  try {
    showSample = localStorage.getItem(SHOW_SAMPLE_KEY) !== '0'
  } catch {
    // storage unavailable: keep the default
  }
  const uiStore = createStore({ markOn: false, profile: null, showSample })
  const onShowSample = (on) => {
    uiStore.set({ showSample: Boolean(on) })
    try {
      localStorage.setItem(SHOW_SAMPLE_KEY, on ? '1' : '0')
    } catch {
      // storage unavailable: the choice lasts until the tab closes
    }
    onShowSampleChange()
  }
  const setValues = store.set
  const onEdit = (patch) => {
    setValues(patch)
    onChange()
  }

  const root = createRoot(container)
  root.render(<FilterControls store={store} uiStore={uiStore} onEdit={onEdit} onNoiseSampleFromLoop={onNoiseSampleFromLoop} onMarkNoiseSample={onMarkNoiseSample} onShowSample={onShowSample} targets={targets} />)
  return { getValues: store.get, getShowSample: () => uiStore.get().showSample, setValues, setMarkOn: (on) => uiStore.set({ markOn: Boolean(on) }), setNoiseProfile: (curve) => uiStore.set({ profile: curve || null }), unmount: () => root.unmount() }
}
