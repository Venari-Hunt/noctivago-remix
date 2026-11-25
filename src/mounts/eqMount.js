import { createEqEditorController } from '../components/EqEditor.js'
import { createEqTarget, eqElements } from '../components/useEqTarget.js'

// Sound-mode EQ graph. c: applyEqControls, isSavedPreview, togglePreviewMode.
export function mountEqEditor(els, c, create = createEqEditorController) {
  const eqEditor = create(els.eqCanvas)
  eqEditor.onChange(() => c.applyEqControls())
  eqEditor.onNeedLive(() => {
    if (c.isSavedPreview()) c.togglePreviewMode()
  })
  // Double-click resets just the node's gain (its vertical position); Alt+click
  // is the fuller reset (gain 0, q 1, peaking, gentle slope). Both keep the
  // node's own frequency: there is no default to reset it back to.
  eqEditor.onDoubleClick((index) => {
    eqEditor.setSelectedIndex(index)
    eqEditor.setSelectedBand({ gainDb: 0 })
    c.applyEqControls()
  })
  eqEditor.onAltClick((index) => {
    eqEditor.setSelectedIndex(index)
    eqEditor.setSelectedBand({ gainDb: 0, q: 1, type: 'peaking', slope: 'gentle' })
    c.applyEqControls()
  })
  return eqEditor
}

// Preset and Group mode EQ: the same EqEditor module as Sound mode, one target each.
// c: getPresetSavedBands, getGroupSavedBands, onPresetApply(bands), onGroupApply(bands).
export function mountMixEqTargets(root, c, make = createEqTarget, elementsFor = eqElements) {
  const presetEqTarget = make({
    els: elementsFor(root, 'editor-mix-preset-eq'),
    getSavedBands: c.getPresetSavedBands,
    onApply: c.onPresetApply
  })
  const groupEqTarget = make({
    els: elementsFor(root, 'editor-mix-group-eq'),
    getSavedBands: c.getGroupSavedBands,
    onApply: c.onGroupApply
  })
  return { presetEqTarget, groupEqTarget, presetEq: presetEqTarget.eq, groupEq: groupEqTarget.eq }
}
