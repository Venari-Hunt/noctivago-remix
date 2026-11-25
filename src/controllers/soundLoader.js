import { DEFAULT_CROSSFADE_MS, NEUTRAL_FILTERS, defaultEqBands, defaultFluctuation, defaultScatter, defaultSchedule } from '../domain/mixSettings.js'

// Rebuild step 10 (SoundLoader): owns loading a sound into the editor, from the
// moment a sound is picked to the moment its waveform peaks arrive. The tab hands
// in callbacks (d); this module never reaches into the DOM or the tab. The tab
// keeps currentEntry, editingPresetId, the saved snapshot and the history stack
// and only receives them through callbacks.

const NEUTRAL_SPEED_PITCH = {
  speed: 1,
  pitchSemitones: 0,
  reversed: false,
  dopplerEnabled: false,
  dopplerClosestFraction: 0.5,
  dopplerIntensitySemitones: 5,
  dopplerReversed: false,
  dopplerSharpness: 0.5
}

const WAVEFORM_TIMEOUT_MS = 60000

// What a library entry looks like once every field a sound saved before that
// feature existed is defaulted. Pure: no DOM, no audio.
export function entryLoadState(entry) {
  // entry.filters.eq is undefined on any sound saved before the parametric EQ
  // existed - defaulted here so loading an old sound always resets the EQ editor
  // to flat defaults instead of keeping whatever the previous sound left on screen.
  const filters = { ...NEUTRAL_FILTERS, ...entry.filters, eq: entry.filters?.eq ?? defaultEqBands() }
  return {
    filters,
    // A/B Compare's "B" (last saved mix): a copy, never touched again this session.
    eqSnapshot: filters.eq.map((b) => ({ ...b })),
    crossfadeMs: entry.crossfadeSeconds != null ? Math.round(entry.crossfadeSeconds * 1000) : DEFAULT_CROSSFADE_MS,
    speedPitch: entry.speedPitch ?? { ...NEUTRAL_SPEED_PITCH },
    playMode: entry.playMode ?? 'loop',
    scatter: entry.scatter ?? defaultScatter(),
    schedule: entry.schedule ?? defaultSchedule(),
    fluctuation: entry.fluctuation ?? defaultFluctuation()
  }
}

// Rejects after ms with the given message. Returns { promise, clear }.
export function waveformTimeout(ms, setTimer = setTimeout, clearTimer = clearTimeout) {
  let timer
  const promise = new Promise((_, reject) => { timer = setTimer(() => reject(new Error('no answer after 60 s')), ms) })
  return { promise, clear: () => clearTimer(timer) }
}

// The status line under the waveform once the peaks fetch settled.
export function waveformStatusText(peaks, failure) {
  if (peaks) return ''
  return failure ? `Waveform failed to load: ${failure}` : 'Waveform preview unavailable for this file.'
}

