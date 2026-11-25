// What the Save row shows for the current view. Pure: the tab applies the
// result to the buttons (the Save label itself goes through setSaveLabel so
// the morph states keep working). `isDirty` is lazy: only the normal view
// needs it.
export function saveButtonState({ compareSaved, eqViewingB, isDirty }) {
  if (compareSaved) {
    // Last saved on screen: nothing to save, copy, cancel, undo or redo.
    return { view: 'saved', saveDisabled: true, label: 'Viewing last saved', saveAsCopyDisabled: true, cancelDisabled: true, undoDisabled: true, redoDisabled: true }
  }
  if (eqViewingB) {
    return { view: 'eqB', saveDisabled: true, label: 'Viewing saved mix', saveAsCopyDisabled: true }
  }
  const dirty = !!isDirty()
  return { view: 'now', saveDisabled: !dirty, label: dirty ? 'Save' : 'Nothing to save', saveAsCopyDisabled: false }
}
