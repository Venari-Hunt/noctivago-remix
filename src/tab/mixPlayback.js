// Mix-panel play, volume and live spectrogram methods of the Remix tab. Each takes the tab.
import { PLAY_ICON_SVG, PAUSE_ICON_SVG, VOLUME_ICON_SVG, MUTE_ICON_SVG } from '../components/icons.js'
import { requestAnalyser, requestMixerStatus } from '../components/mixerBridge.js'
import { pushLevel, peakFromTimeDomain } from '../domain/levels.js'
import { drawLevelHistory } from '../components/levelHistory.js'

// --- Live spectrogram (Preset/Group only) ---
// A second, separate rAF loop from tickPreviewPlayhead (which only ever
// drives Sound mode) - there's no playhead/progress to show here, tab
// loop's only job is polling whichever real engine node is relevant right
// now and feeding it to that mode's own EqEditor controller (presetEq/
// groupEq).
export function startWholeMixSpectrumTicking(tab) {
  if (tab._wholeMixSpectrumRafId) return
  const tick = () => {
    tab.tickWholeMixSpectrum()
    tab._wholeMixSpectrumRafId = requestAnimationFrame(tick)
  }
  tab._wholeMixSpectrumRafId = requestAnimationFrame(tick)
}

export function stopWholeMixSpectrumTicking(tab) {
  if (tab._wholeMixSpectrumRafId) cancelAnimationFrame(tab._wholeMixSpectrumRafId)
  tab._wholeMixSpectrumRafId = null
  tab.presetEq?.clearSpectrum()
  tab.groupEq?.clearSpectrum()
}

// Cleared whenever the thing being looked at changes (a different preset
// or group selected) so the scrolling loudness strip doesn't show a few
// stale seconds from whatever was open before.
export function resetLevelHistory(tab, which) {
  if (which === 'preset') tab.presetLevelHistory.length = 0
  else if (which === 'group') tab.groupLevelHistory.length = 0
}

export function tickWholeMixSpectrum(tab) {
  tab.updateMixPlayPauseUI(requestMixerStatus())

  if (tab.mode === 'preset' && tab.selectedPresetId) {
    const node = requestAnalyser('whole-mix', tab.selectedPresetId, null)
    if (node) {
      tab.presetEq.tickSpectrum(node)
      if (!tab._presetTimeBuf || tab._presetTimeBuf.length !== node.fftSize) tab._presetTimeBuf = new Uint8Array(node.fftSize)
      node.getByteTimeDomainData(tab._presetTimeBuf)
      pushLevel(tab.presetLevelHistory, peakFromTimeDomain(tab._presetTimeBuf))
    } else {
      tab.presetEq.clearSpectrum()
      pushLevel(tab.presetLevelHistory, 0)
    }
    drawLevelHistory(tab.els.mixPresetWaveform, tab.presetLevelHistory)
  } else if (tab.mode === 'group' && tab.selectedPresetId && tab.selectedGroupId) {
    const node = requestAnalyser('group', tab.selectedPresetId, tab.selectedGroupId)
    if (node) {
      tab.groupEq.tickSpectrum(node)
      if (!tab._groupTimeBuf || tab._groupTimeBuf.length !== node.fftSize) tab._groupTimeBuf = new Uint8Array(node.fftSize)
      node.getByteTimeDomainData(tab._groupTimeBuf)
      pushLevel(tab.groupLevelHistory, peakFromTimeDomain(tab._groupTimeBuf))
    } else {
      tab.groupEq.clearSpectrum()
      pushLevel(tab.groupLevelHistory, 0)
    }
    drawLevelHistory(tab.els.mixGroupWaveform, tab.groupLevelHistory)
  }
}

// Reflects real Mixer state on the shared Play/Pause icon + Group mode's
// Solo button - polled once per tick (see tickWholeMixSpectrum) rather
// than pushed, since tab plugin has no direct reference into the
// Mixer's own state to subscribe to.
export function updateMixPlayPauseUI(tab, status) {
  const isActivePreset = Boolean(tab.selectedPresetId) && status.activePresetId === tab.selectedPresetId
  const soloed = tab.mode === 'group' && isActivePreset && status.soloedGroupId === tab.selectedGroupId
  // Group mode's Play plays only the picked group (owner, 2026-11-11), so
  // the whole preset playing there shows Play: pressing it solos the group.
  const playing = isActivePreset && status.isPlaying && (tab.mode !== 'group' || !tab.selectedGroupId || soloed)
  tab.updateMixVolumeUI(status)
  // Skip the DOM writes entirely when nothing actually changed since the
  // last tick (self-review v0.1.149) - tab runs every rAF frame for as
  // long as Preset/Group mode is open, and .innerHTML in particular tears
  // down and rebuilds the icon's SVG node every single call regardless of
  // whether play/pause/solo state flipped.
  const signature = JSON.stringify([tab.mode, tab.selectedPresetId, tab.selectedGroupId, playing, isActivePreset, soloed])
  if (signature === tab._mixPlayPauseSignature) return
  tab._mixPlayPauseSignature = signature

  tab.els.mixPlayPause.innerHTML = playing ? PAUSE_ICON_SVG : PLAY_ICON_SVG
  tab.els.mixPlayPause.title = playing ? 'Pause' : isActivePreset ? 'Play' : 'Load tab preset and play it in the Mixer'
  tab.els.mixPlayPause.disabled = !tab.selectedPresetId

  if (tab.mode === 'group' && tab.selectedGroupId) tab.els.mixPlayPause.title = playing ? 'Pause' : 'Play tab group only'
  // Play is the solo now, so the separate Solo button stays hidden.
  tab.els.mixSoloGroup.classList.add('hidden')
  // The preview module is built after els are looked up (arrangeBar), so
  // the note is found here.
  const note = tab.root?.querySelector('#rx-pnote')
  if (note) note.hidden = !(tab.mode === 'group' && playing && soloed)
}

