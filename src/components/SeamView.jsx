// Loop seam view (rebuild plan step 6, second part): the seam canvas, the
// crossfade knob, Listen to the seam, the status line and the how-to line, plus
// the volume envelope body (switch, Reset, hint), all as the final markup.
// Renders once into a host box; layout.js moves #editor-crossfade-section into
// the Loop seam view and .rx-envelope-body into its accordion.
//
// This is only the host: the canvas drawing and every gesture stay in
// SeamView.js, which RemixTab binds to #editor-seam-canvas by id as before.
// The crossfade range and the envelope checkbox are uncontrolled (RemixTab
// reads and writes them by id), the knob goes through attachKnob, and React
// never renders this tree a second time.
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { attachKnob } from './Knob.js'
import { icon } from './icons.js'

function SeamView() {
  return (
    <>
      <div id="editor-crossfade-section" className="editor-crossfade">
        <div className="editor-seam-heading">Loop seam</div>
        <canvas
          id="editor-seam-canvas"
          className="editor-seam-canvas"
          title="How the loop plays: the end of the trim crossfades into its start in the middle. Drag an edge of the crossfade to resize it, double-click an edge to reset it, click anywhere else to jump there."
        />
        <div className="rx-under">
          <button
            id="editor-seam-listen"
            className="rx-b"
            type="button"
            title="Play the few seconds around the loop point, through the crossfade, then stop"
            dangerouslySetInnerHTML={{ __html: `${icon('headphones')}<span>Listen to the seam</span>` }}
          />
          <label data-knob-row="Crossfade">
            <span>Loop crossfade</span>
            <input id="editor-crossfade" type="range" min="0" max="2000" defaultValue="200" step="10" />
            <span id="editor-crossfade-value" className="editor-filter-value">
              200 ms
            </span>
          </label>
        </div>
        <span id="editor-seam-status" className="editor-suggest-status" />
        <p className="rx-hint">
          The saved loop is the second half of your trim, then the first half, with the end of the trim crossfading into its start in the middle, so the loop's own restart falls on one continuous recording. Longer crossfades help busy, textured audio (rain, fire, crowds); 0 turns blending off. Capped at a quarter of the trim, and the loop plays that much shorter.
        </p>
      </div>
      <div className="rx-envelope-body">
        <label className="rx-srow">
          <span className="rx-sl">
            <span>Shape the volume over time</span>
            <small>With points on the Trim waveform</small>
          </span>
          <input id="editor-envelope-enabled" type="checkbox" aria-label="Volume envelope" />
        </label>
        <div className="rx-srow1 rx-envelope-actions">
          <button id="editor-envelope-reset" className="rx-b rx-ghost" type="button" dangerouslySetInnerHTML={{ __html: `${icon('refresh-cw')}<span>Reset envelope</span>` }} />
        </div>
        <p className="rx-hint rx-hint-l rx-envelope-hint">
          Drag a point to change the volume there. Double-click the line to add a point, double-click a point to reset it to full, right-click a point to remove it. Only lowers the volume, never boosts it.
        </p>
      </div>
    </>
  )
}

/**
 * Renders the Loop seam view and the envelope body into `host`. Call once,
 * before RemixTab looks its elements up.
 * @param {HTMLElement} host
 */
export function mountSeamView(host) {
  flushSync(() => createRoot(host).render(<SeamView />))
  const row = host.querySelector('[data-knob-row]')
  const knob = attachKnob(row.querySelector('input'), { label: row.dataset.knobRow, valueEl: row.querySelector('.editor-filter-value') })
  row.replaceWith(knob.el)
}
