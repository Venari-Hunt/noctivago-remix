// EQ view (rebuild plan step 6, fourth part): the parametric EQ graph with its
// tools row, band slots and the selected band's fields, as the final markup.
// One component for the three scopes (Sound, Group, Preset); they differ only
// in the id prefix, two sentences, the canvas and the Sound how-to line.
// Renders once into a host box; layout.js picks up the nodes.
//
// This is only the host: the graph, spectrum, band slots and every gesture
// stay in EqEditor.js, which RemixTab binds to the canvas id as before. The
// controls are uncontrolled (RemixTab reads and writes them by id) and React
// never renders this tree a second time. A/B compare and Reset EQ live in
// `.rx-eq-extras`: layout.js moves them to the side column and drops the box.
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { icon } from './icons.js'

const SCOPES = {
  sound: { p: 'editor-eq', noun: 'mix', canvasClass: undefined, size: { width: 640, height: 140 }, hint: true },
  group: { p: 'editor-mix-group-eq', noun: 'group', canvasClass: 'editor-mix-eq-canvas', hint: false },
  preset: { p: 'editor-mix-preset-eq', noun: 'mix', canvasClass: 'editor-mix-eq-canvas', hint: false }
}

const html = (markup) => ({ __html: markup })

function Sep() {
  return <span className="rx-sep" />
}

function EqView({ scope }) {
  const { p, noun, canvasClass, size, hint } = SCOPES[scope]
  return (
    <div className="editor-eq">
      <div className="rx-eq-extras">
        <div className="editor-eq-compare rx-seg" role="group" aria-label="Compare current session vs. last saved">
          <button id={`${p}-compare-a`} className="editor-eq-compare-btn editor-eq-compare-btn-active" type="button" title="Current session (editable)">
            A
          </button>
          <button id={`${p}-compare-b`} className="editor-eq-compare-btn" type="button" title={`Last saved ${noun} (read-only)`}>
            B
          </button>
        </div>
        <button id={`${p}-reset`} className="rx-b rx-ghost" type="button" title="Remove every band">
          Reset
        </button>
      </div>
      <button id={`${p}-revert-banner`} className="editor-eq-revert-banner hidden" type="button">
        {`Click to revert to previous session's ${noun}`}
      </button>
      <canvas className="rx-eq-ruler" aria-hidden="true" />
      <canvas
        id={`${p}-canvas`}
        className={canvasClass}
        {...size}
        title="Drag a node to adjust frequency/gain (hold Ctrl while dragging for finer control). Scroll over a node to adjust its Q. Double-click a node to reset its gain; Alt+click for a full reset."
      />
      <div className="rx-tools rx-eq-tools">
        <button id={`${p}-add-band`} className="rx-b" type="button" title="Add a band" dangerouslySetInnerHTML={html(`${icon('plus')}<span>Add band</span>`)} />
        <button
          id={`${p}-remove-band`}
          className="rx-b rx-ghost"
          type="button"
          title="Delete the selected band, or drag a node here"
          dangerouslySetInnerHTML={html(`${icon('trash-2')}<span>Delete band</span>`)}
        />
        <button id={`${p}-invert`} className="rx-b rx-ghost" type="button" title="Boosts become cuts and vice versa">
          <span>Invert</span>
        </button>
        <Sep />
        <button id={`${p}-zoom-out`} className="rx-i" type="button" title="Zoom out on the frequency axis (or scroll over empty graph space)" aria-label="Zoom out" dangerouslySetInnerHTML={html(icon('minus'))} />
        <button id={`${p}-zoom-in`} className="rx-i" type="button" title="Zoom in on the frequency axis (or scroll over empty graph space)" aria-label="Zoom in" dangerouslySetInnerHTML={html(icon('plus'))} />
        <Sep />
        <button id={`${p}-mute`} className="rx-b rx-ghost" type="button" title="Mute this band (keeps its settings, just stops applying it)">
          Mute band
        </button>
        <button id={`${p}-solo`} className="rx-b rx-ghost" type="button" title="Solo this band (hear only its effect, for auditioning while tuning)">
          Solo band
        </button>
        <span className="rx-tools-end">
          <div className="rx-seg" role="group" aria-label="Spectrum signal">
            <button type="button" data-tap="before" title="Spectrum before the EQ" aria-pressed="false">
              Before
            </button>
            <button type="button" data-tap="after" title="Spectrum after the EQ (what you hear)" aria-pressed="true">
              After
            </button>
            <button type="button" data-tap="both" title="Before dimmed behind After" aria-pressed="false">
              Both
            </button>
          </div>
          <div className="rx-seg" role="group" aria-label="Spectrum display">
            <button type="button" data-spec="spectrum" aria-pressed="false">
              Spectrum
            </button>
            <button type="button" data-spec="both" aria-pressed="true">
              Both
            </button>
            <button type="button" data-spec="heat" aria-pressed="false">
              Heatmap
            </button>
          </div>
        </span>
      </div>
      <div className="rx-under rx-eq-fields">
        <div className="rx-eq-slots" role="group" aria-label="Band slots" data-eq-slots-for={`${p}-canvas`} />
        <label className="rx-fl">
          <span>Type</span>
          <select id={`${p}-type`} className="rx-field" defaultValue="peaking">
            <option value="peaking">Peaking</option>
            <option value="off">Off</option>
            <option value="lowpass">Low Pass</option>
            <option value="highpass">High Pass</option>
            <option value="bandpass">Band Pass</option>
            <option value="notch">Notch</option>
            <option value="lowshelf">Low Shelf</option>
            <option value="highshelf">High Shelf</option>
          </select>
        </label>
        <label id={`${p}-slope-label`} className="rx-fl">
          <span>Slope</span>
          <select id={`${p}-slope`} className="rx-field" defaultValue="gentle">
            <option value="gentle">Gentle</option>
            <option value="steep">Steep</option>
          </select>
        </label>
        <label className="rx-fl">
          <span>Freq</span>
          <input id={`${p}-freq`} className="rx-field" type="number" min="20" max="20000" step="1" />
        </label>
        <label className="rx-fl">
          <span>Gain</span>
          <input id={`${p}-gain`} className="rx-field" type="number" min="-24" max="24" step="0.1" />
        </label>
        <label className="rx-fl">
          <span>Q</span>
          <input id={`${p}-q`} className="rx-field" type="number" min="0.1" max="20" step="0.1" />
        </label>
      </div>
      {hint && (
        <p className="editor-eq-hint rx-hint">
          Double-click the graph (or click +) to add a band, drag it to shape it (hold Ctrl while dragging for finer control), or type exact values above for the selected (highlighted) band. Scroll over a node to adjust its Q. Right-click a node to change its type or slope, or turn it off; Delete turns the selected band off. Double-click a node resets its gain; Alt+click fully resets it. The trash button (or dragging a node onto it) deletes the selected band. Mute silences a band without losing its settings; Solo hears only that band while tuning. The spectrum line (live) and heatmap glow (long-term level, brightest where the sound is loudest) show After the EQ by default, so they react as you drag bands; Before shows the sound as it arrives, Both draws Before dimmed behind After. The red-shaded regions show which frequencies your current bands cut.
        </p>
      )}
    </div>
  )
}

/**
 * Renders one scope's EQ into `host`. Call once per scope, before RemixTab
 * looks its elements up.
 * @param {HTMLElement} host
 * @param {'sound'|'group'|'preset'} scope
 */
export function mountEqView(host, scope) {
  flushSync(() => createRoot(host).render(<EqView scope={scope} />))
}
