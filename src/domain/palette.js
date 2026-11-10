// Canvas colors, mirroring the app's theme tokens in its main.css (the
// Desktop 2.0 look: graphite, one amber accent). Canvases can't read CSS
// variables for free, so every canvas draws from here instead.
export const PALETTE = {
  accent: '#e0b84c',
  text: '#ece9e2',
  textDim: '#a3a09a',
  surface: '#0f0f11',
  border: '#2d2d33',
  danger: '#ff6b6b',
  wave: '#6a6a72'
}

// '#rrggbb' + alpha -> 'rgba(r, g, b, a)'
export function withAlpha(hex, alpha) {
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
}
