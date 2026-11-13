// Icons for the EQ band right-click menu. The mock has none for filter types, so
// each type is drawn as its own response curve (what Pro-Q and FL's EQ do): a
// 16 px stroke glyph that follows the menu text color.
const CURVES = {
  peaking: 'M1 11h3c2 0 2-7 4-7s2 7 4 7h3',
  lowshelf: 'M1 5h4c3 0 3 6 6 6h4',
  highshelf: 'M1 11h4c3 0 3-6 6-6h4',
  highpass: 'M1 13c4 0 5-8 9-8h5',
  lowpass: 'M1 5h5c4 0 5 8 9 8',
  bandpass: 'M1 13c3 0 4-9 7-9s4 9 7 9',
  notch: 'M1 5h3c2 0 2 8 4 8s2-8 4-8h3',
  'slope-gentle': 'M2 11L14 7',
  'slope-steep': 'M2 13L14 3'
}

export function eqMenuIcon(name) {
  const d = CURVES[name]
  if (!d) return ''
  return `<svg class="rx-icon rx-eq-curve" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`
}
