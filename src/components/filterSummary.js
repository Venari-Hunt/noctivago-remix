// Text helpers for the filter settings, shared by FilterControls.jsx and
// the accordion heads (plain JS so the tests can import it).

export function formatPan(pan) {
  return pan === 0 ? 'Center' : `${pan < 0 ? 'L' : 'R'} ${Math.round(Math.abs(pan) * 100)}`
}

// Accordion head summaries ("Off", "High-pass · +3 dB"), read from the values.
export function filterSummaries(v) {
  const tone = [
    v.highpassHz > 0 && 'High-pass',
    v.lowpassHz < 20000 && 'Low-pass',
    v.gainDb !== 0 && `${v.gainDb > 0 ? '+' : ''}${v.gainDb} dB`,
    v.pan !== 0 && formatPan(v.pan)
  ].filter(Boolean)
  const gate = v.gateThresholdDb > -80 && v.gateRangeDb > 0
  const clean = [gate && 'Gate', v.denoiseEnabled && 'Noise reduction'].filter(Boolean)
  const space = [v.echoDelayMs > 0 && v.echoDecay > 0 && 'Echo', v.reverbSizeMs > 0 && v.reverbMix > 0 && 'Reverb'].filter(Boolean)
  const join = (list) => (list.length ? list.join(' · ') : 'Off')
  return { tone: join(tone), clean: join(clean), space: join(space) }
}
