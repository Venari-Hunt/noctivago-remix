// Undo/redo stack for one editing session. Pure: the tab owns the debounce
// timer and pushes states back onto the controls; this only keeps the list.
export function createHistory({ limit = 100 } = {}) {
  let stack = []
  let index = -1
  return {
    // Replace the stack: empty, or seeded with one state (a fresh load).
    reset(state) {
      stack = state === undefined ? [] : [state]
      index = stack.length - 1
    },
    // Record a point. False when it equals the current one (nothing changed).
    // A fresh edit after undoing drops the redo branch.
    push(state) {
      if (index >= 0 && JSON.stringify(stack[index]) === JSON.stringify(state)) return false
      stack = stack.slice(0, index + 1)
      stack.push(state)
      if (stack.length > limit) stack.shift()
      index = stack.length - 1
      return true
    },
    // The state to apply, or null at the end of the stack.
    undo() {
      if (index <= 0) return null
      index -= 1
      return stack[index]
    },
    redo() {
      if (index >= stack.length - 1) return null
      index += 1
      return stack[index]
    },
    canUndo: () => index > 0,
    canRedo: () => index < stack.length - 1,
    get length() { return stack.length },
    get index() { return index }
  }
}
