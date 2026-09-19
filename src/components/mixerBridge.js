// Asks the Mixer (over window events) for its live analyser and status.

// Cross-plugin/core bridge for the live spectrogram in Preset/Group mode -
// see tabs/mixer/index.js's matching `noctivago:request-analyser` listener
// for why this is a synchronous request/response over a window CustomEvent
// rather than an IPC call: a real AnalyserNode reference is safe to hand
// back here since plugin code and that module run in the same JS realm.
// Returns null when the preset/group being edited isn't the one actually
// loaded/playing in the Mixer right now (nothing to visualize).
export function requestAnalyser(kind, presetId, groupId) {
  const detail = { kind, presetId, groupId, node: null }
  window.dispatchEvent(new CustomEvent('noctivago:request-analyser', { detail }))
  return detail.node
}

// Same synchronous request/response shape as requestAnalyser - lets
// Preset/Group mode's Play/Pause icon and Group mode's Solo button reflect
// real Mixer state (is this preset actually the one loaded, is anything
// playing, is a group currently soloed) without a direct reference into
// tabs/mixer/index.js.
export function requestMixerStatus() {
  const detail = { activePresetId: null, isPlaying: false, soloedGroupId: null }
  window.dispatchEvent(new CustomEvent('noctivago:request-mixer-status', { detail }))
  return detail
}
