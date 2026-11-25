import { stepHighlight, enterPick } from '../domain/pickerList.js'

// Wires the sound search box. c: openPicker, closePicker, filteredPickerSounds, renderPickerOptions, selectPickerSound, setQuery(text), getHighlight(), setHighlight(i).
export function wirePickerControls(els, c) {
  els.soundSearch.addEventListener('focus', () => c.openPicker())

  els.soundSearch.addEventListener('input', () => {
    c.setQuery(els.soundSearch.value)
    c.setHighlight(-1)
    c.openPicker()
  })

  els.soundSearch.addEventListener('keydown', (evt) => {
    const options = c.filteredPickerSounds()
    if (evt.key === 'ArrowDown') {
      evt.preventDefault()
      if (options.length === 0) return
      c.setHighlight(stepHighlight(c.getHighlight(), options.length, 1))
      c.renderPickerOptions()
    } else if (evt.key === 'ArrowUp') {
      evt.preventDefault()
      if (options.length === 0) return
      c.setHighlight(stepHighlight(c.getHighlight(), options.length, -1))
      c.renderPickerOptions()
    } else if (evt.key === 'Enter') {
      evt.preventDefault()
      // Defaults to the first result when nothing's been arrow-navigated
      // yet - requested directly: typing a precise search and hitting
      // Enter shouldn't need an extra arrow-down first, since a precise
      // query usually narrows straight down to the one sound you meant.
      const picked = enterPick(options, c.getHighlight())
      if (picked) c.selectPickerSound(picked.id)
    } else if (evt.key === 'Escape') {
      c.closePicker()
      els.soundSearch.blur()
    }
  })

  // The option list's own mousedown handlers call preventDefault() (see
  // renderPickerOptions), which stops the input from ever losing focus on
  // an option click - so a plain blur here always means the user actually
  // clicked/tabbed away, never a false positive from picking an option.
  els.soundSearch.addEventListener('blur', () => c.closePicker())
}
