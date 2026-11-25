import { lookupEls } from './lookup.js'

// Selectors for the speedPitch panel's elements (ids unchanged; CSS and e2e depend on them).
export const SPEEDPITCH_SELECTORS = {
  speed: '#editor-speed',
  speedValue: '#editor-speed-value',
  pitch: '#editor-pitch',
  pitchValue: '#editor-pitch-value',
  reverse: '#editor-reverse',
  reverseStatus: '#editor-reverse-status',
  doppler: '#editor-doppler',
  dopplerHint: '#editor-doppler-hint',
  dopplerOptions: '#editor-doppler-options',
  dopplerIntensity: '#editor-doppler-intensity',
  dopplerIntensityValue: '#editor-doppler-intensity-value',
  dopplerSharpness: '#editor-doppler-sharpness',
  dopplerSharpnessValue: '#editor-doppler-sharpness-value',
  dopplerReversed: '#editor-doppler-reversed'
}

export function findSpeedPitchEls(container) {
  return lookupEls(container, SPEEDPITCH_SELECTORS)
}
