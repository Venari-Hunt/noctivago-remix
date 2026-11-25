import { icon } from './icons.js'

const html = (__html) => ({ __html })

/**
 * The settings column's shell: heading and the small-window close button.
 * layout.js mounts the accordions (Accordion.jsx) after them. One per mode
 * (Sound, Group, Preset); styles.css "Small windows" slides it in below 860.
 */
export function SettingsSide() {
  return (
    <aside className="rx-side" aria-label="Settings">
      <h3 className="rx-side-h">Settings</h3>
      <button className="rx-i rx-ib rx-side-hide rx-xs-only" type="button" title="Hide settings" aria-label="Hide settings" dangerouslySetInnerHTML={html(icon('x'))} />
    </aside>
  )
}
