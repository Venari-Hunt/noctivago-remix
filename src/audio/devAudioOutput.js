// Dev-only convenience, requested directly: route dev-mode audio output to
// the owner's headphone-monitor-capable mic (shows up as a real Windows
// playback device) instead of the PC's actual speakers, since dev testing
// was audibly disturbing the household. Matches by device *label* rather
// than a hardcoded deviceId - an id is opaque and can drift across driver
// reinstalls, a label match keeps this working without edits if that ever
// happens. Never runs in a packaged build (mirrors the devWindowPosition()/
// dev-badge pattern already used for other dev-only conveniences), and is
// best-effort throughout - any failure (device unplugged, API unsupported,
// enumeration denied) silently leaves output on the system default rather
// than breaking real playback. Duplicated from core's own copy - this
// plugin can't import files outside its own directory, same reason
// AudioEngine.js/util/time.js are already duplicated here.
const DEV_OUTPUT_LABEL_MATCH = /yeti/i

export async function routeDevAudioOutput(...sinks) {
  try {
    if (await window.noctivago.isPackaged()) return
    const devices = await navigator.mediaDevices.enumerateDevices()
    const target = devices.find((d) => d.kind === 'audiooutput' && DEV_OUTPUT_LABEL_MATCH.test(d.label))
    if (!target) return
    await Promise.all(sinks.map((sink) => sink.setSinkId?.(target.deviceId).catch(() => {})))
  } catch {
    // Best-effort dev convenience only - see comment above.
  }
}
