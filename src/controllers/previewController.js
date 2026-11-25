// Rebuild step 10 (PreviewController): owns the two preview engines of the open
// sound, 'live' (PreviewSource, the editable Web Audio chain) and 'saved'
// (BakedClipPreview, the baked clip file): start, dispose, and the saved-audio
// hand-off around a re-bake. The tab hands in callbacks (d); this module never
// reaches into the DOM. previewMode and the playhead ticking stay on the tab.
export function createPreviewController(d) {
  let source = null
  let baked = null

  // Starts both engines for a sound. The saved one is built unconditionally (a
  // plain <audio> pointed at the clip URL), even if no bake exists yet.
  async function start({ soundId, presetId, volume, sourceOptions, onEnded, onReverseStateChange }) {
    await d.engine.resume()
    source = new d.PreviewSource(d.engine, { soundId, volume, ...sourceOptions })
    d.setLiveMode()
    baked = new d.BakedClipPreview(d.engine, soundId, volume, presetId)
    source.onEnded = onEnded
    source.onReverseStateChange = onReverseStateChange
    return source
  }

  function disposeBaked() {
    if (!baked) return
    baked.dispose()
    baked = null
  }

  // Returns false when no live engine existed (nothing more to tear down).
  function disposeSource() {
    if (!source) return false
    source.dispose()
    source = null
    return true
  }

  // The sound:// handler keeps a loaded <audio> file open and Windows refuses to
  // rename the fresh render over it (v0.1.214), so release it before a re-bake.
  // Returns where to resume.
  function releaseBakedForRebake() {
    if (!baked) return null
    const resume = { time: baked.currentTime || 0, playing: d.getPreviewMode() === 'saved' && baked.playing }
    if (resume.playing) {
      d.stopTicking()
      d.setPlayPauseIcon(false)
    }
    d.setClipRebaking(true)
    baked.dispose()
    baked = null
    return resume
  }

  // Recreate the saved engine after the bake so its <audio> re-fetches the
  // rewritten clip, carrying position and play state across the swap.
  function restoreBakedAfterRebake({ resume, ok, id, presetId, stillEditing }) {
    if (resume) d.setClipRebaking(false)
    if (!stillEditing) return
    const resumingSaved = d.getPreviewMode() === 'saved' && ok
    const resumeTime = resumingSaved ? resume?.time ?? baked?.currentTime ?? 0 : 0
    const resumePlaying = resumingSaved && (resume ? resume.playing : Boolean(baked?.playing))
    baked?.dispose()
    baked = new d.BakedClipPreview(d.engine, id, d.getVolume(), presetId)
    if (resumingSaved) {
      baked.scrubTo(resumeTime)
      if (resumePlaying) {
        d.engine
          .resume()
          .then(() => baked?.play())
          .then(() => {
            d.setPlayPauseIcon(true)
            d.tickPlayhead()
          })
          .catch((err) => console.error('Editor: failed to resume saved-audio preview after re-bake', err))
      }
    }
    d.updateSaveButtonState()
  }

  return {
    start, disposeBaked, disposeSource, releaseBakedForRebake, restoreBakedAfterRebake,
    get source() { return source },
    get baked() { return baked }
  }
}
