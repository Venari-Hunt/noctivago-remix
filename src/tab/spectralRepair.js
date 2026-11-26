// Spectral repair methods of the Remix tab. Each takes the tab.
import { formatHz, GOOD_NOISE_SEC, noiseBandFromShape } from '../domain/spectralLayout.js'
import { toolHint } from '../domain/repairBrush.js'

// --- Spectral repair ---
// The panel shows the trim only (that's all a bake reads). The spectrogram
// is refetched for a new trim once the drag settles.
export function syncSpectralView(tab) {
  if (!tab.spectralView || !tab.loopEditorController) return
  const id = tab.currentEntry?.id
  if (!id || typeof tab.api.audio.getSpectrogram !== 'function') return
  const { loopStart, loopEnd } = tab.loopEditorController.getLoopPoints()
  if (!(loopEnd > loopStart)) return
  // Hidden tab: asking now would fetch a 16 x 16 image stretched blurry over the canvas.
  if (!tab.spectralView.isShown()) return
  const want = tab.spectralView.requestSize()
  const trimKey = `${id}:${loopStart}:${loopEnd}`
  // Size buckets of 100 px: a small resize keeps the image, a big one (a bigger window) refetches it sharper.
  const key = `${trimKey}:${Math.round(want.columns / 100)}x${Math.round(want.rows / 100)}`
  if (key === tab._spectrogramKey) return
  const sameTrim = tab._spectrogramKey?.startsWith(`${trimKey}:`)
  tab._spectrogramKey = key
  tab.spectralView.setView(loopStart, loopEnd)
  if (!sameTrim) tab.spectralView.setSpectrogram(null, 'Reading the sound…')
  clearTimeout(tab._spectrogramTimer)
  tab._spectrogramTimer = setTimeout(async () => {
    let spec = null
    try {
      spec = await tab.api.audio.getSpectrogram(id, { windowStart: loopStart, windowEnd: loopEnd, ...want })
    } catch (err) {
      console.error('Editor: spectrogram fetch failed', err)
    }
    if (key !== tab._spectrogramKey) return
    tab.spectralView.setSpectrogram(spec, spec ? '' : "Couldn't read this sound")
  }, 250)
}

// Picks what a drag on the spectrogram does: 'select', 'box', 'lasso',
// 'brush' or 'noise' (the Noise sample band). The view tells back through
// onToolChange (also for the V R L B N keys), which syncs the buttons.
export function setSpectralTool(tab, tool) {
  tab.spectralView.setShape(tool)
  tab.syncSpectralTool()
}

// Keeps the tool buttons, the hint line and "Mark noise sample" in step with the tool.
export function syncSpectralTool(tab) {
  const now = tab.spectralView.getShape()
  for (const b of tab.els.spectralShape.querySelectorAll('[data-shape]')) b.setAttribute('aria-pressed', String(b.dataset.shape === now))
  tab.els.spectralHint.innerHTML = toolHint(now, tab.spectralView.getBrushRadius())
  tab.filterControls?.setMarkOn(now === 'noise')
}

// Draws the From/To fields as a band on the spectrogram and words the legend.
export function syncNoiseBand(tab) {
  if (!tab.spectralView || !tab.filterControls) return
  const v = tab.filterControls.getValues()
  tab.spectralView.setNoiseSample(v.denoiseSampleStartSec, v.denoiseSampleEndSec)
  const band = tab.spectralView.getNoiseSample()
  // The same band on the Trim waveform (drag it there to re-sample), unless
  // the Noise reduction card's "Show on waveform" is off.
  const sample = tab.filterControls.getShowSample() && v.denoiseSampleEndSec > v.denoiseSampleStartSec ? { startSec: v.denoiseSampleStartSec, endSec: v.denoiseSampleEndSec } : null
  tab.loopEditorController.setNoiseSample(sample)
  tab.els.spectralLegendNoise.classList.toggle('hidden', !band)
  if (band) {
    const length = band.endSec - band.startSec
    const state = !v.denoiseEnabled ? 'Noise reduction is off' : length < GOOD_NOISE_SEC ? 'short: 0.5 s or more works best' : 'learned'
    tab.els.spectralLegendNoiseText.textContent = `Noise sample ${band.startSec.toFixed(1)}–${band.endSec.toFixed(1)} s (${state})`
  }
}

// "Use shape N as noise sample": the shape's whole time range, every
// frequency in it (owner, 2026-11-21, option A).
export function useShapeAsNoiseSample(tab) {
  const band = noiseBandFromShape(tab.spectralView.getSelected())
  if (!band) return
  tab.filterControls.setValues({ denoiseSampleStartSec: band.startSec, denoiseSampleEndSec: band.endSec, denoiseEnabled: true })
  tab.applyFilterControls()
}

export function updateSpectralControls(tab) {
  const box = tab.spectralView.getSelected()
  tab.els.spectralDelete.disabled = !box
  tab.els.spectralReduction.disabled = !box
  tab.els.spectralClear.disabled = tab.spectralView.getRegions().length === 0
  const index = tab.spectralView.getSelectedIndex()
  const useNoise = tab.els.spectralUseNoise
  useNoise.disabled = !noiseBandFromShape(box)
  useNoise.querySelector('span').textContent = box ? `Use shape ${index + 1} as noise sample` : 'Use shape as noise sample'
  if (!box) {
    const count = tab.spectralView.getRegions().length
    tab.els.spectralSelection.textContent = count ? `${count} box${count === 1 ? '' : 'es'}. Click one to change it.` : 'No box selected'
    return
  }
  tab.els.spectralSelection.textContent = `${box.startSec.toFixed(2)}–${box.endSec.toFixed(2)} s · ${formatHz(box.lowHz)}–${formatHz(box.highHz)}`
  tab.els.spectralReduction.value = String(box.reductionDb)
  tab.els.spectralReductionValue.textContent = `${box.reductionDb} dB`
}
