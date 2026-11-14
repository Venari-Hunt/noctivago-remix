// Q value to hand a BiquadFilterNode so it matches the saved audio.
// The saved render (ffmpeg, width_type=q) reads every band's Q as a real Q.
// Web Audio does too for peaking/shelf/bandpass/notch, but for lowpass and
// highpass it reads Q as resonance in dB (spec: "the Q value is in dB"), so a
// raw Q of 0.707 got +0.7 dB of bump instead of a flat Butterworth, and a Q of
// 10 got +10 dB where the render has +20 dB. Convert real Q to dB for those two.
const DB_Q_TYPES = ['lowpass', 'highpass']

export function biquadQ(type, q) {
  const real = Number.isFinite(q) && q > 0 ? q : Math.SQRT1_2
  return DB_Q_TYPES.includes(type) ? 20 * Math.log10(real) : real
}
