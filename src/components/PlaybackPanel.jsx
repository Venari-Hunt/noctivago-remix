// Playback accordion (rebuild plan step 5): play mode tiles, the Random and
// Scheduled settings, and the shot-edge fade fields. Renders the final markup
// once into a host box; layout.js then moves the nodes into the accordion.
//
// Inputs are uncontrolled on purpose: RemixTab reads and writes them straight
// through the ids below (same as before), so there is no second copy of the
// values to keep in sync, and a re-render must never replace them. React
// never renders this tree a second time.
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { icon } from './icons.js'

const TILES = [
  ['editor-playmode-loop', 'loop', 'repeat', 'Loop'],
  ['editor-playmode-scatter', 'scatter', 'shuffle', 'Random'],
  ['editor-playmode-scheduled', 'scheduled', 'clock', 'Scheduled']
]

function Tiles() {
  return (
    <div className="rx-tiles3" role="radiogroup" aria-label="Playback mode">
      {TILES.map(([id, value, ic, text]) => (
        <label key={id} className="rx-tile">
          <input type="radio" name="editor-playmode" id={id} value={value} aria-label={text} defaultChecked={value === 'loop'} />
          <span className="rx-tile-face" dangerouslySetInnerHTML={{ __html: `${icon(ic, 20)}${text}` }} />
        </label>
      ))}
    </div>
  )
}

function FadeFields({ kind }) {
  return (
    <div id={`editor-${kind}-fade-fields`} className="editor-fade-fields">
      <label className="editor-fade-enable">
        <input id={`editor-${kind}-fade-enabled`} type="checkbox" />
        <span>Fade</span>
      </label>
      <label>
        <span>In</span>
        <input id={`editor-${kind}-fade-in`} type="number" min="0" max="10000" step="50" defaultValue="0" disabled />
        <span className="editor-filter-value">ms</span>
      </label>
      <label>
        <span>Out</span>
        <input id={`editor-${kind}-fade-out`} type="number" min="0" max="10000" step="50" defaultValue="0" disabled />
        <span className="editor-filter-value">ms</span>
      </label>
    </div>
  )
}

function Fade() {
  return (
    <div id="editor-fade-section" className="editor-fade-section hidden">
      <div className="editor-fade-heading">
        Fade shot edges <span className="editor-fluctuation-sub">(eases each play's start/end instead of a hard cut — drag the pins at the trim edges on the waveform above, or set exact values here)</span>
      </div>
      <FadeFields kind="scatter" />
      <FadeFields kind="schedule" />
    </div>
  )
}

// A per-play random bar: three-circle canvas plus Fully random and Bias.
function ShotAxis({ idp, label, sub }) {
  return (
    <div className="editor-fluctuation-axis">
      <span className="editor-fluctuation-enable">
        {label} <span className="editor-fluctuation-sub">{sub}</span>
      </span>
      <canvas id={`${idp}-bar`} className="editor-fluctuation-bar" title="Drag the circles. Double-click one to reset it." />
      <div className="editor-fluctuation-knobs">
        <label className="editor-fluctuation-fullrandom">
          <input id={`${idp}-fully-random`} type="checkbox" />
          <span>
            Fully random <span className="editor-fluctuation-sub">(ignore the circles — roll the whole range every play)</span>
          </span>
        </label>
        <label className="editor-fluctuation-fullrandom">
          <input id={`${idp}-bias-enabled`} type="checkbox" />
          <span>
            Bias <span className="editor-fluctuation-sub">(the middle circle wins more often than a plain random pick)</span>
          </span>
        </label>
      </div>
    </div>
  )
}

function ShotAxes({ kind, word }) {
  return (
    <>
      <ShotAxis idp={`editor-${kind}-pitch`} label="Pitch" sub={`(a random shift every ${word})`} />
      <ShotAxis idp={`editor-${kind}-volume`} label="Volume" sub={`(a random level every ${word}; never above the sound's own)`} />
      <ShotAxis idp={`editor-${kind}-pan`} label="Pan" sub={`(a random left/right position every ${word})`} />
      <ShotAxis idp={`editor-${kind}-speed`} label="Speed" sub={`(a random tempo every ${word}, 50–200%)`} />
    </>
  )
}

function GapRange({ id, label, def }) {
  return (
    <label>
      <span>{label}</span>
      <input id={id} type="number" min="0" max="3600" step="1" defaultValue={def} />
      <span className="editor-filter-value">s</span>
    </label>
  )
}

function Scatter() {
  return (
    <div id="editor-scatter-section" className="editor-scatter-controls hidden">
      <div className="editor-fluctuation-axis editor-gap-axis">
        <span className="editor-fluctuation-enable">
          Gap <span className="editor-fluctuation-sub">(how long to wait between replays)</span>
        </span>
        <div className="editor-gap-range">
          <GapRange id="editor-scatter-gap-min" label="Min" def="5" />
          <GapRange id="editor-scatter-gap-max" label="Max" def="35" />
          <GapRange id="editor-scatter-gap-bias" label="Bias" def="20" />
        </div>
        <div className="editor-fluctuation-knobs">
          <label className="editor-fluctuation-fullrandom">
            <input id="editor-scatter-gap-fully-random" type="checkbox" />
            <span>
              Fully random <span className="editor-fluctuation-sub">(a new random wait, 0–2 min, before every replay — ignores Min/Max above)</span>
            </span>
          </label>
          <label className="editor-fluctuation-fullrandom">
            <input id="editor-scatter-gap-bias-enabled" type="checkbox" />
            <span>
              Bias <span className="editor-fluctuation-sub">(this gap wins more often than a plain random pick within Min/Max)</span>
            </span>
          </label>
        </div>
      </div>
      <p id="editor-scatter-group-note" className="editor-scatter-hint hidden" />
      <ShotAxes kind="scatter" word="replay" />
      <p className="editor-scatter-hint">
        Each replay picks a random gap, pitch, volume, pan, and speed within these ranges — or check "Fully random" to roll the whole range regardless of the min/max. Check "Bias" to make one value inside the range (the middle circle) win more often than a plain random pick. On the bars, drag the outer circles for the range; when they sit together there's no variation. Speed changes each shot's tempo/length with its pitch left alone. Fade (above, near the waveform) eases each shot's start/end instead of a hard cut. Sync group (next to the sound's name) makes two or more scatter sounds always fire together - one starts, all start.
      </p>
    </div>
  )
}