export function createSoundLoader(d) {
  async function load(id) {
    d.beforeLoad()
    const entry = d.findEntry(id)
    if (!entry) return
    // Solo is scoped to whichever sound was previously open - un-solo it first
    // (targeting the old id) before switching the current entry.
    d.clearSolo()
    d.setCurrentEntry(entry)
    // Pins which preset this editing session's Save targets.
    const presetId = d.pinEditingPreset()
    d.disposePreview()
    d.showEditor(entry)

    const { filters, eqSnapshot, crossfadeMs, speedPitch, playMode, scatter, schedule, fluctuation } = entryLoadState(entry)
    d.setFilterSliders(filters)
    // Captured once from the just-loaded entry's own saved data (see eqSnapshot).
    d.setSavedEqSnapshot(eqSnapshot)
    d.resetEqCompare()
    d.setCrossfade(crossfadeMs)
    d.setSpeedPitchControls(speedPitch)
    d.updateSpeedPitchLabels(speedPitch)
    // Doppler is applied again below, after loopEditor.load() resets it.
    d.loopEditor().setDopplerEnabled(speedPitch.dopplerEnabled ?? false)
    d.setPlayModeControls(playMode)
    d.setScatterControls(scatter)
    d.setScheduleControls(schedule)
    d.setFluctuationControls(fluctuation)

    await d.startPreview({ entry, presetId, crossfadeMs, speedPitch, fluctuation })
    d.showReverseState()
    const duration = await d.previewSource().waitForMetadata()
    if (d.currentId() !== id) return // switched sounds while loading

    if (entry.durationSeconds == null) {
      await d.api.library.updateMeta(id, { durationSeconds: duration })
      entry.durationSeconds = duration
      if (entry.loopEnd == null) entry.loopEnd = duration
    }

    const loopStart = entry.loopStart
    const loopEnd = entry.loopEnd ?? duration
    const source = d.previewSource()
    source.setLoopPoints(loopStart, loopEnd)
    source.setFilters(d.previewFilters())
    source.setFluctuation(d.getFluctuation())
    source.scrubTo(loopStart)
    const loop = d.loopEditor()
    loop.load(duration, loopStart, loopEnd)
    d.closeMarkerPopover()
    d.setMarkers(d.loadMarkers(entry.id, duration))
    // load() resets the volume envelope and Doppler to neutral (a fresh sound
    // shouldn't inherit the previous one's), so they are re-applied after it.
    loop.setEnvelope(filters.volumeEnvelope?.enabled ?? false, filters.volumeEnvelope?.points)
    d.setSpectralRegions(filters.spectralRepairs ?? [])
    d.updateSpectralControls()
    d.syncNoiseBand()
    d.resetSpectrogramKey()
    d.syncSpectralView()
    // loadSound only sets the play-mode radios, never applyPlayModeControl(), so
    // the playMode-gated envelope visibility is set directly here.
    loop.setEnvelopeUiVisible(playMode === 'loop')
    loop.setDopplerEnabled(speedPitch.dopplerEnabled ?? false)
    loop.setDopplerClosestFraction(speedPitch.dopplerClosestFraction ?? 0.5)
    loop.setDopplerReversed(speedPitch.dopplerReversed ?? false)
    d.updateFadeVisual()
    d.updateLoopTimeInputs(loopStart, loopEnd)
    loop.setPlayhead(loopStart)
    d.updateStickyProgress(loopStart)
    d.resetSuggestLoop()

    // Fire-and-forget: a real ffmpeg round-trip, so it arrives well after
    // everything above rendered. Fixed reference frequencies (the defaults, not
    // this sound's customized bands) - see EqEditor's setBandEnergy.
    const bandFreqs = defaultEqBands().map((b) => b.freqHz)
    d.api.audio
      .getBandEnergy(id, { loopStart, loopEnd, freqs: bandFreqs })
      .then((energies) => {
        if (d.currentId() !== id || !energies) return
        d.setBandEnergy(bandFreqs, energies)
      })
      .catch((err) => console.error('Editor: band energy analysis failed', err))
    d.resetHistory(d.snapshotOf(loopStart, loopEnd, filters, crossfadeMs, speedPitch, playMode, scatter, schedule))
    d.updateUndoRedoButtonsUI()
    d.updateSaveButtonState()

    d.setWaveformStatus(d.hasPeaksCached(id) ? '' : 'Loading waveform…')
    // A failed fetch used to leave "Loading waveform…" up forever; say why instead.
    let peaks = null
    let failure = null
    // 60 s covers an hour-long file; past that the main process never answered.
    const timeout = waveformTimeout(WAVEFORM_TIMEOUT_MS)
    try {
      peaks = await Promise.race([d.getWaveformPeaks(id), timeout.promise]).finally(timeout.clear)
    } catch (err) {
      console.error('Editor: waveform load failed', err)
      failure = err?.message || String(err)
    }
    if (d.currentId() !== id) return
    loop.setPeaks(peaks)
    d.syncSeamView()
    d.setWaveformStatus(waveformStatusText(peaks, failure))
  }

  return { load }
}
