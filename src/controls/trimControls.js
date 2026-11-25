// Wires the loop start/end, length and needle fields and Suggest loop. c: applyManualLoopPoints, applyManualLength, applyManualNeedle, suggestLoopPoint.
export function wireTrimControls(els, c) {
  els.startInput.addEventListener('change', () => c.applyManualLoopPoints())
  els.endInput.addEventListener('change', () => c.applyManualLoopPoints())
  els.lengthInput.addEventListener('change', () => c.applyManualLength())
  els.needleInput.addEventListener('change', () => c.applyManualNeedle())
  els.needleInput.addEventListener('input', () => els.needleInput.removeAttribute('aria-invalid'))
  els.suggestLoopBtn.addEventListener('click', () => c.suggestLoopPoint())
}