// Times and Every are two switches. Only one runs at a time for now, so they
// stay one radio group (RemixTab keeps the last one from being switched off).
function ScheduleAxis({ id, value, title, sub, checked, row }) {
  return (
    <div className="rx-axis">
      <label className="rx-srow">
        <span className="rx-sl">
          <span>{title}</span>
          <small>{sub}</small>
        </span>
        <input type="radio" name="editor-schedule-type" id={id} value={value} aria-label={title} defaultChecked={checked} />
      </label>
      {row}
    </div>
  )
}

function Schedule() {
  return (
    <div id="editor-schedule-section" className="editor-scatter-controls hidden">
      <ScheduleAxis
        id="editor-schedule-type-times"
        value="times"
        title="Times (24h, comma-separated)"
        sub="Plays once at each time, every day"
        checked
        row={
          <label id="editor-schedule-times-row" className="rx-trow">
            <input id="editor-schedule-times" type="text" inputMode="numeric" placeholder="12:00, 00:00" />
          </label>
        }
      />
      <ScheduleAxis
        id="editor-schedule-type-interval"
        value="interval"
        title="Every"
        sub="Or repeat, lined up with the clock"
        row={
          <label id="editor-schedule-interval-row" className="hidden rx-trow">
            <input id="editor-schedule-interval" type="number" min="1" max="1440" step="1" defaultValue="60" />
            <span className="editor-filter-value">minutes</span>
          </label>
        }
      />
      <p id="editor-schedule-group-note" className="editor-scatter-hint hidden" />
      <ShotAxes kind="schedule" word="trigger" />
      <p className="editor-schedule-hint">
        Fixed times play once at each listed clock time (24h HH:MM), every day. Recurring interval plays every N minutes, aligned to midnight — 60 lands on the hour, 30 on the hour and half-hour, like a digital clock rather than counting from whenever the app started. Each trigger picks a random pitch, volume, pan, and speed within these ranges, same as Random Interval — or check "Fully random" to roll the whole range regardless of the circles. Check "Bias" to make the middle circle's value win more often than a plain random pick. When a bar's outer circles sit together there's no variation. Speed changes each trigger's tempo/length with its pitch left alone. Fade (above, near the waveform) eases each trigger's start/end instead of a hard cut.
      </p>
    </div>
  )
}

function PlaybackPanel() {
  return (
    <>
      <Tiles />
      <p className="rx-hint rx-hint-l rx-only-random">Replays this clip at a random gap instead of looping. Good for a creak or a bird call inside a longer mix.</p>
      <p className="rx-hint rx-hint-l rx-only-scheduled">Plays once at clock times, like a church bell at noon or an hourly chime.</p>
      <Scatter />
      <Schedule />
      <Fade />
    </>
  )
}

/**
 * Renders the Playback pieces into `host`. Call once, before RemixTab looks
 * its elements up; layout.js takes the nodes from there.
 * @param {HTMLElement} host
 */
export function mountPlaybackPanel(host) {
  flushSync(() => createRoot(host).render(<PlaybackPanel />))
}
