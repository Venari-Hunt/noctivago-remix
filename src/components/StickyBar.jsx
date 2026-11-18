// Sticky bar (rebuild plan step 7): the controls the shared #tab-sticky-bar
// holds, as the final markup. Renders once straight into the bar (so the bar's
// direct children stay what they were); layout.js arrangeBar() then moves the
// player (Play, S, Loop, time, progress, volumes, Live edit), the edit actions
// (Undo, Redo, Cancel, Save as copy, Save) and the group actions into the
// studio panes, and drops the emptied shells.
//
// Inputs are uncontrolled: RemixTab reads and writes them by id (the progress
// drag, volume, mute and time readout included), so there is no second copy of
// the values. React never renders this tree a second time.
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { icon, PLAY_ICON_SVG, VOLUME_ICON_SVG } from './icons.js'

const html = (svg) => ({ __html: svg })

function StickyBar({ previewVolume }) {
  return (
    <>
      <div className="rx-bar">
        <div id="rx-bar-left" className="rx-bar-l" />
        <div id="rx-bar-center" className="rx-bar-c" />
        <div className="rx-bar-r">
          <div id="editor-sticky-sound-controls" className="editor-sticky-mode-group">
            <button id="editor-undo" className="rx-i" type="button" title="Undo (Ctrl+Z)" aria-label="Undo" disabled dangerouslySetInnerHTML={html(icon('undo-2'))} />
            <button id="editor-redo" className="rx-i" type="button" title="Redo (Ctrl+Shift+Z)" aria-label="Redo" disabled dangerouslySetInnerHTML={html(icon('redo-2'))} />
            <button id="editor-cancel" className="rx-b rx-ghost" type="button" title="Discard every change made since this sound was opened in Remix">
              Cancel
            </button>
            <button
              id="editor-save-as-copy"
              className="rx-b"
              type="button"
              title="Save a new sound with this one's trim and every setting, without touching this one"
              dangerouslySetInnerHTML={html(`${icon('copy')}<span>Save as copy</span>`)}
            />
            <button id="editor-save" className="rx-b rx-pri editor-sticky-save" type="button" dangerouslySetInnerHTML={html(`${icon('save')}<span id="editor-save-label">Save</span>`)} />
          </div>
          <div id="editor-sticky-mix-controls" className="editor-sticky-mode-group hidden">
            <button id="editor-mix-play-pause" className="rx-i" type="button" title="Play" aria-label="Play" dangerouslySetInnerHTML={html(PLAY_ICON_SVG)} />
            <span id="editor-mix-status" className="editor-sticky-time rx-num" />
            <button id="editor-mix-save" className="rx-b rx-pri editor-sticky-save" type="button" dangerouslySetInnerHTML={html(`${icon('save')}<span>Save</span>`)} />
          </div>
          <div id="rx-group-actions" className="rx-group-actions">
            <button id="editor-mix-solo-group" className="rx-i editor-sticky-solo hidden" type="button" title="Solo group" aria-label="Solo group">
              S
            </button>
            <span
              className="rx-i rx-copy-wrap"
              title="Copy this group to another preset"
              dangerouslySetInnerHTML={html(
                `${icon('copy')}<select id="editor-mix-copy-group-to" class="hidden" aria-label="Copy this group to another preset" title="Copy this group's name, filters/EQ and members into another preset - it's governed entirely by whichever preset it ends up in from then on"><option value="" selected disabled>Copy to preset…</option></select>`
              )}
            />
            <button id="editor-mix-delete-group" className="rx-i hidden" type="button" title="Delete group" aria-label="Delete group" dangerouslySetInnerHTML={html(icon('trash-2'))} />
          </div>
        </div>
      </div>
      <div id="rx-transport-src" hidden>
        <button id="editor-play-pause" className="rx-b rx-play" type="button" title="Play" aria-label="Preview" dangerouslySetInnerHTML={html(PLAY_ICON_SVG)} />
        <button
          id="editor-loop-toggle"
          className="rx-i editor-loop-icon-btn editor-loop-icon-btn-active"
          type="button"
          title="Loop preview"
          aria-label="Loop preview"
          aria-pressed="true"
          dangerouslySetInnerHTML={html(icon('repeat'))}
        />
        <button id="editor-sticky-solo" className="rx-i editor-sticky-solo" type="button" aria-label="Solo" title="Solo: mute every other sound already playing in the Mixer while you audition this one">
          S
        </button>
        <span id="editor-sticky-time" className="editor-sticky-time rx-num">
          0:00 / 0:00
        </span>
        <button id="editor-preview-mode-toggle" className="editor-preview-mode-toggle rx-live" type="button" disabled>
          Live edit
        </button>
        <button id="editor-sticky-mute" className="rx-i" type="button" title="Mute" dangerouslySetInnerHTML={html(VOLUME_ICON_SVG)} />
        <button id="editor-mix-mute" className="rx-i" type="button" title="Mute" aria-label="Mute" dangerouslySetInnerHTML={html(VOLUME_ICON_SVG)} />
        <input id="editor-mix-volume" type="range" min="0" max="1000" defaultValue="500" className="editor-sticky-volume rx-fader" title="Volume (the app's master volume)" aria-label="Volume" />
        <input
          id="editor-sticky-volume"
          type="range"
          min="0"
          max="100"
          defaultValue={Math.round(previewVolume * 100)}
          className="editor-sticky-volume rx-fader"
          title="Preview volume"
          aria-label="Preview volume"
        />
        <div id="editor-sticky-progress" className="editor-sticky-progress" title="Drag to seek">
          <div className="editor-sticky-progress-track">
            <div id="editor-sticky-progress-fill" className="editor-sticky-progress-fill" />
          </div>
          <div id="editor-sticky-progress-thumb" className="editor-sticky-progress-thumb" />
        </div>
      </div>
    </>
  )
}

/**
 * Renders the sticky bar's controls into `container` (the shared
 * #tab-sticky-bar). Call once, before RemixTab looks its elements up.
 * @param {HTMLElement} container
 * @param {{previewVolume: number}} opts previewVolume is 0..1
 */
export function mountStickyBar(container, { previewVolume }) {
  flushSync(() => createRoot(container).render(<StickyBar previewVolume={previewVolume} />))
}
