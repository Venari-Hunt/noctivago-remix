// Repair view (was Spectrum; rebuild plan step 6, first part): the spectral repair canvas
// plus its controls (shape, selection text, Reduce by, Delete box, Clear all
// boxes) and the how-to line, as the final markup. Renders once into a host
// box; layout.js moves #editor-spectral-section into the Spectrum view.
//
// This is only the host: the canvas drawing and every gesture stay in
// SpectralRepairView.js, which RemixTab binds to #editor-spectral-canvas by id
// as before. Controls are uncontrolled (RemixTab reads and writes them by id),
// and React never renders this tree a second time.
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { icon } from './icons.js'

function SpectrumView() {
  return (
    <div id="editor-spectral-section" className="editor-spectral">
      <canvas
        id="editor-spectral-canvas"
        className="editor-spectral-canvas"
        title="Drag to draw a box around a sound to remove (or switch to Freehand and drag a loop around it). Drag a shape to move it, drag a box edge or a freehand corner dot to resize it, right-click it (or select it and press Delete) to remove it. With Noise sample, drag across the spectrogram to mark a stretch that is noise only; drag its handles to resize it."
      />
      <div className="editor-spectral-controls rx-under">
        <div id="editor-spectral-shape" className="rx-seg" role="group" aria-label="Tool">
          <button type="button" data-shape="box" aria-pressed="true" title="Drag a rectangle around the sound" dangerouslySetInnerHTML={{ __html: `${icon('square')}<span>Box</span>` }} />
          <button type="button" data-shape="free" aria-pressed="false" title="Drag a freehand loop around the sound" dangerouslySetInnerHTML={{ __html: `${icon('lasso')}<span>Freehand</span>` }} />
          <button type="button" data-shape="noise" aria-pressed="false" title="Drag a stretch across the spectrogram that is noise only, for Noise reduction to learn from" dangerouslySetInnerHTML={{ __html: `${icon('noise')}<span>Noise sample</span>` }} />
        </div>
        <span id="editor-spectral-selection" className="editor-spectral-selection">
          No box selected
        </span>
        <label className="rx-lrow2">
          <span>Reduce by</span>
          <input id="editor-spectral-reduction" className="rx-field rx-numf" type="number" min="6" max="80" step="1" defaultValue="40" disabled />
          <span id="editor-spectral-reduction-value" className="editor-filter-value rx-visually-hidden">
            40 dB
          </span>
          <span className="rx-unit">dB</span>
        </label>
        <button id="editor-spectral-delete" className="rx-b rx-ghost" type="button" title="Delete the selected box" disabled dangerouslySetInnerHTML={{ __html: `${icon('trash-2')}<span>Delete box</span>` }} />
        <button id="editor-spectral-clear" className="rx-b rx-ghost" type="button">
          <span>Clear all boxes</span>
        </button>
        <button id="editor-spectral-use-noise" className="rx-b" type="button" title="Learn the noise from this shape's whole time range (every frequency in it)" disabled dangerouslySetInnerHTML={{ __html: `${icon('noise')}<span>Use shape as noise sample</span>` }} />
      </div>
      <div className="rx-legend" aria-live="polite">
        <span id="editor-spectral-legend-noise" className="hidden">
          <i className="rx-sw rx-sw-noise" />
          <span id="editor-spectral-legend-noise-text">Noise sample</span>
        </span>
        <span>
          <i className="rx-sw rx-sw-shape" />
          Repair shape (turned down)
        </span>
      </div>
      <p className="editor-eq-hint rx-hint">
        Repair removes a short sound hiding inside another one: a cough in the rain, a bird over the wind, a phone buzz. Find it as a bright spot on the spectrogram (time across, pitch up), drag a box around it, and just that box gets turned down. Everything outside the box stays as it was. For steady hiss or hum, mark a stretch that is noise only with Noise sample, then turn on Noise reduction in Settings. You hear it live while previewing, and Save bakes the same result.
      </p>
    </div>
  )
}

/**
 * Renders the Spectrum view into `host`. Call once, before RemixTab looks its
 * elements up.
 * @param {HTMLElement} host
 */
export function mountSpectrumView(host) {
  flushSync(() => createRoot(host).render(<SpectrumView />))
}
