import { defaultEqBands } from '../domain/mixSettings.js'

// Wires the parametric EQ fields and buttons. eqEditor is the EQ editor controller. c: applyEqControls, applyEqFieldsToSelectedBand, updateEqFieldsFromSelection, switchEqCompareView, revertEqToSaved.
export function wireEqControls(els, eqEditor, c) {
  // 'input' (fires live, on every change) not 'change' (fires only on
  // blur/Enter) - matches every other numeric field in this app (Scatter
  // gap min/max, the core filter sliders). BUG FIX: these three were the
  // one place still using 'change', which meant the app-wide number-box
  // stepper (hover+scroll/arrow keys, see numberBoxStepper.js - it
  // dispatches 'input') silently never reached these fields at all -
  // adjusting Freq/Gain/Q via scroll or arrow keys updated the input's
  // raw displayed value but never touched the actual band, the node's
  // position on the graph, or the live audio, exactly matching a direct
  // bug report ("raising the frequency by the number doesn't change the
  // node's position and doesn't affect the audio").
  els.eqType.addEventListener('change', () => c.applyEqFieldsToSelectedBand())
  els.eqSlope.addEventListener('change', () => c.applyEqFieldsToSelectedBand())
  els.eqFreq.addEventListener('input', () => c.applyEqFieldsToSelectedBand())
  els.eqGain.addEventListener('input', () => c.applyEqFieldsToSelectedBand())
  els.eqQ.addEventListener('input', () => c.applyEqFieldsToSelectedBand())
  els.eqReset.addEventListener('click', () => {
    eqEditor.load(defaultEqBands())
    c.updateEqFieldsFromSelection()
    c.applyEqControls()
  })

  els.eqAddBand.addEventListener('click', () => {
    eqEditor.addBand()
    c.updateEqFieldsFromSelection()
    c.applyEqControls()
  })
  els.eqRemoveBand.addEventListener('click', () => {
    eqEditor.removeSelectedBand()
    c.updateEqFieldsFromSelection()
    c.applyEqControls()
  })
  // Registers the trash button as a drag-and-drop target too - dragging a
  // node onto it deletes it, same as clicking it with a band selected
  // (see EqEditor.js's pointerUp).
  eqEditor.setTrashDropTarget(els.eqRemoveBand)

  // Zoom in/out (also reachable via mouse wheel over empty graph space)
  // and Invert - both ported from Audacity's Filter Curve EQ. Invert
  // mutates every band's gain, so it needs the same field-refresh +
  // applyEqControls() pair every other band-mutating button already uses;
  // zoom is purely a view change, no band data touched, no refresh needed.
  els.eqZoomIn.addEventListener('click', () => eqEditor.zoomIn())
  els.eqZoomOut.addEventListener('click', () => eqEditor.zoomOut())
  els.eqInvert.addEventListener('click', () => {
    eqEditor.invertBands()
    c.updateEqFieldsFromSelection()
    c.applyEqControls()
  })

  els.eqCompareA.addEventListener('click', () => c.switchEqCompareView('A'))
  els.eqCompareB.addEventListener('click', () => c.switchEqCompareView('B'))
  els.eqRevertBanner.addEventListener('click', () => c.revertEqToSaved())

  els.eqMute.addEventListener('click', () => {
    const idx = eqEditor.getSelectedIndex()
    const band = eqEditor.getSlots()[idx]
    if (!band) return
    eqEditor.setSelectedBand({ muted: !band.muted })
    c.applyEqControls()
  })

  // Toggle: clicking Solo on the already-soloed band un-solos it (back to
  // "every band plays normally"), clicking it on a different band moves
  // solo there instead - only one band can be soloed at a time.
  els.eqSolo.addEventListener('click', () => {
    const idx = eqEditor.getSelectedIndex()
    if (idx === -1) return
    const current = eqEditor.getSoloIndex()
    eqEditor.setSoloIndex(current === idx ? -1 : idx)
    c.applyEqControls()
  })
}
