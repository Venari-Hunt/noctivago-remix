// Drift accordions (rebuild plan step 5): one card per drift type, each a
// switch row that opens its range bar, timing and toggles. Sound, Group and
// Preset each render their own set once, as the final markup, into a host box;
// layout.js then hands the pieces to the accordions (driftBodies).
//
// The range bars are plain canvases that FluctuationBar (plain JS) draws on,
// found by id after this renders. Inputs are uncontrolled: RemixTab reads and
// writes them by id, so no second copy of the values exists, and React never
// renders this tree a second time.
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'

export const DRIFT_KEYS = { 'Volume drift': 'drift-vol', 'Pitch drift': 'drift-pitch', 'Pan drift': 'drift-pan' }

// [id prefix, title, sub line, "Each sound on its own" sub (group only)]
const SOUND = {
  id: 'editor-fluctuation-section',
  note: 'Slow, random drift while the sound loops: wind gusting, rain swelling. Plays in Live edit here and always in the Mixer. Saves on its own.',
  hint: 'Slow, random drift while the sound loops — wind gusting stronger and weaker, rain swelling and fading, something drifting closer and further. On each bar: drag the outer circles for the lowest/highest it reaches, the middle circle for where it sits most of the time. "Change every" is the seconds between new targets (a random value in that range); "Transition" is roughly how long each glide takes. "Fully random" ignores the circles and roams the whole range. Applies live in the Mixer and the preview, and is baked into exports. Saves on its own the moment you let go of a control — no need to hit Save.',
  axes: [
    ['editor-fluc-vol', 'Volume drift', "Rides below the sound's set volume"],
    ['editor-fluc-pitch', 'Pitch drift', 'Small shifts read as a gentle wobble'],
    ['editor-fluc-pan', 'Pan drift', 'Wanders left and right from the Pan setting']
  ]
}
const MIX_HINT = (scope) =>
  `Slow, random drift on ${scope} — weather rolling through, the ambience swelling and fading on its own. Drag the outer circles for the lowest/highest it reaches, the middle circle for where it sits most of the time. "Change every" is the seconds between new targets (a random value in that range); "Transition" is roughly how long each glide takes. Applies live in the Mixer and is baked into exports.`
const GROUP = {
  note: "Slow, random drift on this group's sounds. Applies live in the Mixer and is baked into exports.",
  hint: MIX_HINT("this group's sounds"),
  axes: [
    ['editor-mix-group-fluc', 'Volume drift', 'Only ever dips below the current level', "Every sound drifts separately, so they don't move together"],
    ['editor-mix-group-flucpitch', 'Pitch drift', 'Small shifts read as a gentle wobble', 'Always on for pitch'],
    ['editor-mix-group-flucpan', 'Pan drift', 'The whole group wanders together', 'Every sound wanders separately']
  ]
}
const PRESET = {
  note: 'Slow, random drift on the whole mix: weather rolling through. Applies live in the Mixer and is baked into exports.',
  hint: MIX_HINT('the whole mix'),
  axes: [['editor-mix-preset-fluc', 'Volume drift', 'Only ever dips below the current level']]
}
// Group and Preset axes, read by layout.js for the header summaries.
export const SCOPE_DRIFT = { group: GROUP, preset: PRESET }
export const DRIFT_AXES = SOUND.axes
export const SOUND_DRIFT_NOTE = SOUND.note

function SwitchRow({ id, title, sub, checked, disabled }) {
  return (
    <label className="rx-srow">
      <span className="rx-sl">
        <span>{title}</span>
        <small>{sub}</small>
      </span>
      <input id={id} type="checkbox" aria-label={title} defaultChecked={checked} disabled={disabled} />
    </label>
  )
}

function Axis({ idp, title, sub, perSoundSub, locked }) {
  return (
    <div className="rx-axis rx-drift-axis">
      <SwitchRow id={`${idp}-enabled`} title={title} sub={sub} />
      <div className="rx-axb">
        <canvas id={`${idp}-bar`} className="editor-fluctuation-bar" title="Drag the circles. Double-click one to reset it." />
        {perSoundSub && <SwitchRow id={`${idp}-persound`} title="Each sound on its own" sub={perSoundSub} checked={locked} disabled={locked} />}
        <div className="rx-trow">
          <span>Change every</span>
          <input id={`${idp}-changemin`} className="editor-fluctuation-num" type="number" min="0.5" max="300" step="0.5" defaultValue="6" />
          <span>to</span>
          <input id={`${idp}-changemax`} className="editor-fluctuation-num" type="number" min="0.5" max="300" step="0.5" defaultValue="14" />
          <span>s</span>
        </div>
        <div className="rx-trow">
          <span>Transition</span>
          <input id={`${idp}-transition`} className="editor-fluctuation-num" type="number" min="0" max="120" step="0.5" defaultValue="8" />
          <span>s</span>
        </div>
        <SwitchRow id={`${idp}-fullrandom`} title="Fully random" sub="Ignore the circles and roam the whole range" />
        <SwitchRow id={`${idp}-bias`} title="Bias" sub="The middle circle wins most of the time" checked />
      </div>
    </div>
  )
}

function Drift({ scope }) {
  const cfg = scope === 'sound' ? SOUND : scope === 'group' ? GROUP : PRESET
  return (
    <div id={cfg.id} className="editor-fluctuation">
      <p className="rx-hint rx-hint-l" title={cfg.hint}>
        {cfg.note}
      </p>
      {scope === 'sound' && (
        <>
          <p id="editor-fluc-group-note" className="hidden rx-hint rx-hint-l" />
          <p id="editor-fluctuation-saved-note" className="hidden rx-hint rx-hint-l">
            Drift only plays in the <strong>Live edit</strong> preview — the <strong>Saved audio</strong> preview is the baked clip, which never contains it. Switch the preview toggle to Live edit to hear it.
          </p>
        </>
      )}
      {cfg.axes.map(([idp, title, sub, perSoundSub]) => (
        <Axis key={idp} idp={idp} title={title} sub={sub} perSoundSub={perSoundSub} locked={idp.endsWith('flucpitch')} />
      ))}
    </div>
  )
}

/**
 * Renders the drift sections into their host boxes. Call once, before
 * RemixTab looks its elements up.
 * @param {{ sound: HTMLElement, group: HTMLElement, preset: HTMLElement }} hosts
 */
export function mountDrift(hosts) {
  for (const [scope, host] of Object.entries(hosts)) flushSync(() => createRoot(host).render(<Drift scope={scope} />))
}
