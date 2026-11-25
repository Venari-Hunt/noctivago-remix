import { lookupEls } from './lookup.js'

// Selectors for the schedule panel's elements (ids unchanged; CSS and e2e depend on them).
export const SCHEDULE_SELECTORS = {
  scheduleSection: '#editor-schedule-section',
  scheduleTypeTimes: '#editor-schedule-type-times',
  scheduleTypeInterval: '#editor-schedule-type-interval',
  scheduleTimesRow: '#editor-schedule-times-row',
  scheduleTimes: '#editor-schedule-times',
  scheduleIntervalRow: '#editor-schedule-interval-row',
  scheduleInterval: '#editor-schedule-interval',
  schedulePitchBar: '#editor-schedule-pitch-bar',
  schedulePitchFullyRandom: '#editor-schedule-pitch-fully-random',
  schedulePitchBiasEnabled: '#editor-schedule-pitch-bias-enabled',
  scheduleVolumeBar: '#editor-schedule-volume-bar',
  scheduleVolumeFullyRandom: '#editor-schedule-volume-fully-random',
  scheduleVolumeBiasEnabled: '#editor-schedule-volume-bias-enabled',
  schedulePanBar: '#editor-schedule-pan-bar',
  schedulePanFullyRandom: '#editor-schedule-pan-fully-random',
  schedulePanBiasEnabled: '#editor-schedule-pan-bias-enabled',
  scheduleGroupNote: '#editor-schedule-group-note',
  scheduleSpeedBar: '#editor-schedule-speed-bar',
  scheduleSpeedFullyRandom: '#editor-schedule-speed-fully-random',
  scheduleSpeedBiasEnabled: '#editor-schedule-speed-bias-enabled',
  scheduleFadeIn: '#editor-schedule-fade-in',
  scheduleFadeOut: '#editor-schedule-fade-out'
}

export function findScheduleEls(container) {
  return lookupEls(container, SCHEDULE_SELECTORS)
}
