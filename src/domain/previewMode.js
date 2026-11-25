// Words and flags for the Live edit / Saved audio toggle. Pure: the tab owns
// the engines and applies this to the button.
export function previewModeToggleState({ mode, eligible, stale }) {
  const saved = mode === 'saved'
  const isStale = saved && !!stale
  const title = eligible
    ? saved
      ? isStale
        ? 'Hearing the last saved/baked audio - edited since then, autosave will refresh it shortly. Click to switch to the live editable preview'
        : 'Hearing the actual saved/baked audio - click to switch back to the live editable preview'
      : 'Hearing the live editable preview (Reverse on a sound over 10 minutes is only heard after saving) - click to hear the actual saved audio instead'
    : 'Click to render and hear the actual saved audio'
  return { text: saved ? 'Saved audio' : 'Live edit', active: saved, stale: isStale, title }
}

// True when the toggle must fall back to live: Saved audio is on but there is
// no usable bake and one is not being rendered right now.
export function mustFallBackToLive({ mode, eligible, rebaking }) {
  return !eligible && mode === 'saved' && !rebaking
}
