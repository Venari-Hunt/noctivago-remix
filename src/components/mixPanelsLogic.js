// Plain rules for the Group and Preset panels (MixPanels.jsx): which filter
// sliders each card shows, in order, with the ranges and starting text the old
// markup carried. Tested in test/mixPanelsLogic.test.js.
const R = (key, label, min, max, step, value, initial, title) => ({ kind: 'range', key, label, min, max, step, value, initial, title })

const HIGHPASS = R('highpass', 'High-pass', 0, 2000, 10, 0, 'Off')
const LOWPASS = R('lowpass', 'Low-pass', 150, 20000, 50, 20000, 'Off')
const GAIN = R('gain', 'Gain', -24, 24, 1, 0, '0 dB')
const PAN = R('pan', 'Pan', -100, 100, 1, 0, 'C')
const ECHO = [R('echo-delay', 'Echo delay', 0, 1500, 10, 0, 'Off'), R('echo-decay', 'Echo decay', 0, 0.85, 0.01, 0, 'Off')]
const REVERB = [R('reverb-size', 'Reverb size', 0, 4000, 100, 0, 'Off'), R('reverb-mix', 'Reverb mix', 0, 1, 0.01, 0, 'Off')]
const OCCLUSION = R(
  'occlusion',
  'Occlusion',
  0,
  1,
  0.01,
  0,
  'Off',
  'Sounds like this group is behind a wall or door - pulls the lowpass down and pushes reverb up together, on top of whatever Lowpass/Reverb are already set above. Left edge = off.'
)
const FADE_IN = { kind: 'number', key: 'fadein', label: 'Fade in', min: 0, max: 60, step: 0.5, value: 0, note: 's — eases the whole mix up when the preset loads' }

export const FILTER_ROWS = {
  preset: [HIGHPASS, LOWPASS, GAIN, ...ECHO, ...REVERB, FADE_IN],
  group: [HIGHPASS, LOWPASS, GAIN, PAN, ...ECHO, ...REVERB, OCCLUSION]
}

const CHIPS = [
  ['muffled', 'Muffled'],
  ['phone', 'Over the Phone'],
  ['radio', 'On the Radio'],
  ['distant', 'Distant'],
  ['echo', 'Echo'],
  ['reverb', 'Reverb'],
  ['underwater', 'Underwater']
]
export const effectChips = () => CHIPS
