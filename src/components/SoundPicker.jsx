// Sound picker (search box and dropdown list), as the final markup. Renders
// once into a host box; layout.js arrangeBar() moves .editor-picker into the
// library holder. The option list and search behavior stay in RemixTab, which
// reads both nodes by id. Uncontrolled; React never renders this twice.
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'

function SoundPicker() {
  return (
    <div className="editor-picker">
      <input id="editor-sound-search" type="text" className="editor-sound-search" placeholder="Select a sound to edit…" autoComplete="off" />
      <ul id="editor-sound-options" className="editor-sound-options hidden" />
    </div>
  )
}

/** @param {HTMLElement} host */
export function mountSoundPicker(host) {
  flushSync(() => createRoot(host).render(<SoundPicker />))
}