// The Group/Preset player's volume row is the app's master volume (those
// modes play through the Mixer). Polled with the status like Play/Pause; an
// app without the remix-set-volume bridge reports no volumePosition, and
// the row stays hidden.
export function updateMixVolumeUI(tab, status) {
  const supported = Number.isFinite(status.volumePosition)
  tab.root?.classList.toggle('rx-mixvol-on', supported)
  if (!supported) return
  const doc = tab.els.mixVolume.ownerDocument
  if (doc.activeElement !== tab.els.mixVolume || !tab.els.mixVolume.matches(':active')) {
    const value = String(Math.round(status.volumePosition * 1000))
    if (tab.els.mixVolume.value !== value) tab.els.mixVolume.value = value
  }
  tab.els.mixVolume.style.setProperty('--p', `${(Number(tab.els.mixVolume.value) / 10).toFixed(1)}%`)
  const muted = Boolean(status.muted)
  if (tab._mixMuted !== muted) {
    tab._mixMuted = muted
    tab.els.mixMute.innerHTML = muted ? MUTE_ICON_SVG : VOLUME_ICON_SVG
    tab.els.mixMute.title = muted ? 'Unmute' : 'Mute'
    tab.els.mixMute.setAttribute('aria-label', tab.els.mixMute.title)
  }
}

// Play button (v0.1.148) - reported directly ("where's the play button
// for the preset and group?"): Preset/Group mode previously only ever
// previewed live if that preset already happened to be playing in the
// Mixer, with no way to actually start it from Remix itself. Loading a
// preset (tabs/mixer/index.js's loadPreset) already unconditionally plays
// every sound in it, so "not yet the active preset" and "toggle the
// shared mix's play/pause" are the only two cases tab needs.
export function onMixPlayPauseClick(tab) {
  if (!tab.selectedPresetId) return
  const status = requestMixerStatus()
  if (tab.mode === 'group' && tab.selectedGroupId) {
    tab.playGroupOnly(status)
    return
  }
  // Preset mode plays the whole preset: a group soloed from Group mode is
  // released first.
  if (status.activePresetId === tab.selectedPresetId && status.soloedGroupId) {
    window.dispatchEvent(new CustomEvent('noctivago:remix-unsolo-group', {}))
    if (!status.isPlaying) window.dispatchEvent(new CustomEvent('noctivago:remix-toggle-playback', {}))
    return
  }
  if (status.activePresetId !== tab.selectedPresetId) {
    window.dispatchEvent(new CustomEvent('noctivago:remix-load-preset', { detail: { presetId: tab.selectedPresetId } }))
  } else {
    window.dispatchEvent(new CustomEvent('noctivago:remix-toggle-playback', {}))
  }
}

// Group mode's Play (owner, 2026-11-11): plays only the picked group, with
// "Playing tab group only" on the player. Loads the preset if needed (with
// the solo applied once it lands), solos the group if another is heard,
// and otherwise toggles play/pause.
export function playGroupOnly(tab, status) {
  const presetId = tab.selectedPresetId
  const groupId = tab.selectedGroupId
  if (status.activePresetId !== presetId) {
    window.dispatchEvent(new CustomEvent('noctivago:remix-load-preset', { detail: { presetId, soloGroupId: groupId } }))
    return
  }
  if (status.soloedGroupId !== groupId) {
    window.dispatchEvent(new CustomEvent('noctivago:remix-solo-group', { detail: { presetId, groupId } }))
    if (!status.isPlaying) window.dispatchEvent(new CustomEvent('noctivago:remix-toggle-playback', {}))
    return
  }
  window.dispatchEvent(new CustomEvent('noctivago:remix-toggle-playback', {}))
}

// Group mode's own "hear just tab group" button - mutes every other
// currently-playing sound in the Mixer, same idea as Sound mode's Solo
// button (src/renderer/tabs/mixer/index.js's applyGroupSolo). Loads the
// preset first if it isn't already playing, same as plain Play, since
// soloing implies wanting to actually hear it.
export function onMixSoloGroupClick(tab) {
  if (!tab.selectedPresetId || !tab.selectedGroupId) return
  const status = requestMixerStatus()
  const alreadySoloed = status.activePresetId === tab.selectedPresetId && status.soloedGroupId === tab.selectedGroupId
  if (alreadySoloed) {
    window.dispatchEvent(new CustomEvent('noctivago:remix-unsolo-group', {}))
    return
  }
  if (status.activePresetId !== tab.selectedPresetId) {
    window.dispatchEvent(new CustomEvent('noctivago:remix-load-preset', { detail: { presetId: tab.selectedPresetId, soloGroupId: tab.selectedGroupId } }))
  } else {
    window.dispatchEvent(new CustomEvent('noctivago:remix-solo-group', { detail: { presetId: tab.selectedPresetId, groupId: tab.selectedGroupId } }))
  }
}
