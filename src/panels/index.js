import { findPickerEls } from './pickerPanel.js'
import { findTrimEls } from './trimPanel.js'
import { findPlayModeEls } from './playModePanel.js'
import { findSeamEls } from './seamPanel.js'
import { findShapeEls } from './shapePanel.js'
import { findScatterEls } from './scatterPanel.js'
import { findScheduleEls } from './schedulePanel.js'
import { findSpeedPitchEls } from './speedPitchPanel.js'
import { findFilterEls } from './filterPanel.js'
import { findFluctuationEls } from './fluctuationPanel.js'
import { findShellEls } from './shellPanel.js'
import { findModesEls } from './modesPanel.js'
import { findPresetMixEls } from './presetMixPanel.js'
import { findGroupMixEls } from './groupMixPanel.js'

// Every panel's elements in one object, the shape `mount` stores as `this.els`.
export function findAllEls(container) {
  return {
    ...findPickerEls(container),
    ...findTrimEls(container),
    ...findPlayModeEls(container),
    ...findSeamEls(container),
    ...findShapeEls(container),
    ...findScatterEls(container),
    ...findScheduleEls(container),
    ...findSpeedPitchEls(container),
    ...findFilterEls(container),
    ...findFluctuationEls(container),
    ...findShellEls(container),
    ...findModesEls(container),
    ...findPresetMixEls(container),
    ...findGroupMixEls(container)
  }
}
