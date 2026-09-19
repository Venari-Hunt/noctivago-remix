// Where each part of a baked loop clip comes from in the source file -
// mirrors src/main/ffmpeg/loopClip.js's crossfadeSegments (the plugin can't
// import from src/, keep the two in sync):
//
//   clip [0, blendStart)          = source [mid, loopEnd - fade)   (B body)
//   clip [blendStart, blendEnd)   = tail [loopEnd - fade, loopEnd)
//                                   crossfaded into head [loopStart, loopStart + fade)
//   clip [blendEnd, length)       = source [loopStart + fade, mid)  (A body)
//
// A fade of 0 is a plain trim: clip t = source loopStart + t.
export function loopLayout(loopStart, loopEnd, fade) {
  const trim = Math.max(0, loopEnd - loopStart)
  const f = Math.min(Math.max(fade || 0, 0), trim / 4)
  const mid = (loopStart + loopEnd) / 2
  const blendStart = f > 0 ? trim / 2 - f : 0
  return { loopStart, loopEnd, fade: f, mid, blendStart, blendEnd: blendStart + f, length: trim - f }
}

// Source time for a clip time. Inside the blend this reports the tail (the
// outgoing side), which continues the B body on the waveform.
export function clipToSource(layout, t) {
  const { loopStart, fade, mid, blendEnd } = layout
  const clipTime = Math.min(Math.max(t, 0), layout.length)
  if (fade <= 0) return loopStart + clipTime
  if (clipTime < blendEnd) return mid + clipTime
  return loopStart + fade + (clipTime - blendEnd)
}

// Clip time for a source time inside the trim. The head [loopStart,
// loopStart + fade) only plays inside the blend.
export function sourceToClip(layout, s) {
  const { loopStart, loopEnd, fade, mid, blendStart, blendEnd } = layout
  const t = Math.min(Math.max(s, loopStart), loopEnd)
  let clipTime
  if (fade <= 0) clipTime = t - loopStart
  else if (t >= mid) clipTime = t - mid
  else if (t < loopStart + fade) clipTime = blendStart + (t - loopStart)
  else clipTime = blendEnd + (t - loopStart - fade)
  return Math.min(Math.max(clipTime, 0), layout.length)
}
