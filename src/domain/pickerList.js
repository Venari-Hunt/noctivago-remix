// Pure rules for the sound picker list; the tab renders and selects.
export function filterPickerSounds(sounds, query) {
  const q = (query ?? '').trim().toLowerCase()
  if (!q) return sounds
  return sounds.filter((s) => s.name.toLowerCase().includes(q))
}

// Arrow keys wrap around (the same math the picker always used).
export function stepHighlight(index, length, direction) {
  if (length === 0) return index
  return direction > 0 ? (index + 1) % length : (index - 1 + length) % length
}

// Enter picks the highlighted row, or the first result when none is.
export function enterPick(options, index) {
  return options[index] ?? options[0]
}
