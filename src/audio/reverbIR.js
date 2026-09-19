// Synthetic reverb impulse response - see src/renderer/audio/reverbIR.js for
// the full rationale (exponentially-decaying noise, procedural not sampled,
// matched in character with src/main/ffmpeg/reverbIR.js's ffmpeg-side
// equivalent). Duplicated here per this plugin's usual "bundle your own
// dependencies" convention - can't import outside its own directory.
const REVERB_DECAY_EXPONENT = 3 // exp(-3) ≈ -26dB by the tail's own end

export function createReverbImpulse(audioContext, sizeSeconds) {
  const length = Math.max(1, Math.round(audioContext.sampleRate * sizeSeconds))
  const buffer = audioContext.createBuffer(2, length, audioContext.sampleRate)
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch)
    for (let i = 0; i < length; i++) {
      const envelope = Math.exp(-REVERB_DECAY_EXPONENT * (i / length))
      data[i] = (Math.random() * 2 - 1) * envelope
    }
  }
  return buffer
}
