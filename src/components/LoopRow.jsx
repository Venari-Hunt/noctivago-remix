// Loop actions row: Suggest a loop point and Listen to the seam, with the
// suggestion status line, as the final markup. Renders once into a host box;
// layout.js moves .editor-suggest-loop-row into the Loop body of the Playback
// accordion. RemixTab reads the buttons and status by id and layout.js wires
// #rx-open-seam. Uncontrolled; React never renders this twice.
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { icon } from './icons.js'

function LoopRow() {
  return (
    <div className="editor-suggest-loop-row">
      <div className="rx-srow1">
        <button
          id="editor-suggest-loop"
          className="rx-b"
          type="button"
          title="Analyze the file and propose a seamless loop region. You can still adjust Start/End afterward."
          dangerouslySetInnerHTML={{ __html: `${icon('sparkles')}<span>Suggest a loop point</span>` }}
        />
        <button id="rx-open-seam" className="rx-b" type="button" title="Open the Loop seam view" dangerouslySetInnerHTML={{ __html: `${icon('headphones')}<span>Listen to the seam</span>` }} />
      </div>
      <span id="editor-suggest-status" className="editor-suggest-status" />
    </div>
  )
}

/** @param {HTMLElement} host */
export function mountLoopRow(host) {
  flushSync(() => createRoot(host).render(<LoopRow />))
}
