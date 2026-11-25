import { lookupEls } from './lookup.js'

// Selectors for the presetMix panel's elements (ids unchanged; CSS and e2e depend on them).
export const PRESETMIX_SELECTORS = {
  mixPresetControls: '#editor-mix-preset-controls',
  mixPresetHighpass: '#editor-mix-preset-highpass',
  mixPresetHighpassValue: '#editor-mix-preset-highpass-value',
  mixPresetLowpass: '#editor-mix-preset-lowpass',
  mixPresetLowpassValue: '#editor-mix-preset-lowpass-value',
  mixPresetGain: '#editor-mix-preset-gain',
  mixPresetGainValue: '#editor-mix-preset-gain-value',
  mixPresetEchoDelay: '#editor-mix-preset-echo-delay',
  mixPresetEchoDelayValue: '#editor-mix-preset-echo-delay-value',
  mixPresetEchoDecay: '#editor-mix-preset-echo-decay',
  mixPresetEchoDecayValue: '#editor-mix-preset-echo-decay-value',
  mixPresetReverbSize: '#editor-mix-preset-reverb-size',
  mixPresetReverbSizeValue: '#editor-mix-preset-reverb-size-value',
  mixPresetReverbMix: '#editor-mix-preset-reverb-mix',
  mixPresetReverbMixValue: '#editor-mix-preset-reverb-mix-value',
  mixPresetFadeIn: '#editor-mix-preset-fadein',
  mixPresetWaveform: '#editor-mix-preset-waveform',
  mixPresetResetFilters: '#editor-mix-preset-reset-filters',
  mixPresetEffectButtons: { all: '[data-mix-preset-effect]' },
  mixPresetHint: '#editor-mix-preset-hint',
  mixPresetFlucEnabled: '#editor-mix-preset-fluc-enabled',
  mixPresetFlucBias: '#editor-mix-preset-fluc-bias',
  mixPresetFlucBar: '#editor-mix-preset-fluc-bar',
  mixPresetFlucChangeMin: '#editor-mix-preset-fluc-changemin',
  mixPresetFlucChangeMax: '#editor-mix-preset-fluc-changemax',
  mixPresetFlucTransition: '#editor-mix-preset-fluc-transition',
  mixPresetFlucFullRandom: '#editor-mix-preset-fluc-fullrandom'
}

export function findPresetMixEls(container) {
  return lookupEls(container, PRESETMIX_SELECTORS)
}
