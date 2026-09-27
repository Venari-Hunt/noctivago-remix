// Canvas colors, mirroring the app's theme tokens in its main.css (OLED
// black, one yellow accent). Canvases can't read CSS variables for free, and
// the old hardcoded blue palette clashed with the app, so every canvas draws
// from here instead.
export const PALETTE = {
  accent: '#ffc933',
  text: '#f5f5f5',
  textDim: '#8f8f8f',
  surface: '#0d0d0d',
  border: '#3a3a3a',
  danger: '#ff6b6b'
}

// '#rrggbb' + alpha -> 'rgba(r, g, b, a)'
export function withAlpha(hex, alpha) {
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
}
