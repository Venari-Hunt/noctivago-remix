// Which marker action a key press asks for. Pure: the tab does the work.
// `typing` is true when focus is in a text field; `onSpectral` when the
// Spectrum canvas is the target (Delete there belongs to the repair box).
export function markerKeyAction(evt, { mode, typing, hasSelected, onSpectral }) {
  if (mode !== 'sound' || typing) return null
  if (evt.ctrlKey && !evt.shiftKey && !evt.altKey && (evt.key === 'm' || evt.key === 'M')) return 'add'
  if (evt.key === 'Delete' && !onSpectral && hasSelected) return 'delete'
  return null
}
