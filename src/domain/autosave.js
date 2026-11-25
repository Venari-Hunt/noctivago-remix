// Idle-debounced autosave timer. The tab passes the checks and the save call;
// this owns only the timer and the retry while a save is in flight.
export function createAutosave({ idleMs, canSchedule, canRun, isBusy, save, onError }) {
  let timer = null
  const run = async () => {
    if (!canRun()) return
    if (isBusy()) {
      // A save is mid-render: try again shortly instead of overlapping it.
      timer = setTimeout(run, idleMs)
      return
    }
    try {
      await save()
    } catch (err) {
      onError(err)
    }
  }
  return {
    schedule() {
      if (!canSchedule()) return
      clearTimeout(timer)
      timer = setTimeout(run, idleMs)
    },
    cancel() {
      clearTimeout(timer)
    },
    run
  }
}
