// Now / Last saved view state. Pure: the tab does the DOM, EQ and control
// work; this only remembers which side is showing and the stashed "Now" state.
export function createCompare() {
  let viewing = 'now'
  let stash = null
  return {
    get viewing() { return viewing },
    get stash() { return stash },
    get isSaved() { return viewing === 'saved' },
    // Show the saved side, keeping the current edits aside.
    enterSaved(state) {
      stash = state
      viewing = 'saved'
    },
    // Back to Now; returns the stashed state (read `stash` first to apply it while still on the saved side).
    leave() {
      const out = stash
      stash = null
      viewing = 'now'
      return out
    }
  }
}
