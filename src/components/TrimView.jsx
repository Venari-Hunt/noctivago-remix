// Trim view (rebuild plan step 6, third part): the name row, the waveform
// canvas with its scrollbar and status line, the Start/End/Length fields with
// Save segment as new, and the Doppler switch with its knobs, as the final
// markup. Renders once into a host box; layout.js moves these nodes into the
// Trim view (and pulls #editor-sync-group-row out of the name row).
//
// This is only the host: the waveform drawing and every gesture stay in
// WaveformView.js (bound by RemixTab to #editor-canvas and the scrollbar by
// id). Inputs are uncontrolled (RemixTab reads and writes them by id), the two
// Doppler knobs go through attachKnob, and React never renders this tree a
// second time.
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { attachKnob } from './Knob.js'
import { icon } from './icons.js'

function KnobRow({ id, label, min, max, value, text }) {
  return (
    <label data-knob-row={label}>
      <span>{label}</span>
      <input id={id} type="range" min={min} max={max} defaultValue={value} step="1" />
      <span id={`${id}-value`} className="editor-filter-value">
        {text}
      </span>
    </label>
  )
}

function TrimView() {
  return (
    <>
      <div className="editor-name-row">
        <h3 id="editor-sound-name" />
        <label id="editor-sync-group-row" className="editor-sync-group-row hidden">
          <span>Sync group</span>
          <input id="editor-scatter-sync-group" type="text" placeholder="e.g. door-effects" title="Give two or more Random Interval sounds the same name to make them always fire together - one starts, all start." />
        </label>
      </div>
      <canvas id="editor-canvas" width="640" height="160" title="Scroll to zoom, shift+scroll or middle-drag to pan. Right-click-drag inside the trimmed region to move it." />
      <div id="editor-scrollbar" className="editor-scrollbar">
        <div id="editor-scrollbar-thumb" className="editor-scrollbar-thumb" />
      </div>
      <p id="editor-waveform-status" className="editor-waveform-status" />
      <div className="editor-times rx-under">
        <label>
          Needle <input id="editor-needle-input" type="text" inputMode="numeric" placeholder="0:00" title="Where the needle is now. Type a time to move it." />
        </label>
        <label>
          Start <input id="editor-start-input" type="text" inputMode="numeric" placeholder="0:00" />
        </label>
        <label>
          End <input id="editor-end-input" type="text" inputMode="numeric" placeholder="0:00" />
        </label>
        <label>
          Length <input id="editor-length-input" type="text" inputMode="numeric" placeholder="0:00" />
        </label>
        <button
          id="editor-save-segment"
          className="rx-b"
          type="button"
          title="Trim out just this segment and save it as a brand-new sound, with every other setting at its default"
          dangerouslySetInnerHTML={{ __html: `${icon('copy')}<span>Save segment as new</span>` }}
        />
      </div>
      <div className="rx-under rx-wrap2">
        <div className="rx-opt2">
          <label className="editor-reverse-toggle">
            <input id="editor-doppler" type="checkbox" aria-label="Doppler pass-by" /> Doppler pass-by
          </label>
          <div id="editor-doppler-options" className="rx-kgrid hidden">
            <KnobRow id="editor-doppler-intensity" label="Intensity" min="1" max="12" value="5" text="5 st" />
            <KnobRow id="editor-doppler-sharpness" label="Sharpness" min="0" max="100" value="50" text="50%" />
            <label className="editor-reverse-toggle">
              <input id="editor-doppler-reversed" type="checkbox" />
              Reverse (peak = furthest point, not closest)
            </label>
          </div>
        </div>
      </div>
      <p id="editor-doppler-hint" className="rx-hint hidden">
        Simulates a sound passing by: pitch rises approaching the closest point (the gold marker on the waveform - drag it to control how fast each side ramps, double-click to re-center), then falls as it recedes toward Start/End. Reverse flips that: Start/End become the natural-pitch points and the marker becomes the peak shift instead — a sharp close pass-by rather than an approach/recede. Intensity sets how many semitones the shift swings; Sharpness sets how abruptly it swings through the marker — low is a slow continuous glide, high sits flat and does the whole swing in a burst right at the marker (the real pass-by whoosh). Only takes effect once saved (loops under 10 minutes) - no live preview while dragging.
      </p>
    </>
  )
}

/**
 * Renders the Trim view into `host`. Call once, before RemixTab looks its
 * elements up.
 * @param {HTMLElement} host
 */
export function mountTrimView(host) {
  flushSync(() => createRoot(host).render(<TrimView />))
  for (const row of host.querySelectorAll('[data-knob-row]')) {
    const knob = attachKnob(row.querySelector('input'), { label: row.dataset.knobRow, valueEl: row.querySelector('.editor-filter-value') })
    row.replaceWith(knob.el)
  }
}
