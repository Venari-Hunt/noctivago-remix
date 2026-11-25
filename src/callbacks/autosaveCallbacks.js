import { AUTOSAVE_IDLE_MS } from '../domain/mixSettings.js'

// What the autosave timer asks the tab (createAutosave options).
export function autosaveCallbacks(tab) {
  return {
    idleMs: AUTOSAVE_IDLE_MS,
    canSchedule: () => !tab._restoringHistory && !!tab.currentEntry,
    canRun: () => !!tab.currentEntry && tab.eqCompareViewing !== 'B' && !tab.compare.isSaved && tab.hasUnsavedChanges(),
    isBusy: () => tab.saveCtl.isSaving(),
    save: () => tab.save({ trigger: 'auto' }),
    onError: (err) => console.error('Editor: autosave failed', err)
  }
}
